// Independent re-evaluation of a recorded CircuitWill decision (README "To re-evaluate a decision").
//
// Read-only: it only reads the transaction receipt and calls view functions (TapeOut eval / netlist / circuitInfo and
// the escrow's decisionRecordHash). It cannot change anything, and its result is informational: the decision recorded
// on-chain is final. Works in the browser and in Node (scripts/reevaluate.mjs).
import { ethers } from '../vendor/ethers-6.13.4.min.js';
import { ESCROW_ABI } from '../artifacts.js';
import { STATUS, STATUS_NAME, REASON, REASON_NAME, KIND_LABEL, reasonFromStatuses } from './meta.js';
import { decodeCircuitInput } from './units.js';

const PROCESSOR_ABI = [
  'function eval(uint256 id, bytes inputs) view returns (bytes)',
  'function netlist(uint256 id) view returns (bytes)',
  'function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)',
];

export const escrowInterface = new ethers.Interface(ESCROW_ABI);
const coder = ethers.AbiCoder.defaultAbiCoder();
const DECISION_TOPIC = escrowInterface.getEvent('Decision').topicHash;

let simulatorPromise;
/// The reference NAND simulator from circuits/lib. Optional: if it cannot be loaded (for example a bundle that ships
/// only frontend/), the offline check is reported as unavailable.
function loadSimulator() {
  simulatorPromise ??= import('../../circuits/lib/tap02.mjs').catch(() => null);
  return simulatorPromise;
}

/// Parses one escrow decision from a transaction receipt. `escrow` and `decisionId` are optional filters; without
/// them the transaction must contain exactly one Decision event.
export async function loadDecisionFromTx(provider, txHash, { escrow, decisionId } = {}) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`No receipt for ${txHash} on this network`);
  const decisionLogs = receipt.logs.filter(
    (l) =>
      l.topics[0] === DECISION_TOPIC &&
      (!escrow || l.address.toLowerCase() === escrow.toLowerCase()) &&
      (decisionId === undefined || BigInt(l.topics[1]) === BigInt(decisionId)),
  );
  if (decisionLogs.length !== 1) {
    throw new Error(`Expected one CircuitWill Decision event in ${txHash}, found ${decisionLogs.length}`);
  }
  const dLog = decisionLogs[0];
  const d = escrowInterface.parseLog(dLog).args;
  const decision = {
    escrow: ethers.getAddress(dLog.address),
    txHash,
    blockNumber: receipt.blockNumber,
    decisionId: d.decisionId,
    action: Number(d.action),
    allowed: d.allowed,
    proposer: d.proposer,
    to: d.to,
    amount: d.amount,
    day: d.day,
    spentTodayBefore: d.spentTodayBefore,
    spentTodayAfter: d.spentTodayAfter,
    reason: Number(d.reason),
    memo: d.memo,
    recordHash: d.recordHash,
  };
  const circuits = [];
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== dLog.address.toLowerCase()) continue;
    let p;
    try {
      p = escrowInterface.parseLog(l);
    } catch {
      continue;
    }
    if (p?.name !== 'CircuitEvaluated' || p.args.decisionId !== decision.decisionId) continue;
    circuits.push({
      index: Number(p.args.index),
      kind: Number(p.args.kind),
      processor: p.args.processor,
      circuitId: p.args.circuitId,
      netlistHash: p.args.netlistHash,
      input: p.args.input,
      status: Number(p.args.status),
      output: p.args.output,
    });
  }
  circuits.sort((a, b) => a.index - b.index);
  return { decision, circuits };
}

/// circuitsHash and recordHash exactly as CircuitWillEscrow._recordHash computes them.
export function computeRecordHash(chainId, decision, circuits) {
  let circuitsHash = ethers.ZeroHash;
  for (const c of circuits) {
    circuitsHash = ethers.keccak256(
      coder.encode(
        ['bytes32', 'uint8', 'address', 'uint256', 'bytes32', 'bytes32', 'uint8', 'bytes32'],
        [circuitsHash, c.kind, c.processor, c.circuitId, c.netlistHash, ethers.keccak256(c.input), c.status, ethers.keccak256(c.output)],
      ),
    );
  }
  const recordHash = ethers.keccak256(
    coder.encode(
      ['address', 'uint256', 'uint256', 'uint8', 'address', 'address', 'uint256', 'uint32', 'uint256', 'bool', 'uint8', 'bytes32', 'bytes32'],
      [
        decision.escrow,
        chainId,
        decision.decisionId,
        decision.action,
        decision.proposer,
        decision.to,
        decision.amount,
        decision.day,
        decision.spentTodayBefore,
        decision.allowed,
        decision.reason,
        ethers.keccak256(ethers.toUtf8Bytes(decision.memo)),
        circuitsHash,
      ],
    ),
  );
  return { circuitsHash, recordHash };
}

