// Circuit X-ray: the in-browser evaluator must agree with the reference simulator (circuits/lib/tap02.mjs) on the real
// circuits, the field map must come from decodeCircuitInput, and the layout must place every gate sensibly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeNandNetlist, evalPacked } from '../../circuits/lib/tap02.mjs';
import { buildDailyCap, packDailyCapInputs } from '../../circuits/daily-cap/build.mjs';
import { buildPayeeWhitelist, packPayeeWhitelistInputs } from '../../circuits/payee-whitelist/build.mjs';
import { buildConfirmation, packConfirmationInputs } from '../../circuits/confirmation/build.mjs';
import { buildFreeze, packFreezeInputs } from '../../circuits/freeze/build.mjs';
import {
  decodeNetlist,
  evaluate,
  outputBits,
  packBits,
  pinMap,
  buildXray,
  renderXraySvg,
  xrayHtml,
  captionFor,
  bytesToHex,
  hexToBytes,
} from '../lib/xray.js';

const U = 1_000_000n; // 1 USDT0 in base units

// Deterministic pseudo-random bytes (no Math.random, so failures reproduce).
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) >>> 24);
}

const CIRCUITS = [
  { kind: 1, built: buildDailyCap(), bytes: 12, gates: 447 },
  { kind: 2, built: buildPayeeWhitelist(), bytes: 13, gates: 237 },
  { kind: 3, built: buildConfirmation(), bytes: 9, gates: 160 },
  { kind: 4, built: buildFreeze(), bytes: 1, gates: 1 },
];

test('decodeNetlist reads the same gates as the reference decoder', () => {
  for (const c of CIRCUITS) {
    assert.deepEqual(decodeNetlist(c.built.netlist), decodeNandNetlist(c.built.netlist));
    assert.deepEqual(decodeNetlist(bytesToHex(c.built.netlist)), c.built.gates, 'accepts 0x-hex too');
    assert.equal(c.built.gateCount, c.gates);
  }
});

test('evaluate agrees with tap02.evalPacked on random inputs for all four circuits', () => {
  const next = rng(196);
  for (const c of CIRCUITS) {
    const gates = decodeNetlist(c.built.netlist);
    for (let n = 0; n < 300; n++) {
      const input = Uint8Array.from({ length: c.bytes }, next);
      const sig = evaluate(gates, c.built.nIn, input);
      const ours = packBits(outputBits(sig, c.built.nOut));
      assert.deepEqual(ours, evalPacked(gates, c.built.nIn, c.built.nOut, input), `kind ${c.kind} input ${bytesToHex(input)}`);
    }
  }
});

test('evaluate rejects netlists that read later signals, and decodeNetlist rejects non-NAND elements', () => {
  assert.throws(() => evaluate([[0, 3]], 1, [0]), /later signal/);
  assert.throws(() => decodeNetlist('0x01000000000000'), /unsupported element/);
  assert.throws(() => decodeNetlist('0x000000'), /multiple of 7/);
  assert.equal(evaluate([[2, 2]], 1, new Uint8Array())[3], 1, 'missing input bytes read as 0');
});

test('pinMap derives the field boundaries from decodeCircuitInput and matches each circuit pinout', () => {
  const ranges = (pins) => {
    const out = {};
    pins.forEach((p, i) => {
      const r = (out[p.key] ??= [i, i]);
      r[1] = i;
      assert.equal(p.bit, i - out[p.key][0], `${p.key}: pin ${i} is bit ${i - out[p.key][0]}`);
    });
    return out;
  };
  assert.deepEqual(ranges(pinMap(1, 12, 96)), { amount: [0, 31], spentToday: [32, 63], dailyCap: [64, 95] });
  assert.deepEqual(ranges(pinMap(2, 13, 97)), { isSaved: [0, 0], ageHours: [1, 16], amount: [17, 48], trialLimit: [49, 80], coolingOffHours: [81, 96] });
  assert.deepEqual(ranges(pinMap(3, 9, 65)), { amount: [0, 31], threshold: [32, 63], confirmed: [64, 64] });
  assert.deepEqual(ranges(pinMap(4, 1, 1)), { frozen: [0, 0] });
  // Same boundaries as the circuit build scripts.
  assert.deepEqual(CIRCUITS[0].built.pins, { amount: [0, 31], spent_today: [32, 63], daily_cap: [64, 95] });
  // Unknown circuit: every pin is a plain numbered input.
  assert.ok(pinMap(9, 2, 16).every((p, i) => p.unknown && p.key === 'input' && p.bit === i));
});

