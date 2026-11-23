// Plain English for custom rules: the read-back the owner confirms, the short on-chain text, and example payments
// right at each limit. Pure (no DOM, no ethers; tested by test/rule-english.test.mjs).
//
// The English is generated from the validated rule form, never typed by an AI, so what the owner reads is what the
// circuit checks. Example answers come from two independent places: the reference interpreter (evaluateRule) and the
// compiled netlist (runNetlist on packFacts). The page shows both and flags any disagreement.

import {
  validateRule, evaluateRule, packFacts, runNetlist, windowSlots, parseCents, formatCents, formatTz, ROLES, DAY_NAMES, SLOTS_PER_WEEK,
} from './rule-compiler.js';

export const MAX_RULE_TEXT_BYTES = 280;

const WHO = { owner: 'you (the owner)', agent: 'your AI helper', beneficiary: 'your beneficiary' };
const WHO_SHORT = { owner: 'owner', agent: 'AI helper', beneficiary: 'beneficiary' };
const money = (cents) => `${formatCents(cents).replace(/\.00$/, '')} USDT0`;

export function listText(items, word = 'and') {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} ${word} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`;
}

/// [0,1,2,3,4] -> 'Monday to Friday'; [5,6] -> 'Saturday and Sunday'; [0,2,4] -> 'Monday, Wednesday and Friday'.
export function daysText(days) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return 'every day';
  const run = d.length >= 3 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return run ? `${DAY_NAMES[d[0]]} to ${DAY_NAMES[d.at(-1)]}` : listText(d.map((x) => DAY_NAMES[x]));
}

function hoursText(h) {
  if (h % 24 === 0 && h >= 48) return `${h} hours (${h / 24} days)`;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/// One condition as a phrase that completes "allowed only when …".
export function conditionText(c, tz = 0) {
  switch (c.fact) {
    case 'amount':
      return `the payment is at most ${money(parseCents(c.max))}`;
    case 'spent_day':
      return `total spending today (UTC day), counting this payment, stays at or below ${money(parseCents(c.max))}`;
    case 'spent_7d':
      return `total spending over the last 7 days, counting this payment, stays at or below ${money(parseCents(c.max))}`;
    case 'spent_month':
      return `total spending this calendar month (UTC), counting this payment, stays at or below ${money(parseCents(c.max))}`;
    case 'balance_after':
      return `at least ${money(parseCents(c.min))} is left in the CircuitWill afterwards`;
    case 'count_day':
      return `it is payment number ${c.max} or lower today (UTC day)`;
    case 'payee_age_hours':
      return `the recipient was added to your list at least ${hoursText(c.min)} ago`;
    case 'checkin_age_hours':
      return 'min' in c
        ? `you (the owner) have not checked in for at least ${hoursText(c.min)}`
        : `you (the owner) checked in within the last ${hoursText(c.max)}`;
    case 'payee_trusted':
      return c.is ? 'the recipient is on your trusted list' : 'the recipient is not on your trusted list';
    case 'payee_known':
      return c.is ? 'the recipient is on your list (trusted or new)' : 'the recipient is not on your list';
    case 'payee_paid_before':
      return c.is ? 'the recipient has been paid from this CircuitWill before' : 'the recipient has never been paid from this CircuitWill';
    case 'confirmed':
      return c.is ? 'you approved this exact payment first' : 'the payment is not pre-approved';
    case 'is_withdrawal':
      return c.is ? 'it is a withdrawal' : 'it is a payment (not a withdrawal)';
    case 'caller':
      return `it is sent by ${listText(c.in.map((r) => WHO[r]), 'or')}`;
    case 'time': {
      const parts = c.windows.map((w) => `${daysText(w.days)} from ${w.from} to ${w.to}`);
      return `it is sent ${listText(parts, 'or')} (${formatTz(tz)}, no daylight saving)`;
    }
    default:
      return c.fact;
  }
}

/// The full read-back: { who, sentence, groups: [[phrase, ...], ...], notes: [...] }.
export function describeRule(rule) {
  const r = validateRule(rule);
  const who = listText(r.appliesTo.map((p) => WHO[p]));
  const groups = r.anyOf.map((g) => g.allOf.map((c) => conditionText(c, r.tz)));
  const sentence =
    groups.length === 1
      ? `Payments and withdrawals by ${who} are allowed only when ${listText(groups[0])}.`
      : `Payments and withdrawals by ${who} are allowed only when one of these is true: ${groups.map((g, i) => `(${i + 1}) ${listText(g)}`).join('; ')}.`;
  const notes = [];
  const facts = new Set(r.anyOf.flatMap((g) => g.allOf.map((c) => c.fact)));
  if (['spent_day', 'spent_7d', 'spent_month', 'count_day'].some((f) => facts.has(f))) {
    notes.push('Spending totals and payment counts include every payment from this CircuitWill, yours too, not just the limited person’s.');
  }
  if (facts.has('time')) notes.push(`Times are ${formatTz(r.tz)} all year. Clocks that change for summer time are not followed.`);
  if (facts.has('checkin_age_hours')) notes.push('Check in from the Rules tab to restart the check-in clock.');
  if (r.appliesTo.includes('beneficiary')) notes.push('A beneficiary must also be named on the Rules tab; naming one waits like any loosening change.');
  const others = Object.keys(ROLES).filter((p) => !r.appliesTo.includes(p));
  if (others.length) notes.push(`This rule does not limit ${listText(others.map((p) => WHO[p]))}. Your other rules still apply to everyone.`);
  notes.push('This rule only adds limits. It can never allow a payment that another rule blocks.');
  return { who, sentence, groups, notes };
}

function utf8Bytes(s) {
  return new TextEncoder().encode(s).length;
}

/// The short description stored on chain with the rule (at most 280 bytes). Informative only: the specHash next to it
/// commits to the exact rule.
export function shortRuleText(rule) {
  const r = validateRule(rule);
  const who = r.appliesTo.map((p) => WHO_SHORT[p]).join('/');
  const bit = (c) => {
    switch (c.fact) {
      case 'amount': return `each ≤${money(parseCents(c.max))}`;
      case 'spent_day': return `day ≤${money(parseCents(c.max))}`;
      case 'spent_7d': return `7 days ≤${money(parseCents(c.max))}`;
      case 'spent_month': return `month ≤${money(parseCents(c.max))}`;
      case 'balance_after': return `keep ≥${money(parseCents(c.min))}`;
      case 'count_day': return `≤${c.max} payments/day`;
      case 'payee_age_hours': return `recipient added ≥${c.min}h ago`;
      case 'checkin_age_hours': return 'min' in c ? `no owner check-in for ≥${c.min}h` : `owner checked in ≤${c.max}h ago`;
      case 'payee_trusted': return c.is ? 'trusted recipients' : 'untrusted recipients';
      case 'payee_known': return c.is ? 'listed recipients' : 'unlisted recipients';
      case 'payee_paid_before': return c.is ? 'paid-before recipients' : 'never-paid recipients';
      case 'confirmed': return c.is ? 'owner-approved' : 'not pre-approved';
      case 'is_withdrawal': return c.is ? 'withdrawals' : 'payments only';
      case 'caller': return `by ${c.in.map((x) => WHO_SHORT[x]).join('/')}`;
      case 'time': return `${c.windows.map((w) => `${daysText(w.days)} ${w.from}-${w.to}`).join(' or ')} ${formatTz(r.tz)}`;
      default: return c.fact;
    }
  };
  let text = `${who}: ${r.anyOf.map((g) => g.allOf.map(bit).join(', ')).join(' OR ')}`;
  if (utf8Bytes(text) > MAX_RULE_TEXT_BYTES) {
    while (utf8Bytes(text + '…') > MAX_RULE_TEXT_BYTES) text = text.slice(0, -1);
    text += '…';
  }
  return text;
}

// ------------------------------------------------------------------ example payments at each limit

/// Facts that pass every condition of `group` for a payment by `role` (values chosen well inside each limit).
function passingFacts(group, role, tz) {
  const f = {
    amount_c: 100n, spent_day_after_c: 100n, spent_7d_after_c: 100n, spent_month_after_c: 100n, balance_after_c: 1_000_000n,
    count_day_after: 1n, slot_of_week_utc: 0n, payee_trusted: true, payee_known: true, payee_paid_before: true,
    payee_age_hours: 10_000n, checkin_age_hours: 1n, caller_role: BigInt(ROLES[role]), confirmed: true, is_withdrawal: false,
  };
  for (const c of group.allOf) {
    switch (c.fact) {
      case 'amount': case 'spent_day': case 'spent_7d': case 'spent_month': {
        const k = parseCents(c.max);
        const v = k > 1n ? k / 2n : 1n;
        const field = { amount: 'amount_c', spent_day: 'spent_day_after_c', spent_7d: 'spent_7d_after_c', spent_month: 'spent_month_after_c' }[c.fact];
        if (f[field] > v) f[field] = v;
        break;
      }
      case 'balance_after': { const k = parseCents(c.min); if (f.balance_after_c < k) f.balance_after_c = k * 2n; break; }
      case 'count_day': f.count_day_after = 1n; break;
      case 'payee_age_hours': if (f.payee_age_hours < BigInt(c.min)) f.payee_age_hours = BigInt(c.min); break;
      case 'checkin_age_hours': f.checkin_age_hours = 'min' in c ? BigInt(c.min) + 1n : 0n; break;
      case 'payee_trusted': f.payee_trusted = c.is; if (c.is) f.payee_known = true; break;
      case 'payee_known': f.payee_known = c.is; if (!c.is) { f.payee_trusted = false; f.payee_paid_before = false; f.payee_age_hours = 0n; } break;
      case 'payee_paid_before': f.payee_paid_before = c.is; break;
      case 'confirmed': f.confirmed = c.is; break;
      case 'is_withdrawal': f.is_withdrawal = c.is; break;
      case 'time': { const s = windowSlots(c.windows, tz).indexOf(1); if (s >= 0) f.slot_of_week_utc = BigInt(s); break; }
      default: break;
    }
  }
  // Keep the spending totals consistent: a total is never below this payment.
  for (const k of ['spent_day_after_c', 'spent_7d_after_c', 'spent_month_after_c']) if (f[k] < f.amount_c) f.amount_c = f[k];
  return f;
}

/// UTC slot of the week -> 'Friday 21:00' in the rule's local time.
export function slotLocalText(slot, tz) {
  const m = (((slot * 15 + tz) % 10080) + 10080) % 10080;
  const d = Math.floor(m / 1440);
  const t = m % 1440;
  return `${DAY_NAMES[d]} ${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function variants(c, base, tz) {
  const out = [];
  const set = (patch, label) => out.push({ facts: { ...base, ...patch }, label });
  switch (c.fact) {
    case 'amount': {
      const k = parseCents(c.max);
      const at = { amount_c: k, spent_day_after_c: k > base.spent_day_after_c ? k : base.spent_day_after_c };
      set({ ...at, spent_7d_after_c: at.spent_day_after_c, spent_month_after_c: at.spent_day_after_c }, `A payment of exactly ${money(k)}`);
      set({ amount_c: k + 1n, spent_day_after_c: k + 1n, spent_7d_after_c: k + 1n, spent_month_after_c: k + 1n }, `A payment of ${money(k + 1n)}`);
      break;
    }
    case 'spent_day': case 'spent_7d': case 'spent_month': {
      const k = parseCents(c.max);
      const field = { spent_day: 'spent_day_after_c', spent_7d: 'spent_7d_after_c', spent_month: 'spent_month_after_c' }[c.fact];
      const what = { spent_day: 'today', spent_7d: 'over the last 7 days', spent_month: 'this month' }[c.fact];
      // Wider windows include narrower ones: a 7-day total is at least today's total.
      const lift = (v) => {
        const p = { [field]: v };
        if (c.fact !== 'spent_day' && base.spent_day_after_c > v) p.spent_day_after_c = v;
        if (c.fact === 'spent_day') { p.spent_7d_after_c = v > base.spent_7d_after_c ? v : base.spent_7d_after_c; p.spent_month_after_c = v > base.spent_month_after_c ? v : base.spent_month_after_c; }
        if (c.fact === 'spent_7d' && base.spent_month_after_c < v) p.spent_month_after_c = v;
        if (base.amount_c > v) p.amount_c = v;
        return p;
      };
      set(lift(k), `Spending ${what} reaches exactly ${money(k)} with this payment`);
      set(lift(k + 1n), `Spending ${what} reaches ${money(k + 1n)} with this payment`);
      break;
    }
    case 'balance_after': {
      const k = parseCents(c.min);
      set({ balance_after_c: k }, `Exactly ${money(k)} would be left afterwards`);
      if (k > 0n) set({ balance_after_c: k - 1n }, `${money(k - 1n)} would be left afterwards`);
      break;
    }
    case 'count_day':
      set({ count_day_after: BigInt(c.max) }, `Payment number ${c.max} today`);
      set({ count_day_after: BigInt(c.max) + 1n }, `Payment number ${c.max + 1} today`);
      break;
    case 'payee_age_hours':
      set({ payee_age_hours: BigInt(c.min), payee_known: true }, `A recipient added exactly ${c.min} h ago`);
      set({ payee_age_hours: BigInt(c.min - 1), payee_known: true }, `A recipient added ${c.min - 1} h ago`);
      break;
    case 'checkin_age_hours':
      if ('min' in c) {
        set({ checkin_age_hours: BigInt(c.min) }, `Your last check-in was exactly ${c.min} h ago`);
        set({ checkin_age_hours: BigInt(c.min - 1) }, `Your last check-in was ${c.min - 1} h ago`);
      } else {
        set({ checkin_age_hours: BigInt(c.max) }, `Your last check-in was exactly ${c.max} h ago`);
        set({ checkin_age_hours: BigInt(c.max + 1) }, `Your last check-in was ${c.max + 1} h ago`);
      }
      break;
    case 'payee_trusted':
      set({ payee_trusted: !c.is, ...(c.is ? {} : { payee_known: true }) }, c.is ? 'A recipient who is not trusted' : 'A trusted recipient');
      break;
    case 'payee_known':
      set(c.is ? { payee_known: false, payee_trusted: false, payee_paid_before: false, payee_age_hours: 0n } : { payee_known: true }, c.is ? 'A recipient who is not on your list' : 'A recipient on your list');
      break;
    case 'payee_paid_before':
      set({ payee_paid_before: !c.is }, c.is ? 'A recipient never paid before' : 'A recipient paid before');
      break;
    case 'confirmed':
      set({ confirmed: !c.is }, c.is ? 'A payment you did not approve' : 'A payment you approved');
      break;
    case 'is_withdrawal':
      set({ is_withdrawal: !c.is }, c.is ? 'A payment (not a withdrawal)' : 'A withdrawal');
      break;
    case 'time': {
      const slots = windowSlots(c.windows, tz);
      // The last allowed slot of the first window and the first slot after it: the edge people ask about.
      const first = slots.indexOf(1);
      let last = first;
      while (last + 1 < SLOTS_PER_WEEK && slots[last + 1]) last++;
      const after = slots.indexOf(0, last);
      if (first >= 0) set({ slot_of_week_utc: BigInt(last) }, `Sent at ${slotLocalText(last, tz)}`);
      if (after >= 0) set({ slot_of_week_utc: BigInt(after) }, `Sent at ${slotLocalText(after, tz)}`);
      break;
    }
    default:
      break;
  }
  return out;
}

/// Example payments right at each limit: [{ label, facts, expected, circuit }], where `expected` is the reference
/// interpreter's answer and `circuit` the compiled netlist's (null when no netlist is given). Also one payment by a
/// person the rule does not limit, when there is one.
export function boundaryExamples(rule, compiled = null) {
  const r = validateRule(rule);
  const role = r.appliesTo[0];
  const group = r.anyOf[0];
  const caller = group.allOf.find((c) => c.fact === 'caller');
  const actor = caller ? (caller.in.find((p) => r.appliesTo.includes(p)) ?? role) : role;
  const base = passingFacts(group, actor, r.tz);
  const rows = [{ label: `A small, ordinary payment by ${WHO[actor]}`, facts: base }];
  for (const c of group.allOf) rows.push(...variants(c, base, r.tz));
  const outsider = Object.keys(ROLES).find((p) => !r.appliesTo.includes(p));
  if (outsider) rows.push({ label: `Any payment by ${WHO[outsider]} (not limited by this rule)`, facts: { ...base, caller_role: BigInt(ROLES[outsider]) } });
  return rows.map((row) => {
    const expected = evaluateRule(r, row.facts);
    let circuit = null;
    if (compiled?.gates) circuit = runNetlist(compiled.gates, packFacts(row.facts));
    return { label: row.label, facts: row.facts, expected, circuit, agrees: circuit == null || circuit === expected };
  });
}
