// Custom rule compiler: rule form (JSON) -> NAND netlist (TAP-02) with the fixed 256-pin "facts v1" layout.
//
// Deterministic and pure: no AI, no DOM, no ethers, no Node built-ins, so the same file runs in the dashboard and in
// Node tests (circuits/custom). The same rule always gives byte-identical netlist bytes.
//
// What it guarantees (tested in circuits/test/custom.test.mjs):
//   - only facts from the fixed menu (FACTS, mirroring contracts/src/libraries/CustomFactsPacking.sol) can be used;
//   - every comparison is on the safe side of saturation: "at most K" needs K below the field maximum, "at least K"
//     needs K at or below it, so a saturated fact can never turn a "no" into a "yes";
//   - the netlist computes exactly evaluateRule() (the reference interpreter) on every input;
//   - a rule that never blocks anything, or blocks everything, is refused.
//
// Rule form, version 1 (see validateRule for the exact checks):
//   {
//     v: 1,
//     tz: 60,                                    // owner's fixed UTC offset in minutes (multiple of 15)
//     appliesTo: ['agent'],                      // whose payments the rule limits: 'owner' | 'agent' | 'beneficiary'
//     anyOf: [                                   // allowed if ANY group passes (most rules have one group)
//       { allOf: [ condition, ... ] }            // a group passes if ALL its conditions pass
//     ]
//   }
//   A payment by someone outside appliesTo is not limited by this rule (the official rules still apply).
//
// Conditions:
//   { fact: 'amount' | 'spent_day' | 'spent_7d' | 'spent_month', max: '10.00' }       money in USDT0, 2 decimals
//   { fact: 'balance_after', min: '100.00' }
//   { fact: 'count_day', max: 5 }                                                     payments today incl. this one
//   { fact: 'payee_age_hours', min: 48 }
//   { fact: 'checkin_age_hours', min: 4320 } | { fact: 'checkin_age_hours', max: 720 }
//   { fact: 'payee_trusted' | 'payee_paid_before' | 'confirmed', is: true }
//   { fact: 'is_withdrawal', is: true|false }
//   { fact: 'time', windows: [{ days: [0..6], from: 'HH:MM', to: 'HH:MM' }] }        local time, Monday = 0,
//                                                                                    from inclusive, to exclusive
//
// Every condition only gets easier to pass through something the owner cannot do at once (a delayed change, real
// spending, time passing). Conditions that an instant owner action could satisfy are refused (security review
// 2026-11-24): "is: false" on trusted / paid before / approved (removing a recipient or an approval is instant),
// "payee_known" (adding a recipient is instant; use payee_age_hours min instead), and conditions on who is paying
// (the people a rule limits are its appliesTo, which the escrow records as the rule's role bits).
//
// Known limit: time zones are a fixed offset. Daylight saving is not followed.

export const COMPILER_VERSION = 'circuitwill-rule-compiler/1';
export const FACTS_VERSION = 1;
export const N_IN = 256;
export const UNITS_PER_CENT = 10000n;
export const SLOTS_PER_WEEK = 672;

// [name, first pin, width] — must match CustomFactsPacking.sol bit for bit.
export const FACTS = Object.freeze([
  ['amount_c', 0, 32],
  ['spent_day_after_c', 32, 32],
  ['spent_7d_after_c', 64, 32],
  ['spent_month_after_c', 96, 32],
  ['balance_after_c', 128, 32],
  ['count_day_after', 160, 8],
  ['slot_of_week_utc', 168, 10],
  ['payee_trusted', 178, 1],
  ['payee_known', 179, 1],
  ['payee_paid_before', 180, 1],
  ['payee_age_hours', 181, 16],
  ['checkin_age_hours', 197, 16],
  ['caller_role', 213, 2],
  ['confirmed', 215, 1],
  ['is_withdrawal', 216, 1],
].map((f) => Object.freeze(f)));
export const FIELD = Object.freeze(Object.fromEntries(FACTS.map(([n, start, width]) => [n, Object.freeze({ start, width })])));

