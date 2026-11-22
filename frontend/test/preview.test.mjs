// Payment preview: the packing must match the escrow's packing libraries and the README pinouts bit for bit, the time
// rules must match CircuitWillEscrow (UTC day rollover, whole hours of payee age), and simulate() must give the
// circuits' answers on the real netlists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyCap, packDailyCapInputs } from '../../circuits/daily-cap/build.mjs';
import { buildPayeeWhitelist, packPayeeWhitelistInputs } from '../../circuits/payee-whitelist/build.mjs';
import { buildConfirmation, packConfirmationInputs } from '../../circuits/confirmation/build.mjs';
import { buildFreeze, packFreezeInputs } from '../../circuits/freeze/build.mjs';
import { decodeCircuitInput } from '../lib/units.js';
import { STATUS, KIND, REASON } from '../lib/meta.js';
import {
  dayOf,
  spentBefore,
  ageHours,
  isConfirmed,
  packDailyCap,
  packPayeeWhitelist,
  packConfirmation,
  packFreeze,
  packFor,
  buildContext,
  closeCalls,
  simulate,
  explainPreview,
  verdictFor,
  shortReasonFor,
} from '../lib/preview.js';

const U = 1_000_000n; // 1 USDT0
const MAX32 = 0xffffffffn;
const MAX16 = 0xffffn;
const OWNER = '0x6337859a9e1360fc68E5DeEe678052B682fDc57F';
const OTHER = '0xDDc005fE0378643e8FE35880D6E7467D2Da2aD26';
const DAY = 86400n;
const T0 = 20_400n * DAY + 10n * 3600n; // 10:00 UTC on some day

/// Pin i of the circuit is bit (i & 7) of byte (i >> 3) (TAP-02, LSB-first).
const pin = (bytes, i) => (bytes[i >> 3] >> (i & 7)) & 1;
/// Reads a field back from the pins it occupies in the README pinout tables.
const readPins = (bytes, from, width) => {
  let v = 0n;
  for (let b = 0; b < width; b++) v |= BigInt(pin(bytes, from + b)) << BigInt(b);
  return v;
};

// Deterministic pseudo-random values (no Math.random, so failures reproduce).
function rng(seed) {
  let s = seed >>> 0;
  const next = () => (s = (s * 1664525 + 1013904223) >>> 0);
  return (max) => {
    const r = (BigInt(next()) << 32n) | BigInt(next());
    return max === 0n ? 0n : r % (max + 1n);
  };
}

// ------------------------------------------------------------------ packing vs README pinouts and reference packers

test('Daily Cap packing: README pins 0-31 amount, 32-63 spent today, 64-95 daily limit; same bytes as the circuit builder', () => {
  const r = rng(1);
  for (let n = 0; n < 200; n++) {
    const [a, s, c] = [r(MAX32), r(MAX32), r(MAX32)];
    const b = packDailyCap(a, s, c);
    assert.equal(b.length, 12);
    assert.deepEqual(b, packDailyCapInputs(a, s, c));
    assert.equal(readPins(b, 0, 32), a);
    assert.equal(readPins(b, 32, 32), s);
    assert.equal(readPins(b, 64, 32), c);
    assert.deepEqual(decodeCircuitInput(1, '0x' + Buffer.from(b).toString('hex')), { amount: a, spentToday: s, dailyCap: c });
  }
  assert.deepEqual([...packDailyCap(1n, 0n, 0x01020304n)], [1, 0, 0, 0, 0, 0, 0, 0, 4, 3, 2, 1], 'little-endian per field');
  assert.equal(packDailyCap(MAX32 + 1n, 0n, 0n), null, 'out of range is rejected, never truncated');
  assert.equal(packDailyCap(0n, MAX32 + 1n, 0n), null);
  assert.equal(packDailyCap(0n, 0n, MAX32 + 1n), null);
});

