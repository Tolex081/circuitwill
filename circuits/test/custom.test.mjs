// Custom rule compiler (frontend/lib/rule-compiler.js): the netlist must compute exactly the rule, on every input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compileRule,
  evaluateRule,
  validateRule,
  canonicalJson,
  packFacts,
  unpackFacts,
  runNetlist,
  windowSlots,
  parseCents,
  FACTS,
  FIELD,
  N_IN,
  LIMITS,
  RuleError,
} from '../../frontend/lib/rule-compiler.js';
import { decodeNandNetlist, evalPacked, toHex, validate } from '../lib/tap02.mjs';
import { EXAMPLES } from '../custom/examples.mjs';
import { prng } from './helpers.mjs';

const FIELD_MAX = Object.fromEntries(FACTS.map(([n, , w]) => [n, (1n << BigInt(w)) - 1n]));

// Random facts biased towards interesting values: small numbers, boundaries of every constant in the rule, maxima.
function randomFacts(next, interesting) {
  const f = {};
  for (const [name, , width] of FACTS) {
    const max = FIELD_MAX[name];
    const r = next() % 8n;
    let v;
    if (width === 1) v = next() & 1n;
    else if (name === 'slot_of_week_utc') v = next() % 672n;
    else if (name === 'caller_role') v = next() % 3n;
    else if (r === 0n) v = max;
    else if (r === 1n) v = 0n;
    else if (r <= 4n && interesting[name]?.length) {
      const k = interesting[name][Number(next() % BigInt(interesting[name].length))];
      v = k + (next() % 3n) - 1n;
      if (v < 0n) v = 0n;
      if (v > max) v = max;
    } else v = next() % (max + 1n);
    f[name] = v;
  }
  return f;
}

function constantsOf(rule) {
  const out = {};
  const add = (field, k) => (out[field] ??= []).push(BigInt(k));
  const money = { amount: 'amount_c', spent_day: 'spent_day_after_c', spent_7d: 'spent_7d_after_c', spent_month: 'spent_month_after_c', balance_after: 'balance_after_c' };
  for (const g of rule.anyOf) {
    for (const c of g.allOf) {
      const k = c.max ?? c.min;
      if (money[c.fact]) add(money[c.fact], parseCents(k));
      else if (c.fact === 'count_day') add('count_day_after', k);
      else if (c.fact === 'payee_age_hours' || c.fact === 'checkin_age_hours') add(c.fact, k);
    }
  }
  return out;
}