function dailyCapX(amount, spent, cap) {
  const c = CIRCUITS[0].built;
  const input = packDailyCapInputs(amount, spent, cap);
  const recorded = evalPacked(c.gates, c.nIn, c.nOut, input);
  return buildXray({ gates: decodeNetlist(c.netlist), nIn: c.nIn, input: bytesToHex(input), kind: 1, recordedOutput: bytesToHex(recorded) });
}

test('buildXray: Daily Cap allowed and blocked match the recorded output, and fields read back from the bits', () => {
  const ok = dailyCapX(10n * U, 30n * U, 50n * U);
  assert.equal(ok.output, 1);
  assert.equal(ok.matches, true);
  assert.equal(ok.outputHex, '0x01');
  assert.deepEqual(
    ok.fields.map((f) => [f.key, f.value, f.text, f.width]),
    [
      ['amount', 10n * U, '10 USDT0', 32],
      ['spentToday', 30n * U, '30 USDT0', 32],
      ['dailyCap', 50n * U, '50 USDT0', 32],
    ],
  );
  const no = dailyCapX(60n * U, 10n * U, 50n * U);
  assert.equal(no.output, 0);
  assert.equal(no.matches, true);
  assert.match(captionFor(no), /does not fit, so the output bit is 0: blocked/);
  assert.match(captionFor(ok), /\(40\)\. It fits, so the output bit is 1: allowed/);
});

test('buildXray reports a mismatch when the recorded output differs', () => {
  const c = CIRCUITS[3].built;
  const m = buildXray({ gates: c.gates, nIn: 1, input: packFreezeInputs(false), kind: 4, recordedOutput: '0x00' });
  assert.equal(m.output, 1);
  assert.equal(m.matches, false);
  assert.match(xrayHtml(m), /Mismatch\./);
  assert.match(xrayHtml(m, { netlistOk: false }), /Circuit changed\./);
  assert.doesNotMatch(xrayHtml({ ...m, matches: true }, { netlistOk: true }), /Mismatch|Circuit changed/);
  assert.equal(buildXray({ gates: c.gates, nIn: 1, input: '0x01', kind: 4 }).matches, null, 'nothing recorded, nothing compared');
});

test('layout: Daily Cap is an adder, then a comparator, then the output gate, one bit per row', () => {
  const m = dailyCapX(1n, 2n, 3n);
  const L = m.layout;
  assert.equal(L.rows, 32);
  assert.deepEqual(L.lanes.map((l) => [l.name, l.gateCount]), [['Add', 285], ['Compare', 161], ['Result', 1]]);
  assert.deepEqual(L.lanes.map((l) => l.pinKeys), [['amount', 'spentToday'], ['dailyCap'], []]);
  // Every gate has finite coordinates inside the drawing; the output gate is the right-most gate.
  const xs = L.gates.map((g) => g.cx);
  for (const g of L.gates) {
    assert.ok(Number.isFinite(g.x) && Number.isFinite(g.y) && g.x > 0 && g.y > 0 && g.x < L.width && g.y < L.height);
  }
  assert.equal(Math.max(...xs), L.gates[446].cx);
  assert.equal(L.gates[446].row, 31);
  // Inputs sit left of every gate that reads them, and lanes only read from lanes to their left.
  m.gates.forEach(([a, b], g) => {
    for (const s of [a, b]) {
      if (s >= 2 && s < 98) assert.ok(L.pins[s - 2].x < L.gates[g].x, `pin ${s - 2} left of gate ${g}`);
    }
  });
  const laneRank = new Map(L.lanes.map((l, i) => [l.index, i]));
  for (const l of L.lanes) for (const d of l.deps) assert.ok(laneRank.get(d) < laneRank.get(l.index));
  // The carry chain lights row by row: depth grows with the bit position.
  assert.ok(L.maxDepth > 60 && L.maxDepth < 140, `depth ${L.maxDepth}`);
  // Bit rows hold at most two stacked gates (the last row also holds the final carry check), so 447 gates stay compact.
  const rowsH = L.rowTop.slice(1).map((y, r) => y - L.rowTop[r]);
  assert.ok(Math.max(...rowsH.slice(0, -1)) <= 2 * 12 + 5 && rowsH.at(-1) <= 3 * 12 + 5, rowsH.join(","));
});