export const ROLES = Object.freeze({ owner: 0, agent: 1, beneficiary: 2 });
export const DAY_NAMES = Object.freeze(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

// Condition facts as the rule form names them -> pinout field and comparison kind.
const MENU = Object.freeze({
  amount: { field: 'amount_c', money: true, ops: ['max'] },
  spent_day: { field: 'spent_day_after_c', money: true, ops: ['max'] },
  spent_7d: { field: 'spent_7d_after_c', money: true, ops: ['max'] },
  spent_month: { field: 'spent_month_after_c', money: true, ops: ['max'] },
  balance_after: { field: 'balance_after_c', money: true, ops: ['min'] },
  count_day: { field: 'count_day_after', ops: ['max'] },
  payee_age_hours: { field: 'payee_age_hours', ops: ['min'] },
  checkin_age_hours: { field: 'checkin_age_hours', ops: ['min', 'max'] },
  payee_trusted: { field: 'payee_trusted', bool: true, onlyTrue: true },
  payee_paid_before: { field: 'payee_paid_before', bool: true, onlyTrue: true },
  confirmed: { field: 'confirmed', bool: true, onlyTrue: true },
  is_withdrawal: { field: 'is_withdrawal', bool: true },
  time: { field: 'slot_of_week_utc', time: true },
});
export const MENU_FACTS = Object.freeze(Object.keys(MENU));

/// Why a fact the escrow packs is not on the menu.
const OFF_MENU = Object.freeze({
  payee_known: 'adding a recipient takes effect at once, so "on my list" could be switched on instantly; use "recipient added at least N hours ago" (payee_age_hours min) instead',
  caller: 'who a rule limits is chosen with appliesTo, not inside the rule',
});

/// The escrow's role bits for a rule's appliesTo (CircuitWillEscrow APPLIES_TO_*): owner 1, agent 2, beneficiary 4.
export const ROLE_BITS = Object.freeze({ owner: 1, agent: 2, beneficiary: 4 });
export function appliesToBits(rule) {
  return validateRule(rule).appliesTo.reduce((m, r) => m | ROLE_BITS[r], 0);
}

export const LIMITS = Object.freeze({ maxGroups: 4, maxConditions: 12, maxWindows: 8, maxGates: 1000 });

export class RuleError extends Error {
  constructor(message, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'RuleError';
    this.path = path;
  }
}

// ------------------------------------------------------------------ money and time parsing

/// '10', '10.5', '10.50' -> 1050n cents. Rejects negatives, more than 2 decimals, exponents and anything else.
export function parseCents(value, path = '') {
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(s.trim())) {
    throw new RuleError('money must look like 10 or 10.50 (USDT0, at most 2 decimals)', path);
  }
  const [whole, frac = ''] = s.trim().split('.');
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
}

export const formatCents = (c) => {
  const v = BigInt(c);
  const whole = v / 100n;
  const frac = (v % 100n).toString().padStart(2, '0');
  return `${whole.toLocaleString('en-US')}.${frac}`;
};

/// 'HH:MM' on a 15-minute grid -> minutes since midnight. '24:00' is allowed as an end time.
export function parseClock(value, path = '', { allow24 = false } = {}) {
  const m = typeof value === 'string' ? /^(\d{2}):(\d{2})$/.exec(value) : null;
  if (!m) throw new RuleError('time must look like 09:00', path);
  const h = Number(m[1]);
  const min = Number(m[2]);
  const total = h * 60 + min;
  if (min % 15 !== 0) throw new RuleError('times go in steps of 15 minutes (:00, :15, :30, :45)', path);
  if (h > 24 || min > 59 || total > 1440 || (total === 1440 && !allow24)) throw new RuleError('not a valid time of day', path);
  return total;
}