test('Payee Whitelist packing: README pins 0 trusted, 1-16 age, 17-48 amount, 49-80 new-recipient limit, 81-96 waiting time', () => {
  const r = rng(2);
  for (let n = 0; n < 200; n++) {
    const saved = r(1n) === 1n;
    const [h, a, t, c] = [r(MAX16), r(MAX32), r(MAX32), r(MAX16)];
    const b = packPayeeWhitelist(saved, h, a, t, c);
    assert.equal(b.length, 13);
    assert.deepEqual(b, packPayeeWhitelistInputs(saved, h, a, t, c));
    assert.equal(readPins(b, 0, 1), saved ? 1n : 0n);
    assert.equal(readPins(b, 1, 16), h);
    assert.equal(readPins(b, 17, 32), a);
    assert.equal(readPins(b, 49, 32), t);
    assert.equal(readPins(b, 81, 16), c);
    assert.equal(b[12] >> 1, 0, 'pins above 96 stay 0');
  }
  assert.equal(packPayeeWhitelist(false, MAX16 + 1n, 0n, 0n, 0n), null);
  assert.equal(packPayeeWhitelist(false, 0n, MAX32 + 1n, 0n, 0n), null);
  assert.equal(packPayeeWhitelist(false, 0n, 0n, MAX32 + 1n, 0n), null);
  assert.equal(packPayeeWhitelist(false, 0n, 0n, 0n, MAX16 + 1n), null);
});

test('Confirmation packing: README pins 0-31 amount, 32-63 threshold, 64 confirmed; Freeze: one byte', () => {
  const r = rng(3);
  for (let n = 0; n < 200; n++) {
    const [a, t, ok] = [r(MAX32), r(MAX32), r(1n) === 1n];
    const b = packConfirmation(a, t, ok);
    assert.equal(b.length, 9);
    assert.deepEqual(b, packConfirmationInputs(a, t, ok));
    assert.equal(readPins(b, 0, 32), a);
    assert.equal(readPins(b, 32, 32), t);
    assert.equal(readPins(b, 64, 1), ok ? 1n : 0n);
  }
  assert.equal(packConfirmation(MAX32 + 1n, 0n, false), null);
  assert.deepEqual(packFreeze(true), packFreezeInputs(true));
  assert.deepEqual([...packFreeze(true)], [1]);
  assert.deepEqual([...packFreeze(false)], [0]);
});

test('packFor picks each kind’s packer from one context', () => {
  const ctx = { amount: 7n * U, spentBefore: 3n * U, dailyCap: 50n * U, isSaved: false, ageHours: 30n, trialLimit: 5n * U, coolingOffHours: 24n, threshold: 20n * U, confirmed: true, frozen: true };
  assert.deepEqual(packFor(KIND.DAILY_CAP, ctx), packDailyCapInputs(7n * U, 3n * U, 50n * U));
  assert.deepEqual(packFor(KIND.WHITELIST, ctx), packPayeeWhitelistInputs(false, 30n, 7n * U, 5n * U, 24n));
  assert.deepEqual(packFor(KIND.CONFIRMATION, ctx), packConfirmationInputs(7n * U, 20n * U, true));
  assert.deepEqual(packFor(KIND.FREEZE, ctx), Uint8Array.of(1));
  assert.equal(packFor(9, ctx), null);
});

// ------------------------------------------------------------------ time rules

test('daily spending resets when the UTC day changes, exactly at midnight', () => {
  const day = dayOf(T0);
  assert.equal(spentBefore({ spentToday: 30n * U, lastResetDay: day, now: T0 }), 30n * U);
  const midnight = (day + 1n) * DAY;
  assert.equal(spentBefore({ spentToday: 30n * U, lastResetDay: day, now: midnight - 1n }), 30n * U, 'one second before midnight: same day');
  assert.equal(spentBefore({ spentToday: 30n * U, lastResetDay: day, now: midnight }), 0n, 'at midnight UTC: a new day');
  assert.equal(spentBefore({ spentToday: 30n * U, lastResetDay: day - 3n, now: T0 }), 0n, 'days without payments');
});