test('layout: Whitelist, Confirmation and Freeze lanes', () => {
  const wl = CIRCUITS[1].built;
  const w = buildXray({ gates: wl.gates, nIn: 97, input: packPayeeWhitelistInputs(false, 30, 4n * U, 5n * U, 24), kind: 2 });
  assert.equal(w.output, 1);
  assert.match(captionFor(w), /skips both. This recipient is not trusted, so the output bit is 1: allowed./);
  assert.deepEqual(w.layout.lanes.map((l) => [l.name, l.gateCount]), [['Amount ≤ limit?', 157], ['Waited?', 77], ['Both?', 1], ['Result', 2]]);
  const cf = CIRCUITS[2].built;
  const c = buildXray({ gates: cf.gates, nIn: 65, input: packConfirmationInputs(25n * U, 20n * U, false), kind: 3 });
  assert.equal(c.output, 0);
  assert.deepEqual(c.layout.lanes.map((l) => [l.name, l.gateCount]), [['Amount ≤ limit?', 158], ['Result', 2]]);
  const fz = buildXray({ gates: CIRCUITS[3].built.gates, nIn: 1, input: packFreezeInputs(true), kind: 4 });
  assert.equal(fz.output, 0);
  assert.equal(fz.layout.rows, 1);
  assert.deepEqual(fz.layout.lanes.map((l) => [l.name, l.pinKeys]), [['Result', ['frozen']]]);
  assert.match(captionFor(fz), /switch is on \(frozen\), so the output bit is 0: blocked/);
});

test('renderXraySvg: one shape per gate, lit exactly where the signal is 1, no NaN', () => {
  const m = dailyCapX(12_500_000n, 30n * U, 50n * U);
  const svg = renderXraySvg(m);
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
  const gates = [...svg.matchAll(/<path class="g( on)?" data-g="(\d+)"/g)];
  assert.equal(gates.length, 447);
  for (const [, on, g] of gates) assert.equal(!!on, m.sig[98 + Number(g)] === 1, `gate ${g}`);
  const pins = [...svg.matchAll(/<circle class="p( on)?" data-p="(\d+)"/g)];
  assert.equal(pins.length, 96);
  for (const [, on, i] of pins) assert.equal(!!on, m.sig[2 + Number(i)] === 1);
  // Two wires into every gate (from a signal or a tied constant).
  const wires = (svg.match(/data-d="/g) ?? []).length;
  const consts = (svg.match(/<g class="xr-const">[\s\S]*?<\/g>/)?.[0].match(/<text/g) ?? []).length;
  assert.equal(wires + consts, 2 * 447);
  assert.match(svg, /class="xr-out on"/);
  assert.deepEqual(hexToBytes('0x0aff'), Uint8Array.from([10, 255]));
});

test('xrayHtml escapes labels and says what the shapes mean', () => {
  const m = dailyCapX(1n, 1n, 1n);
  const html = xrayHtml(m, { ruleName: '<b>x</b>', ruleClass: 'k1' });
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /Each shape is a NAND gate/);
  assert.match(html, /447 NAND gates in [0-9]+ steps/);
  assert.match(xrayHtml(buildXray({ gates: [[2, 2]], nIn: 1, input: '0x00', kind: 4 })), /1 NAND gate in 1 step:/);
});