export const formatClock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/// UTC offset in minutes -> 'UTC+1', 'UTC-5:30', 'UTC'.
export function formatTz(tz) {
  if (tz === 0) return 'UTC';
  const sign = tz > 0 ? '+' : '-';
  const a = Math.abs(tz);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`;
}

// ------------------------------------------------------------------ validation and canonical form

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function onlyKeys(obj, allowed, path) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new RuleError(`unknown field "${k}"`, path);
  }
}

function fieldMax(field) {
  return (1n << BigInt(FIELD[field].width)) - 1n;
}

/// Checks a rule form and returns its canonical copy (fixed key order, sorted lists, money as 'W.CC' strings).
/// Throws RuleError with a plain-English message and the path of the first problem.
export function validateRule(rule) {
  if (!isPlainObject(rule)) throw new RuleError('rule must be an object');
  onlyKeys(rule, ['v', 'tz', 'appliesTo', 'anyOf'], '');
  if (rule.v !== 1) throw new RuleError('unsupported rule version (expected v: 1)', 'v');
  const tz = rule.tz ?? 0;
  if (!Number.isInteger(tz) || tz % 15 !== 0 || tz < -720 || tz > 840) {
    throw new RuleError('time zone must be a whole number of minutes from UTC, in steps of 15, between -12:00 and +14:00', 'tz');
  }
  const appliesTo = rule.appliesTo;
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) throw new RuleError('say whose payments this rule limits', 'appliesTo');
  for (const r of appliesTo) if (!(r in ROLES)) throw new RuleError(`unknown person "${r}"`, 'appliesTo');
  const roles = [...new Set(appliesTo)].sort((a, b) => ROLES[a] - ROLES[b]);

  if (!Array.isArray(rule.anyOf) || rule.anyOf.length === 0) throw new RuleError('a rule needs at least one group of conditions', 'anyOf');
  if (rule.anyOf.length > LIMITS.maxGroups) throw new RuleError(`at most ${LIMITS.maxGroups} alternative groups`, 'anyOf');
  let total = 0;
  const anyOf = rule.anyOf.map((g, gi) => {
    const gp = `anyOf[${gi}]`;
    if (!isPlainObject(g)) throw new RuleError('group must be an object', gp);
    onlyKeys(g, ['allOf'], gp);
    if (!Array.isArray(g.allOf) || g.allOf.length === 0) throw new RuleError('a group needs at least one condition', gp);
    total += g.allOf.length;
    return { allOf: g.allOf.map((c, ci) => validateCondition(c, `${gp}.allOf[${ci}]`)) };
  });
  if (total > LIMITS.maxConditions) throw new RuleError(`at most ${LIMITS.maxConditions} conditions in one rule`, 'anyOf');
  return { v: 1, tz, appliesTo: roles, anyOf };
}

function validateCondition(c, path) {
  if (!isPlainObject(c)) throw new RuleError('condition must be an object', path);
  const m = MENU[c.fact];
  if (!m && OFF_MENU[c.fact]) throw new RuleError(`"${c.fact}" can't be used: ${OFF_MENU[c.fact]}`, path);
  if (!m) throw new RuleError(`"${c.fact}" is not on the menu of facts the escrow can check`, path);
  if (m.bool) {
    onlyKeys(c, ['fact', 'is'], path);
    if (typeof c.is !== 'boolean') throw new RuleError('"is" must be true or false', path);
    if (m.onlyTrue && !c.is) {
      throw new RuleError(`"${c.fact}" can only be required to be true: you can switch it off at once (for example by removing a recipient), which would loosen the rule without the wait`, path);
    }
    return { fact: c.fact, is: c.is };
  }
  if (m.time) {
    onlyKeys(c, ['fact', 'windows'], path);
    if (!Array.isArray(c.windows) || c.windows.length === 0) throw new RuleError('list at least one time window', path);
    if (c.windows.length > LIMITS.maxWindows) throw new RuleError(`at most ${LIMITS.maxWindows} time windows`, path);
    const windows = c.windows.map((w, wi) => {
      const wp = `${path}.windows[${wi}]`;
      if (!isPlainObject(w)) throw new RuleError('window must be an object', wp);
      onlyKeys(w, ['days', 'from', 'to'], wp);
      if (!Array.isArray(w.days) || w.days.length === 0) throw new RuleError('pick at least one day', wp);
      for (const d of w.days) if (!Number.isInteger(d) || d < 0 || d > 6) throw new RuleError('days are 0 (Monday) to 6 (Sunday)', wp);
      const from = parseClock(w.from, `${wp}.from`);
      const to = parseClock(w.to, `${wp}.to`, { allow24: true });
      if (to <= from) throw new RuleError('the end time must be after the start time (split overnight windows in two)', wp);
      return { days: [...new Set(w.days)].sort((a, b) => a - b), from: formatClock(from), to: formatClock(to) };
    });
    return { fact: 'time', windows };
  }
  const op = 'max' in c ? 'max' : 'min' in c ? 'min' : null;
  onlyKeys(c, ['fact', op ?? 'max'], path);
  if (!op || !m.ops.includes(op)) throw new RuleError(`"${c.fact}" takes ${m.ops.map((o) => `"${o}"`).join(' or ')}`, path);
  const max = fieldMax(m.field);
  if (m.money) {
    const cents = parseCents(c[op], `${path}.${op}`);
    checkSafe(op, cents, max, path, true);
    return { fact: c.fact, [op]: formatCents(cents).replace(/,/g, '') };
  }
  const n = c[op];
  if (!Number.isInteger(n) || n < 0) throw new RuleError('must be a whole number', `${path}.${op}`);
  checkSafe(op, BigInt(n), max, path, false);
  return { fact: c.fact, [op]: n };
}