test('payee age is whole hours rounded down, 0 for an unknown payee, capped at 65535', () => {
  assert.equal(ageHours({ firstSeen: 0n, now: T0 }), 0n, 'unknown payee');
  assert.equal(ageHours({ firstSeen: T0, now: T0 }), 0n);
  assert.equal(ageHours({ firstSeen: T0, now: T0 + 3599n }), 0n, '59 min 59 s is still 0 h');
  assert.equal(ageHours({ firstSeen: T0, now: T0 + 3600n }), 1n);
  assert.equal(ageHours({ firstSeen: T0, now: T0 + 24n * 3600n - 1n }), 23n, 'one second short of 24 h');
  assert.equal(ageHours({ firstSeen: T0, now: T0 + 24n * 3600n }), 24n);
  assert.equal(ageHours({ firstSeen: 1n, now: 1n + 70000n * 3600n }), MAX16, 'saturates');
});

test('a confirmation counts only while unexpired and given by the current owner', () => {
  const base = { expiresAt: T0 + 100n, confirmedBy: OWNER, controller: OWNER.toLowerCase() };
  assert.equal(isConfirmed({ ...base, now: T0 }), true);
  assert.equal(isConfirmed({ ...base, now: T0 + 100n }), true, 'valid while now <= expiresAt');
  assert.equal(isConfirmed({ ...base, now: T0 + 101n }), false, 'expired');
  assert.equal(isConfirmed({ ...base, controller: OTHER, now: T0 }), false, 'given by a previous owner');
  assert.equal(isConfirmed({ expiresAt: 0n, confirmedBy: null, controller: OWNER, now: T0 }), false, 'none');
});

test('buildContext reads raw escrow values like _execute and notices close calls', () => {
  const raw = {
    spentToday: 40n * U, lastResetDay: dayOf(T0) - 1n, dailyCap: 50n * U, payee: { firstSeen: T0 - 24n * 3600n + 60n, saved: false },
    trialLimit: 5n * U, coolingOffHours: 24n, confirmationThreshold: 20n * U, confirmation: { expiresAt: 0n, confirmedBy: null }, controller: OWNER, frozen: false,
  };
  const ctx = buildContext(raw, { amount: 2n * U, now: T0 });
  assert.equal(ctx.newDay, true);
  assert.equal(ctx.spentBefore, 0n, 'yesterday’s 40 does not count');
  assert.equal(ctx.ageHours, 23n);
  assert.equal(ctx.known, true);
  assert.deepEqual(closeCalls(ctx, [KIND.DAILY_CAP, KIND.WHITELIST]), ['waiting'], 'waiting time ends in 60 s');
  const unknown = buildContext({ ...raw, payee: { firstSeen: 0n, saved: false } }, { amount: 2n * U, now: T0 });
  assert.equal(unknown.known, false);
  assert.equal(unknown.ageHours, 0n);
  const nearMidnight = buildContext(raw, { amount: 1n, now: (dayOf(T0) + 1n) * DAY - 30n });
  assert.ok(closeCalls(nearMidnight, [KIND.DAILY_CAP]).includes('midnight'));
});

// ------------------------------------------------------------------ simulation on the real netlists

const BUILT = { [KIND.DAILY_CAP]: buildDailyCap(), [KIND.WHITELIST]: buildPayeeWhitelist(), [KIND.CONFIRMATION]: buildConfirmation(), [KIND.FREEZE]: buildFreeze() };
const circuits = [KIND.DAILY_CAP, KIND.WHITELIST, KIND.CONFIRMATION, KIND.FREEZE].map((kind) => ({ kind, processor: OTHER, circuitId: BigInt(kind), netlistHash: `0x${String(kind).repeat(64)}` }));
const netlists = circuits.map((c) => ({ gates: BUILT[c.kind].gates, nIn: BUILT[c.kind].nIn, nOut: 1, hash: c.netlistHash }));
const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const decode = (k, input) => decodeCircuitInput(k, input);
const ruleName = (k) => ({ 1: 'Daily limit', 2: 'Trusted recipients', 3: 'Approval for large payments', 4: 'Emergency freeze' })[k];