function checkAgreement(rule, n, seed) {
  const c = compileRule(rule);
  const next = prng(seed);
  const interesting = constantsOf(c.rule);
  let allowed = 0;
  for (let i = 0; i < n; i++) {
    const f = randomFacts(next, interesting);
    const bytes = packFacts(f);
    const want = evaluateRule(c.rule, unpackFacts(bytes));
    assert.equal(runNetlist(c.gates, bytes), want, `netlist vs rule on ${JSON.stringify(f, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (want) allowed++;
  }
  // Every time slot, for every role, at the boundaries of the money constants.
  for (let slot = 0; slot < 672; slot++) {
    for (let role = 0; role < 3; role++) {
      const f = { slot_of_week_utc: slot, caller_role: role, spent_day_after_c: 1000, spent_7d_after_c: 1000, spent_month_after_c: 1000, payee_age_hours: 100, checkin_age_hours: 5000, payee_trusted: true, count_day_after: 1, amount_c: 100 };
      const bytes = packFacts(f);
      assert.equal(runNetlist(c.gates, bytes), evaluateRule(c.rule, unpackFacts(bytes)), `slot ${slot} role ${role}`);
    }
  }
  return { c, allowed };
}

test('every example rule: netlist agrees with the reference interpreter on 20,000 random and boundary inputs', () => {
  Object.entries(EXAMPLES).forEach(([slug, rule], i) => {
    const { c, allowed } = checkAgreement(rule, 20000, 0xc0ffee + i);
    assert.ok(allowed > 0 && allowed < 20000, `${slug}: both answers occur (${allowed} allowed)`);
    assert.ok(c.gateCount <= LIMITS.maxGates);
  });
});

test('netlists are valid TAP-02, match tap02.mjs evaluation, and match the committed build artifacts', () => {
  for (const [slug, rule] of Object.entries(EXAMPLES)) {
    const c = compileRule(rule);
    validate(c.gates, N_IN, 1);
    assert.deepEqual(decodeNandNetlist(c.netlist), c.gates);
    const next = prng(7);
    for (let i = 0; i < 500; i++) {
      const bytes = packFacts(randomFacts(next, constantsOf(c.rule)));
      assert.equal((evalPacked(c.gates, N_IN, 1, bytes)[0] & 1) === 1, runNetlist(c.gates, bytes));
    }
    const hex = readFileSync(new URL(`../custom/build/${slug}.netlist.hex`, import.meta.url), 'utf8').trim();
    assert.equal(hex, toHex(c.netlist), `${slug}: committed artifact drifted: run node custom/build.mjs`);
    const spec = readFileSync(new URL(`../custom/build/${slug}.spec.txt`, import.meta.url), 'utf8');
    assert.equal(spec, c.specPreimage);
  }
});

test('compilation is deterministic and independent of key order and list order', () => {
  const a = compileRule(EXAMPLES.son);
  const shuffled = {
    anyOf: [{ allOf: [{ windows: [{ to: '21:00', from: '00:00', days: [4, 3, 2, 1, 0, 0] }], fact: 'time' }, { max: '10.00', fact: 'spent_day' }] }],
    appliesTo: ['agent', 'agent'],
    tz: 60,
    v: 1,
  };
  const b = compileRule(shuffled);
  assert.equal(toHex(b.netlist), toHex(compileRule({ ...EXAMPLES.son, anyOf: [{ allOf: [...EXAMPLES.son.anyOf[0].allOf].reverse() }] }).netlist));
  assert.equal(canonicalJson(shuffled).includes('"days":[0,1,2,3,4]'), true);
  assert.equal(toHex(compileRule(EXAMPLES.son).netlist), toHex(a.netlist));
});

test('the son rule at its edges (owner in UTC+1)', () => {
  const { gates, rule } = compileRule(EXAMPLES.son);
  // Monday 00:00 UTC is slot 0. Local = UTC+1, so local Friday 20:45 = UTC Friday 19:45 = slot 4*96 + 79.
  const slotUtc = (day, hh, mm) => day * 96 + (hh * 60 + mm) / 15;
  const agent = (over) => ({ caller_role: 1, spent_day_after_c: 1000, slot_of_week_utc: slotUtc(4, 19, 45), ...over });
  const run = (f) => runNetlist(gates, packFacts(f));
  assert.equal(run(agent({})), true, 'Friday 20:45 local, 10.00 total');
  assert.equal(run(agent({ spent_day_after_c: 1001 })), false, '10.01 total');
  assert.equal(run(agent({ slot_of_week_utc: slotUtc(4, 20, 0) })), false, 'Friday 21:00 local');
  assert.equal(run(agent({ slot_of_week_utc: slotUtc(5, 9, 0) })), false, 'Saturday 10:00 local');
  // Local Monday 00:00 is Sunday 23:00 UTC (slot 6*96 + 92): allowed.
  assert.equal(run(agent({ slot_of_week_utc: slotUtc(6, 23, 0) })), true, 'Monday 00:00 local = Sunday 23:00 UTC');
  assert.equal(run(agent({ slot_of_week_utc: slotUtc(6, 22, 45) })), false, 'Sunday 23:45 local');
  // The owner is not limited by this rule.
  assert.equal(run({ caller_role: 0, spent_day_after_c: 999999, slot_of_week_utc: slotUtc(5, 12, 0) }), true);
  assert.equal(evaluateRule(rule, { caller_role: 2, spent_day_after_c: 999999 }), true, 'beneficiary not limited either');
});

test('time windows convert local time to UTC slots, wrapping around the week', () => {
  const s = windowSlots([{ days: [0], from: '00:00', to: '01:00' }], 60); // Monday 00:00-01:00 at UTC+1
  assert.deepEqual([...s.keys()].filter((i) => s[i]), [668, 669, 670, 671]); // Sunday 23:00-24:00 UTC
  const w = windowSlots([{ days: [6], from: '23:00', to: '24:00' }], -60); // Sunday 23:00 at UTC-1 = Monday 00:00 UTC
  assert.deepEqual([...w.keys()].filter((i) => w[i]), [0, 1, 2, 3]);
});

test('packFacts follows the documented pinout, rejects an oversized amount and saturates everything else', () => {
  const bytes = packFacts({ amount_c: 0x01020304, caller_role: 2, is_withdrawal: true, payee_trusted: true });
  assert.deepEqual([...bytes.slice(0, 4)], [4, 3, 2, 1]);
  const bit = (i) => (bytes[i >> 3] >> (i & 7)) & 1;
  assert.equal(bit(FIELD.caller_role.start), 0);
  assert.equal(bit(FIELD.caller_role.start + 1), 1);
  assert.equal(bit(216), 1);
  assert.equal(bit(178), 1);
  for (let i = 217; i < 256; i++) assert.equal(bit(i), 0, `reserved bit ${i}`);
  assert.throws(() => packFacts({ amount_c: 1n << 32n }), RangeError);
  const sat = unpackFacts(packFacts({ spent_day_after_c: 1n << 40n, payee_age_hours: 1e6, count_day_after: 999 }));
  assert.equal(sat.spent_day_after_c, 0xffffffffn);
  assert.equal(sat.payee_age_hours, 0xffffn);
  assert.equal(sat.count_day_after, 255n);
});

test('the compiler refuses anything off the menu, unsafe or meaningless', () => {
  const base = { v: 1, tz: 0, appliesTo: ['agent'] };
  const bad = (anyOf, extra = {}) => () => compileRule({ ...base, ...extra, anyOf });
  assert.throws(bad([{ allOf: [{ fact: 'merchant', is: 'groceries' }] }]), /not on the menu/);
  assert.throws(bad([{ allOf: [{ fact: 'spent_day', max: '42949672.95' }] }]), /largest limit/, 'max at saturation is unsafe');
  assert.throws(bad([{ allOf: [{ fact: 'spent_day', max: '0' }] }]), /block everything/);
  assert.throws(bad([{ allOf: [{ fact: 'spent_day', min: '10' }] }]), /takes "max"/);
  assert.throws(bad([{ allOf: [{ fact: 'payee_age_hours', min: 65536 }] }]), /largest value/);
  assert.throws(bad([{ allOf: [{ fact: 'spent_day', max: '10.001' }] }]), /2 decimals/);
  assert.throws(bad([{ allOf: [{ fact: 'spent_day', max: '-1' }] }]), /money must/);
  assert.throws(bad([{ allOf: [{ fact: 'spent_day', max: '1e3' }] }]), /money must/);
  assert.throws(bad([{ allOf: [{ fact: 'time', windows: [{ days: [0], from: '21:00', to: '09:00' }] }] }]), /after the start/);
  assert.throws(bad([{ allOf: [{ fact: 'time', windows: [{ days: [0], from: '09:10', to: '10:00' }] }] }]), /15 minutes/);
  assert.throws(bad([{ allOf: [{ fact: 'time', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00' }] }] }]), /never blocks/);
  assert.throws(bad([{ allOf: [{ fact: 'caller', in: ['agent'] }] }]), /appliesTo/);
  assert.throws(bad([{ allOf: [{ fact: 'spent_day', max: '10' }] }], { tz: 7 }), /time zone/);
  assert.throws(bad([{ allOf: [{ fact: 'spent_day', max: '10', extra: 1 }] }]), /unknown field/);
  assert.throws(() => compileRule({ ...base, v: 2, anyOf: [] }), /version/);
  assert.throws(() => validateRule({ ...base, appliesTo: [], anyOf: [{ allOf: [{ fact: 'confirmed', is: true }] }] }), /whose payments/);
  const many = Array.from({ length: LIMITS.maxConditions + 1 }, () => ({ fact: 'confirmed', is: true }));
  assert.throws(bad([{ allOf: many }]), /at most/);
  assert.throws(bad([{ allOf: [{ fact: 'payee_trusted', is: false }] }]), /can only be required to be true/);
  try {
    bad([{ allOf: [{ fact: 'merchant' }] }])();
  } catch (e) {
    assert.ok(e instanceof RuleError);
    assert.equal(e.path, 'anyOf[0].allOf[0]');
  }
});

test('saturation is always on the safe side: a saturated fact never turns a "no" into a "yes"', () => {
  // For every money/hours/count fact, the largest accepted "max" limit still blocks the saturated value, and the
  // largest accepted "min" limit still allows it (true value >= saturated value >= limit).
  const facts = [['spent_day', 'spent_day_after_c', true], ['spent_7d', 'spent_7d_after_c', true], ['spent_month', 'spent_month_after_c', true], ['count_day', 'count_day_after', false], ['checkin_age_hours', 'checkin_age_hours', false]];
  for (const [fact, field, money] of facts) {
    const max = FIELD_MAX[field];
    const k = money ? `${(max - 1n) / 100n}.${String((max - 1n) % 100n).padStart(2, '0')}` : Number(max - 1n);
    const rule = { v: 1, tz: 0, appliesTo: ['agent'], anyOf: [{ allOf: [{ fact, max: k }] }] };
    const { gates } = compileRule(rule);
    assert.equal(runNetlist(gates, packFacts({ caller_role: 1, [field]: max })), false, `${fact}: saturated value blocked`);
    assert.equal(runNetlist(gates, packFacts({ caller_role: 1, [field]: max - 1n })), true, `${fact}: limit itself allowed`);
  }
});

test('a deliberately large rule stays under the gate cap and still agrees with the interpreter', () => {
  const rule = {
    v: 1,
    tz: 330,
    appliesTo: ['agent', 'beneficiary'],
    anyOf: [
      { allOf: [{ fact: 'spent_day', max: '100' }, { fact: 'time', windows: [{ days: [0, 1, 2, 3, 4], from: '09:00', to: '18:00' }] }, { fact: 'payee_age_hours', min: 1 }] },
      { allOf: [{ fact: 'spent_7d', max: '300' }, { fact: 'payee_age_hours', min: 72 }, { fact: 'confirmed', is: true }] },
      { allOf: [{ fact: 'balance_after', min: '1000' }, { fact: 'count_day', max: 3 }] },
      { allOf: [{ fact: 'spent_month', max: '2000' }, { fact: 'is_withdrawal', is: false }, { fact: 'payee_paid_before', is: true }] },
    ],
  };
  const { c } = checkAgreement(rule, 5000, 99);
  assert.ok(c.gateCount < 700, `${c.gateCount} gates`);
});