// "at most K" on a saturating field is only safe for K below the field maximum; "at least K" needs K <= maximum.
// Zero bounds are refused too: "at most 0" blocks every payment and "at least 0" never blocks anything.
function checkSafe(op, k, max, path, money) {
  const show = (v) => (money ? formatCents(v) : v.toString());
  if (op === 'max') {
    if (k <= 0n) throw new RuleError('an upper limit of 0 would block everything', path);
    if (k >= max) throw new RuleError(`the largest limit this fact can check is ${show(max - 1n)}`, path);
  } else {
    if (k <= 0n) throw new RuleError('a lower limit of 0 never blocks anything; leave this condition out', path);
    if (k > max) throw new RuleError(`the largest value this fact can check is ${show(max)}`, path);
  }
}

/// Canonical JSON text of a validated rule: keys in a fixed order, no spaces. specHash = keccak256 of
/// `COMPILER_VERSION + '\n' + canonicalJson(rule)` (computed by the caller, which has a keccak implementation).
export function canonicalJson(rule) {
  const r = validateRule(rule);
  const cond = (c) => {
    if ('is' in c) return `{"fact":${JSON.stringify(c.fact)},"is":${c.is}}`;
    if ('windows' in c) {
      const ws = c.windows.map((w) => `{"days":${JSON.stringify(w.days)},"from":"${w.from}","to":"${w.to}"}`);
      return `{"fact":"time","windows":[${ws.join(',')}]}`;
    }
    const op = 'max' in c ? 'max' : 'min';
    return `{"fact":${JSON.stringify(c.fact)},"${op}":${JSON.stringify(c[op])}}`;
  };
  const groups = r.anyOf.map((g) => `{"allOf":[${g.allOf.map(cond).join(',')}]}`);
  return `{"v":1,"tz":${r.tz},"appliesTo":${JSON.stringify(r.appliesTo)},"anyOf":[${groups.join(',')}]}`;
}

/// The exact bytes whose keccak256 is the on-chain specHash.
export function specPreimage(rule) {
  return `${COMPILER_VERSION}\n${canonicalJson(rule)}`;
}