function scenario(over = {}, amount = 10n * U, balance = 100n * U) {
  const raw = {
    spentToday: 0n, lastResetDay: dayOf(T0), dailyCap: 50n * U, payee: { firstSeen: T0 - 3600n * 100n, saved: true },
    trialLimit: 5n * U, coolingOffHours: 24n, confirmationThreshold: 20n * U, confirmation: { expiresAt: 0n, confirmedBy: null }, controller: OWNER, frozen: false,
    ...over,
  };
  const ctx = buildContext(raw, { amount, now: T0 });
  return { ctx, sim: simulate({ circuits, netlists, ctx, balance }) };
}

test('simulate: an allowed payment, and today’s total and balance after it', () => {
  const { ctx, sim } = scenario({ spentToday: 28n * U }, 10n * U);
  assert.equal(sim.allowed, true);
  assert.equal(sim.reason, REASON.NONE);
  assert.deepEqual(sim.results.map((r) => r.status), [STATUS.ALLOW, STATUS.ALLOW, STATUS.ALLOW, STATUS.ALLOW]);
  assert.equal(sim.spentAfter, 38n * U);
  assert.equal(sim.balanceAfter, 90n * U);
  assert.equal(sim.results[0].input, hex(packDailyCapInputs(10n * U, 28n * U, 50n * U)));
  assert.match(explainPreview(sim.results[0], ctx).text, /this would make 38 of 50 USDT0/);
  assert.equal(verdictFor(sim, ctx).text, 'This payment would go through: every rule says yes.');
});

test('simulate: over the daily limit, a new recipient, the approval rule alone, frozen', () => {
  let { ctx, sim } = scenario({ spentToday: 45n * U }, 10n * U);
  assert.equal(sim.allowed, false);
  assert.deepEqual(sim.results.map((r) => r.ok), [false, true, true, true]);
  assert.equal(sim.spentAfter, 45n * U, 'a blocked payment adds nothing');
  assert.equal(sim.balanceAfter, 100n * U);
  assert.equal(verdictFor(sim, ctx).text, 'This payment would be blocked: it would take today’s spending to 55 USDT0, over the 50 USDT0 daily limit.');

  ({ ctx, sim } = scenario({ payee: { firstSeen: 0n, saved: false } }, 3n * U));
  assert.deepEqual(sim.results.map((r) => r.ok), [true, false, true, true]);
  assert.match(explainPreview(sim.results[1], ctx).text, /isn’t on your list yet/);
  assert.match(verdictFor(sim, ctx).text, /isn’t on your list yet, and new recipients wait 24 h/);

  ({ ctx, sim } = scenario({}, 25n * U));
  const v = verdictFor(sim, ctx, { role: 'owner' });
  assert.equal(v.text, 'This payment would be blocked: above 20 USDT0 it needs your approval first.');
  assert.equal(v.approveOnly, true);
  assert.match(verdictFor(sim, ctx, { role: 'agent' }).text, /needs the owner’s approval first/);

  ({ ctx, sim } = scenario({ confirmation: { expiresAt: T0 + 600n, confirmedBy: OWNER } }, 25n * U));
  assert.equal(sim.allowed, true, 'approved by the current owner');
  assert.match(explainPreview(sim.results[2], ctx).text, /You approved this exact payment/);

  ({ ctx, sim } = scenario({ frozen: true, spentToday: 45n * U }, 25n * U));
  const fv = verdictFor(sim, ctx, { ruleName, decode });
  assert.equal(fv.text, 'This payment would be blocked by Emergency freeze (frozen), Daily limit (over today’s limit) and Approval for large payments (not approved).');
  assert.equal(fv.approveOnly, false);
});

