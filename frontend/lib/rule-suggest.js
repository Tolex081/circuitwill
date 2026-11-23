// Rule suggestions from this CircuitWill's own payment history (step E of docs/RULE_BUILDER_RESEARCH.md).
//
// Pure (no DOM, no ethers, no network; tested by test/rule-suggest.test.mjs). Design choices against poisoning:
//   - opt-in: nothing runs until the owner presses the button, and everything is computed on the device;
//   - input is only the escrow's own Decision records (allowed payments: amount, proposer, recipient, time). Memos,
//     token names and anything else a stranger can write are never read;
//   - suggestions only ever tighten: a custom rule is ANDed with every other rule, and a limit is only suggested when
//     it is below the matching official limit already in force;
//   - recipients are never suggested. "Only trusted recipients" uses the owner's own trusted list, not addresses seen
//     in history;
//   - a minimum amount of history is required, so one or two planted payments cannot shape a suggestion;
//   - every suggestion is a rule form that goes through the same read-back, examples and confirmation as any rule.

import { validateRule, formatCents } from './rule-compiler.js';

export const MIN_PAYMENTS = 8;
export const MIN_DAYS = 5;
export const WINDOW_DAYS = 60;

const UNITS_PER_CENT = 10000n;
const big = (v) => BigInt(v ?? 0);

/// Rounds a cent amount up to a "nice" limit with headroom: x1.2, then up to 1, 2, 2.5 or 5 times a power of ten.
export function niceLimit(cents) {
  const want = (big(cents) * 12n + 9n) / 10n;
  if (want <= 100n) return 100n; // at least 1 USDT0
  let p = 1n;
  while (p * 10n <= want) p *= 10n;
  for (const m of [10n, 20n, 25n, 50n, 100n]) {
    const v = (p * m) / 10n;
    if (v >= want) return v;
  }
  return p * 10n;
}

const moneyText = (cents) => formatCents(cents).replace(/\.00$/, '').replace(/,/g, '');

/// decisions: [{ decision: { allowed, action, proposer, to, amount, day }, time? }]
/// info: { agent, dailyCap, circuits: [{ kind }] }; payees: [{ p, saved }]; now: seconds; tz: minutes east of UTC.
export function suggestRules({ decisions = [], info = {}, payees = [], now = Math.floor(Date.now() / 1000), tz = 0 } = {}) {
  const today = Math.floor(Number(now) / 86400);
  const recent = decisions
    .map((r) => r.decision ? { ...r.decision, time: r.time } : null)
    .filter((x) => x && x.allowed && big(x.amount) > 0n && Number(x.day) >= today - WINDOW_DAYS);
  const days = new Set(recent.map((x) => Number(x.day)));
  if (recent.length < MIN_PAYMENTS || days.size < MIN_DAYS) {
    return { suggestions: [], reason: `Not enough history yet: suggestions need at least ${MIN_PAYMENTS} payments on ${MIN_DAYS} different days in the last ${WINDOW_DAYS} days (this CircuitWill has ${recent.length} on ${days.size}).`, basis: '' };
  }

  // Whose payments: the AI helper's when it made most of them, else everyone's.
  const isAgent = (x) => info.agent && x.proposer && x.proposer.toLowerCase() === String(info.agent).toLowerCase();
  const agentPays = recent.filter(isAgent);
  const forAgent = agentPays.length >= MIN_PAYMENTS && new Set(agentPays.map((x) => Number(x.day))).size >= MIN_DAYS;
  const set = forAgent ? agentPays : recent;
  const appliesTo = forAgent ? ['agent'] : ['owner', 'agent', 'beneficiary'];
  const who = forAgent ? 'your AI helper' : 'anyone';
  const out = [];
  const add = (text, conditions) => {
    const rule = { v: 1, tz, appliesTo, anyOf: [{ allOf: conditions }] };
    try {
      out.push({ text, rule: validateRule(rule) });
    } catch {
      /* not expressible: skip */
    }
  };

  const centsOf = (x) => (big(x.amount) + UNITS_PER_CENT - 1n) / UNITS_PER_CENT;
  const capCents = info.circuits?.some((c) => Number(c.kind) === 1) ? big(info.dailyCap) / UNITS_PER_CENT : null;

  // Daily total (all spending counts towards the escrow-wide fact).
  const perDay = new Map();
  for (const x of recent) perDay.set(Number(x.day), (perDay.get(Number(x.day)) ?? 0n) + centsOf(x));
  const maxDay = [...perDay.values()].reduce((a, v) => (v > a ? v : a), 0n);
  const dayLimit = niceLimit(maxDay);
  if (capCents == null || dayLimit < capCents) {
    add(`Your busiest day was ${moneyText(maxDay)} USDT0. Limit ${who} to ${moneyText(dayLimit)} USDT0 a day.`, [{ fact: 'spent_day', max: moneyText(dayLimit) }]);
  }

  // Largest single payment.
  const maxPay = set.reduce((a, x) => (centsOf(x) > a ? centsOf(x) : a), 0n);
  const payLimit = niceLimit(maxPay);
  if ((capCents == null || payLimit < capCents) && payLimit < dayLimit) {
    add(`The largest payment ${forAgent ? 'your AI helper made' : 'was'} ${moneyText(maxPay)} USDT0. Limit each payment by ${who} to ${moneyText(payLimit)} USDT0.`, [{ fact: 'amount', max: moneyText(payLimit) }]);
  }

  // Only trusted recipients: every recent payment went to someone on the owner's trusted list today.
  const trusted = new Set(payees.filter((p) => p.saved).map((p) => String(p.p).toLowerCase()));
  if (trusted.size && set.every((x) => trusted.has(String(x.to).toLowerCase()))) {
    add(`Every recent payment went to someone you trust. Only let ${who} pay trusted recipients.`, [{ fact: 'payee_trusted', is: true }]);
  }

  // Days and hours (needs block times; local time at a fixed offset).
  const timed = set.filter((x) => x.time != null);
  if (timed.length >= MIN_PAYMENTS) {
    const local = timed.map((x) => {
      const m = Math.floor((Number(x.time) + tz * 60) / 60);
      const dayIdx = ((Math.floor(m / 1440) % 7) + 3 + 7) % 7; // 1970-01-01 was a Thursday (Monday = 0)
      return { day: dayIdx, minute: ((m % 1440) + 1440) % 1440 };
    });
    const dset = [...new Set(local.map((l) => l.day))].sort((a, b) => a - b);
    const first = Math.min(...local.map((l) => l.minute));
    const last = Math.max(...local.map((l) => l.minute));
    const from = Math.max(0, Math.floor(first / 60) * 60 - 60);
    const to = Math.min(1440, Math.ceil((last + 1) / 60) * 60 + 60);
    const weekdaysOnly = dset.every((x) => x <= 4);
    const days = weekdaysOnly ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6];
    if (weekdaysOnly || to - from <= 16 * 60) {
      const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const when = `${weekdaysOnly ? 'on weekdays' : 'every day'}${to - from < 1440 ? ` between ${hh(from)} and ${hh(to)}` : ''}`;
      add(`Payments ${forAgent ? 'by your AI helper ' : ''}only happened ${when}. Allow ${who} to pay only then.`, [{ fact: 'time', windows: [{ days, from: hh(from), to: hh(to) }] }]);
    }
  }

  return {
    suggestions: out,
    reason: out.length ? '' : 'Your history doesn’t suggest a limit tighter than the rules you already have.',
    basis: `${recent.length} allowed payments on ${days.size} days in the last ${WINDOW_DAYS} days`,
  };
}