// ------------------------------------------------------------------ time windows -> UTC slots

/// Local windows -> 672-entry 0/1 array of allowed 15-minute UTC slots of the week (Monday 00:00 UTC = slot 0).
export function windowSlots(windows, tz) {
  const set = new Uint8Array(SLOTS_PER_WEEK);
  for (const w of windows) {
    const from = parseClock(w.from);
    const to = parseClock(w.to, '', { allow24: true });
    for (const d of w.days) {
      for (let m = from; m < to; m += 15) {
        const utc = (((d * 1440 + m - tz) % 10080) + 10080) % 10080;
        set[utc / 15] = 1;
      }
    }
  }
  return set;
}

function slotIntervals(set) {
  const ivs = [];
  let i = 0;
  while (i < SLOTS_PER_WEEK) {
    if (!set[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < SLOTS_PER_WEEK && set[j + 1]) j++;
    ivs.push([i, j]);
    i = j + 1;
  }
  return ivs;
}

// ------------------------------------------------------------------ facts packing (CustomFactsPacking.sol)

/// facts = { amount_c, spent_day_after_c, ... } (numbers, bigints or booleans). The amount must fit 32 bits (else
/// RangeError, like the contract's "not evaluated"); every other value saturates at its field maximum.
export function packFacts(facts) {
  let word = 0n;
  for (const [name, start, width] of FACTS) {
    let v = facts[name] ?? 0;
    v = typeof v === 'boolean' ? (v ? 1n : 0n) : BigInt(v);
    const max = (1n << BigInt(width)) - 1n;
    if (v < 0n) throw new RangeError(`${name} is negative`);
    if (v > max) {
      if (name === 'amount_c' || name === 'slot_of_week_utc' || name === 'caller_role') throw new RangeError(`${name} does not fit`);
      v = max;
    }
    word |= v << BigInt(start);
  }
  const out = new Uint8Array(32);
  for (let j = 0; j < 32; j++) out[j] = Number((word >> BigInt(8 * j)) & 0xffn);
  return out;
}

/// Inverse of packFacts (for the X-ray and tests).
export function unpackFacts(bytes) {
  let word = 0n;
  for (let j = 0; j < 32 && j < bytes.length; j++) word |= BigInt(bytes[j]) << BigInt(8 * j);
  const out = {};
  for (const [name, start, width] of FACTS) {
    const v = (word >> BigInt(start)) & ((1n << BigInt(width)) - 1n);
    out[name] = width === 1 ? v === 1n : v;
  }
  return out;
}

// ------------------------------------------------------------------ reference interpreter

const num = (v) => (typeof v === 'boolean' ? (v ? 1n : 0n) : BigInt(v ?? 0));

/// What the rule answers for a set of facts (already saturated as the escrow packs them). Independent of the netlist:
/// tests compare it with the compiled circuit on many inputs.
export function evaluateRule(rule, facts) {
  const r = validateRule(rule);
  const role = Number(num(facts.caller_role));
  if (!r.appliesTo.some((p) => ROLES[p] === role)) return true;
  return r.anyOf.some((g) => g.allOf.every((c) => evalCondition(c, facts, r.tz)));
}

function evalCondition(c, facts, tz) {
  const m = MENU[c.fact];
  if (m.bool) return (num(facts[m.field]) === 1n) === c.is;
  if (m.time) return windowSlots(c.windows, tz)[Number(num(facts.slot_of_week_utc))] === 1;
  const k = m.money ? parseCents(c.max ?? c.min) : BigInt(c.max ?? c.min);
  const v = num(facts[m.field]);
  return 'max' in c ? v <= k : v >= k;
}

// ------------------------------------------------------------------ netlist builder

// NAND builder with constant folding, double-negation reuse and structural hashing. Signals: 0 = const 0,
// 1 = const 1, 2..257 = inputs, then one per gate (TAP-02).
class Builder {
  constructor() {
    this.gates = [];
    this.cache = new Map();
    this.notOf = new Map();
  }
  get next() {
    return 2 + N_IN + this.gates.length;
  }
  raw(a, b) {
    const s = this.next;
    this.gates.push([a, b]);
    return s;
  }
  input(i) {
    return 2 + i;
  }
  field(name) {
    const f = FIELD[name];
    return Array.from({ length: f.width }, (_, i) => this.input(f.start + i));
  }
  not(a) {
    if (a === 0) return 1;
    if (a === 1) return 0;
    if (this.notOf.has(a)) return this.notOf.get(a);
    const s = this.raw(a, a);
    this.notOf.set(a, s);
    this.notOf.set(s, a);
    return s;
  }
  nand(a, b) {
    if (a === 0 || b === 0) return 1;
    if (a === 1) return this.not(b);
    if (b === 1) return this.not(a);
    if (a === b) return this.not(a);
    if (this.notOf.get(a) === b) return 1;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const s = this.raw(a, b);
    this.cache.set(key, s);
    return s;
  }
  and(a, b) {
    return this.not(this.nand(a, b));
  }
  or(a, b) {
    return this.nand(this.not(a), this.not(b));
  }
  andAll(xs) {
    return xs.reduce((acc, x) => this.and(acc, x), 1);
  }
  orAll(xs) {
    return xs.reduce((acc, x) => this.or(acc, x), 0);
  }
}

// x <= K for a constant K, least significant bit first, tracking polarity to save inverters.
function leConst(b, bits, K) {
  if (K < 0n) return 0;
  if (K >= (1n << BigInt(bits.length)) - 1n) return 1;
  let v = 1;
  let inv = false;
  for (let i = 0; i < bits.length; i++) {
    const x = bits[i];
    if ((K >> BigInt(i)) & 1n) {
      v = b.nand(x, inv ? v : b.not(v)); // le' = NOT x OR le
      inv = false;
    } else {
      v = b.nand(b.not(x), inv ? b.not(v) : v); // NOT le' = NOT (NOT x AND le)
      inv = true;
    }
  }
  return inv ? b.not(v) : v;
}
const geConst = (b, bits, K) => (K <= 0n ? 1 : b.not(leConst(b, bits, K - 1n)));
const eqConst = (b, bits, K) => b.andAll(bits.map((x, i) => ((K >> BigInt(i)) & 1n ? x : b.not(x))));
const inRange = (b, bits, lo, hi) => b.and(geConst(b, bits, BigInt(lo)), leConst(b, bits, BigInt(hi)));

// Caller role is one of 0, 1, 2 (the escrow never packs 3: nobody else can propose), so all three roles is "true".
function roleIn(b, roles) {
  if (roles.length === 3) return 1;
  const bits = b.field('caller_role');
  return b.orAll(roles.map((p) => eqConst(b, bits, BigInt(ROLES[p]))));
}

function buildCondition(b, c, tz) {
  const m = MENU[c.fact];
  if (m.bool) {
    const x = b.input(FIELD[m.field].start);
    return c.is ? x : b.not(x);
  }
  const bits = b.field(m.field);
  if (m.time) {
    // The slot is never above 671 (the escrow refuses to pack anything larger), so an interval reaching the end of
    // the week needs no upper check, and a window covering the whole week is always true.
    return b.orAll(
      slotIntervals(windowSlots(c.windows, tz)).map(([lo, hi]) =>
        hi === SLOTS_PER_WEEK - 1 ? geConst(b, bits, BigInt(lo)) : inRange(b, bits, lo, hi),
      ),
    );
  }
  const k = m.money ? parseCents(c.max ?? c.min) : BigInt(c.max ?? c.min);
  return 'max' in c ? leConst(b, bits, k) : geConst(b, bits, k);
}

// Keep only gates the output depends on, renumbering signals. The output must be the last gate.
function compact(gates) {
  const base = 2 + N_IN;
  const keep = new Uint8Array(gates.length);
  keep[gates.length - 1] = 1;
  for (let i = gates.length - 1; i >= 0; i--) {
    if (!keep[i]) continue;
    for (const s of gates[i]) if (s >= base) keep[s - base] = 1;
  }
  const map = new Map();
  const out = [];
  gates.forEach(([a, c], i) => {
    if (!keep[i]) return;
    const m = (s) => (s >= base ? map.get(s) : s);
    map.set(base + i, base + out.length);
    out.push([m(a), m(c)]);
  });
  return out;
}

export function encodeNetlist(gates) {
  const bytes = new Uint8Array(gates.length * 7);
  gates.forEach(([a, c], i) => {
    const p = i * 7;
    bytes[p + 1] = (a >> 16) & 255;
    bytes[p + 2] = (a >> 8) & 255;
    bytes[p + 3] = a & 255;
    bytes[p + 4] = (c >> 16) & 255;
    bytes[p + 5] = (c >> 8) & 255;
    bytes[p + 6] = c & 255;
  });
  return bytes;
}

/// Evaluate a compiled netlist on packed facts (TAP-02 semantics). Returns true for allow.
export function runNetlist(gates, inputBytes) {
  const sig = new Uint8Array(2 + N_IN + gates.length);
  sig[1] = 1;
  for (let i = 0; i < N_IN; i++) sig[2 + i] = (inputBytes[i >> 3] >> (i & 7)) & 1;
  const base = 2 + N_IN;
  for (let i = 0; i < gates.length; i++) sig[base + i] = 1 - (sig[gates[i][0]] & sig[gates[i][1]]);
  return sig[sig.length - 1] === 1;
}

/// Compile a rule form. Returns { rule (canonical), canonical (JSON text), specPreimage, gates, netlist (bytes),
/// gateCount, nIn, nOut, stages } or throws RuleError.
export function compileRule(rule) {
  const r = validateRule(rule);
  const b = new Builder();
  const stages = [];
  const groupSignals = r.anyOf.map((g, gi) =>
    b.andAll(
      g.allOf.map((c, ci) => {
        const s = buildCondition(b, c, r.tz);
        stages.push({ group: gi, index: ci, fact: c.fact, gatesSoFar: b.gates.length });
        return s;
      }),
    ),
  );
  const conditions = b.orAll(groupSignals);
  if (conditions === 0) throw new RuleError('this rule blocks every payment by the people it limits');
  const limited = roleIn(b, r.appliesTo);
  let out = b.or(b.not(limited), conditions);
  if (out === 0 || out === 1) {
    throw new RuleError(out === 1 ? 'this rule never blocks anything' : 'this rule blocks every payment');
  }
  if (out !== b.next - 1) {
    // The output must be the last gate: add a buffer (two inverters on a fresh pair, not folded).
    const t = b.raw(out, out);
    out = b.raw(t, t);
  }
  const gates = compact(b.gates);
  if (gates.length > LIMITS.maxGates) {
    throw new RuleError(`this rule needs ${gates.length} gates; the most a custom rule can have is ${LIMITS.maxGates}. Use fewer conditions or time windows.`);
  }
  const canonical = canonicalJson(r);
  return Object.freeze({
    rule: r,
    canonical,
    specPreimage: `${COMPILER_VERSION}\n${canonical}`,
    gates,
    netlist: encodeNetlist(gates),
    gateCount: gates.length,
    nIn: N_IN,
    nOut: 1,
    stages,
  });
}

/// Compile and also report whether the rule is constant on a set of sample facts (used to warn the owner, e.g.
/// "this blocks every payment you tried").
export function checkRule(rule) {
  try {
    return { ok: true, compiled: compileRule(rule) };
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message, path: e.path };
    throw e;
  }
}
