import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packFacts, compileRule } from '../lib/rule-compiler.js';
import { decodeCircuitInput } from '../lib/units.js';
import { bytesToHex, pinMap } from '../lib/xray.js';
import { packFor, simulate } from '../lib/preview.js';
import { KIND, STATUS, REASON } from '../lib/meta.js';
import { EXAMPLES } from '../../circuits/custom/examples.mjs';

const facts = { amount_c: 1000n, spent_day_after_c: 1000n, spent_7d_after_c: 1000n, spent_month_after_c: 1000n, balance_after_c: 5000n, count_day_after: 1n, slot_of_week_utc: 100n, caller_role: 1n, payee_trusted: true };

test('History decodes a recorded custom-rule input (kind 5) into its facts', () => {
  const f = decodeCircuitInput(KIND.CUSTOM, bytesToHex(packFacts(facts)));
  assert.equal(f.amount_c, 1000n);
  assert.equal(f.slot_of_week_utc, 100n);
  assert.equal(f.caller_role, 1n);
  assert.equal(f.payee_trusted, true);
  assert.equal(decodeCircuitInput(KIND.CUSTOM, '0x00'), null, 'wrong length');
});

test('the X-ray finds every custom-rule pin from the decoder', () => {
  const pins = pinMap(KIND.CUSTOM, 32, 256);
  assert.deepEqual(pins[0], { key: 'amount_c', bit: 0 });
  assert.deepEqual(pins[213], { key: 'caller_role', bit: 0 });
  assert.ok(pins[255].unknown, 'reserved pins stay unknown');
});

test('the preview evaluates a custom rule on the facts the escrow reports', () => {
  const c = compileRule(EXAMPLES.son);
  const input = packFacts({ ...facts, slot_of_week_utc: 4n }); // Monday 01:00 UTC = 02:00 in Lagos: allowed
  assert.equal(packFor(KIND.CUSTOM, { customInput: input }), input);
  assert.equal(packFor(KIND.CUSTOM, {}), null, 'no facts: not evaluated (blocks, like the escrow)');
  const circuits = [{ kind: KIND.CUSTOM, netlistHash: null }];
  const netlists = [{ gates: c.gates, nIn: 256, nOut: 1 }];
  const ctx = { amount: 10_000_000n, spentBefore: 0n, customInput: input };
  assert.equal(simulate({ circuits, netlists, ctx, balance: 100_000_000n }).results[0].status, STATUS.ALLOW);
  const late = packFacts({ ...facts, slot_of_week_utc: 84n }); // Monday 21:00 UTC = 22:00 in Lagos: blocked
  assert.equal(simulate({ circuits, netlists, ctx: { ...ctx, customInput: late }, balance: 100_000_000n }).results[0].status, STATUS.DENY);
  // With nothing attached at all, a beneficiary is blocked like everyone else (NO_CIRCUITS comes first, as on chain).
  const sim = simulate({ circuits: [], netlists: [], ctx: { ...ctx, isBeneficiary: true }, balance: 100_000_000n });
  assert.equal(sim.reason, REASON.NO_CIRCUITS);
});