test('simulate: the circuits agree with each README formula on many random contexts', () => {
  const r = rng(196);
  for (let n = 0; n < 150; n++) {
    const raw = {
      spentToday: r(80n * U), lastResetDay: dayOf(T0) - r(1n), dailyCap: r(100n * U),
      payee: r(3n) === 0n ? { firstSeen: 0n, saved: false } : { firstSeen: T0 - r(72n * 3600n), saved: r(1n) === 1n },
      trialLimit: r(30n * U), coolingOffHours: r(48n), confirmationThreshold: r(60n * U),
      confirmation: r(1n) ? { expiresAt: T0 + r(200n) - 100n, confirmedBy: OWNER } : { expiresAt: 0n, confirmedBy: null },
      controller: OWNER, frozen: r(4n) === 0n,
    };
    const amount = 1n + r(60n * U);
    const ctx = buildContext(raw, { amount, now: T0 });
    const sim = simulate({ circuits, netlists, ctx, balance: 1000n * U });
    const expect = [
      ctx.spentBefore + amount <= ctx.dailyCap,
      ctx.isSaved || (amount <= ctx.trialLimit && ctx.ageHours >= ctx.coolingOffHours),
      amount <= ctx.threshold || ctx.confirmed,
      !ctx.frozen,
    ];
    assert.deepEqual(sim.results.map((x) => x.ok), expect, JSON.stringify(raw, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(sim.allowed, expect.every(Boolean));
  }
});

test('simulate: not enough money, out-of-range amounts, no rules, and an unreadable or changed netlist', () => {
  let { ctx, sim } = scenario({}, 10n * U, 4n * U);
  assert.equal(sim.reason, REASON.INSUFFICIENT_BALANCE);
  assert.match(verdictFor(sim, ctx).text, /holds only 4 USDT0/);

  ({ ctx, sim } = scenario({}, MAX32 + 1n));
  assert.equal(sim.reason, REASON.INPUT_OUT_OF_RANGE);
  assert.deepEqual(sim.results.map((x) => x.status), [STATUS.NOT_EVALUATED, STATUS.NOT_EVALUATED, STATUS.NOT_EVALUATED, STATUS.ALLOW]);

  const empty = simulate({ circuits: [], netlists: [], ctx, balance: 100n * U });
  assert.equal(empty.reason, REASON.NO_CIRCUITS);
  assert.match(verdictFor(empty, ctx).text, /no rules are turned on/);

  const changed = simulate({ circuits, netlists: netlists.map((x, i) => (i === 1 ? { ...x, hash: '0xdead' } : x)), ctx: scenario().ctx, balance: 100n * U });
  assert.equal(changed.allowed, null);
  assert.equal(changed.results[1].unknown, 'changed');
  assert.equal(verdictFor(changed, ctx).tone, 'unknown');
  const missing = simulate({ circuits, netlists: [netlists[0]], ctx: scenario().ctx, balance: 100n * U });
  assert.equal(missing.results[2].unknown, 'unreadable');
});

test('shortReasonFor uses the History words', () => {
  const f = (o) => ({ isSaved: 0n, ageHours: 0n, amount: 1n, trialLimit: 5n, coolingOffHours: 24n, ...o });
  assert.equal(shortReasonFor({ kind: KIND.DAILY_CAP, status: STATUS.DENY }), 'over today’s limit');
  assert.equal(shortReasonFor({ kind: KIND.WHITELIST, status: STATUS.DENY, fields: f({ amount: 9n }) }), 'more than a new recipient can get');
  assert.equal(shortReasonFor({ kind: KIND.WHITELIST, status: STATUS.DENY, fields: f({ amount: 9n, trialLimit: 0n }) }), 'not a trusted recipient');
  assert.equal(shortReasonFor({ kind: KIND.WHITELIST, status: STATUS.DENY, fields: f({}) }), 'not on your list yet');
  assert.equal(shortReasonFor({ kind: KIND.WHITELIST, status: STATUS.DENY, fields: f({ ageHours: 3n }) }), 'added too recently');
  assert.equal(shortReasonFor({ kind: KIND.CONFIRMATION, status: STATUS.DENY }), 'not approved');
  assert.equal(shortReasonFor({ kind: KIND.FREEZE, status: STATUS.DENY }), 'frozen');
  assert.equal(shortReasonFor({ kind: KIND.DAILY_CAP, status: STATUS.NOT_EVALUATED }), 'amount too large');
});
