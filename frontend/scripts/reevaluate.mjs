// Re-evaluate one CircuitWill decision from the command line, with the same code the dashboard uses (lib/reeval.js).
// Read-only: it reads the receipt and calls view functions. Exit code 0 if every check passed, 1 otherwise.
//   node scripts/reevaluate.mjs <txHash> [rpcUrl]          (rpcUrl defaults to https://rpc.xlayer.tech)
import { ethers } from '../vendor/ethers-6.13.4.min.js';
import { loadDecisionFromTx, reEvaluate } from '../lib/reeval.js';
import { STATUS_NAME, REASON_NAME, KIND_LABEL } from '../lib/meta.js';

const [txHash, rpc = 'https://rpc.xlayer.tech'] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{64}$/.test(txHash ?? '')) {
  console.error('usage: node scripts/reevaluate.mjs <txHash> [rpcUrl]');
  process.exit(2);
}
const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
const rec = await loadDecisionFromTx(provider, txHash);
const d = rec.decision;
console.log(`escrow ${d.escrow}, decision #${d.decisionId}: ${d.allowed ? 'ALLOWED' : 'BLOCKED'} (${REASON_NAME[d.reason]}), final`);
for (const c of rec.circuits) console.log(`  #${c.index} ${KIND_LABEL[c.kind]}: ${STATUS_NAME[c.status]}  input ${c.input} -> ${c.output}`);
const res = await reEvaluate(provider, rec);
for (const c of res.checks) console.log(`${c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : 'n/a '} ${c.label}${c.detail ? `  [${c.detail}]` : ''}`);
console.log(res.ok ? 'Re-evaluation matches the record.' : 'Re-evaluation found a mismatch.');
process.exit(res.ok ? 0 : 1);