/// Re-runs every recorded circuit and checks the record. Returns { ok, checks, circuits, hashes }.
/// `ok` is true only if every check that could be run passed.
export async function reEvaluate(provider, { decision, circuits }) {
  const checks = [];
  const check = (label, ok, detail = '') => checks.push({ label, ok, detail });
  const { chainId } = await provider.getNetwork();
  const sim = await loadSimulator();

  // Completeness: indices 0..n-1, in order.
  check(
    'CircuitEvaluated events are complete (index 0..n-1)',
    circuits.every((c, i) => c.index === i),
    `${circuits.length} circuit(s)`,
  );

  const results = [];
  for (const c of circuits) {
    const label = `#${c.index} ${KIND_LABEL[c.kind] ?? `kind ${c.kind}`}`;
    const r = { ...c, fields: decodeCircuitInput(c.kind, c.input), evalNow: null, simOutput: null, netlistOk: null };
    const proc = new ethers.Contract(c.processor, PROCESSOR_ABI, provider);

    // Step 4: the circuit is the one that was attached.
    let netlist = null;
    try {
      netlist = await proc.netlist(c.circuitId);
      r.netlistOk = ethers.keccak256(netlist) === c.netlistHash;
      check(`${label}: keccak256(netlist) equals the recorded netlistHash`, r.netlistOk, c.netlistHash);
    } catch (e) {
      check(`${label}: netlist(${c.circuitId}) readable`, false, shortError(e));
    }

    // Step 3: re-run eval on the recorded input.
    if (c.status === STATUS.ALLOW || c.status === STATUS.DENY) {
      const bit = parseInt(c.output.slice(2, 4) || '00', 16) & 1;
      check(`${label}: recorded output bit 0 matches status ${STATUS_NAME[c.status]}`, (bit === 1) === (c.status === STATUS.ALLOW), c.output);
      try {
        r.evalNow = await proc.eval(c.circuitId, c.input);
        check(`${label}: TapeOut eval(${c.circuitId}, input) returns the recorded output`, r.evalNow === c.output, `now ${r.evalNow}`);
      } catch (e) {
        check(`${label}: TapeOut eval(${c.circuitId}, input)`, false, shortError(e));
      }
      // Offline: simulate the fetched netlist with the reference simulator.
      if (sim && netlist) {
        try {
          const info = await proc.circuitInfo(c.circuitId);
          const gates = sim.decodeNandNetlist(ethers.getBytes(netlist));
          const out = sim.evalPacked(gates, Number(info.nIn), Number(info.nOut), ethers.getBytes(c.input));
          r.simOutput = ethers.hexlify(out);
          check(`${label}: offline NAND simulation (circuits/lib/tap02.mjs) gives the recorded output`, r.simOutput === c.output, `sim ${r.simOutput}`);
        } catch (e) {
          check(`${label}: offline NAND simulation`, false, shortError(e));
        }
      } else if (!sim) {
        check(`${label}: offline NAND simulation`, null, 'simulator not available in this bundle');
      }
    } else if (c.status === STATUS.NOT_EVALUATED) {
      check(`${label}: NOT_EVALUATED has an empty input (inputs were out of range)`, c.input === '0x', 'eval was not called');
    } else {
      // REVERTED / MALFORMED_OUTPUT: the failure cannot be replayed exactly (gas, processor state). Informational.
      try {
        r.evalNow = await proc.eval(c.circuitId, c.input);
      } catch {
        r.evalNow = 'reverts';
      }
      check(`${label}: recorded ${STATUS_NAME[c.status]} (fail-closed, blocks)`, null, `eval now: ${r.evalNow}`);
    }

    // Step 5: the inputs match the decision summary.
    if (r.fields) {
      if ('amount' in r.fields) check(`${label}: packed amount equals Decision.amount`, r.fields.amount === decision.amount, `${r.fields.amount}`);
      if ('spentToday' in r.fields) {
        check(`${label}: packed spent_today equals Decision.spentTodayBefore`, r.fields.spentToday === decision.spentTodayBefore, `${r.fields.spentToday}`);
      }
    } else if (c.input !== '0x') {
      check(`${label}: input length matches the pinout`, false, c.input);
    }
    results.push(r);
  }

  // Outcome consistency: the summary follows from the circuit statuses.
  const fromCircuits = reasonFromStatuses(circuits.map((c) => c.status));
  const reasonOk =
    fromCircuits === REASON.NONE
      ? [REASON.NONE, REASON.INSUFFICIENT_BALANCE, REASON.TRANSFER_FAILED].includes(decision.reason)
      : decision.reason === fromCircuits;
  check('Decision.reason follows from the circuit statuses', reasonOk, `${REASON_NAME[decision.reason]} (circuits imply ${REASON_NAME[fromCircuits]})`);
  check('Decision.allowed is true only when reason is NONE', decision.allowed === (decision.reason === REASON.NONE), `allowed=${decision.allowed}`);
  const expectedAfter = decision.allowed ? decision.spentTodayBefore + decision.amount : decision.spentTodayBefore;
  check('spentTodayAfter = spentTodayBefore (+ amount if allowed)', decision.spentTodayAfter === expectedAfter, `${decision.spentTodayAfter}`);

  // Step 6: recompute the on-chain commitment.
  const hashes = computeRecordHash(chainId, decision, circuits);
  check('Recomputed recordHash equals the Decision event', hashes.recordHash === decision.recordHash, hashes.recordHash);
  try {
    const escrow = new ethers.Contract(decision.escrow, ESCROW_ABI, provider);
    hashes.stored = await escrow.decisionRecordHash(decision.decisionId);
    check('Recomputed recordHash equals decisionRecordHash(decisionId) on the escrow', hashes.recordHash === hashes.stored, hashes.stored);
  } catch (e) {
    check('decisionRecordHash(decisionId) readable', false, shortError(e));
  }

  return { ok: checks.every((c) => c.ok !== false), checks, circuits: results, hashes, chainId };
}

function shortError(e) {
  return e?.shortMessage || e?.reason || e?.message || String(e);
}
