// Payment preview ("vibe check"): what the attached circuits would answer for a payment that has not been sent yet.
//
// Explanation only. The page never decides: when the payment is sent, the escrow builds the inputs from on-chain state
// at that moment and the circuits on X Layer decide. This module mirrors that work in the browser so a person can see
// the likely answer before pressing Send. It never blocks sending and never stands in for the recorded decision.
//
// Pure parts (no DOM, no ethers; tested by test/preview.test.mjs):
//   - time rules copied from CircuitWillEscrow: UTC day rollover of spentToday (_execute / currentSpentToday), whole
//     hours of payee age with saturation at 65535 (_ageHours), confirmation validity (_confirmationFor);
//   - input packing copied from contracts/src/libraries/*Packing.sol (bit-for-bit, out-of-range values rejected);
//   - simulate(): evaluates each attached circuit's netlist on those bytes (TAP-02, lib/xray.js) and combines the
//     statuses like _execute (reason priority from _worse, then the balance check);
//   - plain-English wording for each rule's answer and for the verdict line.

import { STATUS, KIND, REASON, reasonFromStatuses } from './meta.js';
import { formatUsdt0, UINT32_MAX, UINT16_MAX } from './units.js';
import { evaluate, outputBits, bytesToHex } from './xray.js';

export const SECONDS_PER_DAY = 86400;
export const SECONDS_PER_HOUR = 3600;
/// Within this many seconds of a time limit (midnight UTC, a waiting time ending, an approval expiring) the answer
/// may change before the transaction lands, so the preview says so.
export const CLOSE_CALL_SECONDS = 120;

const big = (v) => BigInt(v ?? 0);

// ------------------------------------------------------------------ time rules (CircuitWillEscrow)

/// UTC day number, `block.timestamp / 86400` (_today).
export const dayOf = (now) => big(now) / BigInt(SECONDS_PER_DAY);

/// spentToday as the next decision sees it: reset to 0 when the UTC day changed since lastResetDay (_execute).
export function spentBefore({ spentToday, lastResetDay, now }) {
  return dayOf(now) === big(lastResetDay) ? big(spentToday) : 0n;
}

/// Whole hours since the payee was first added; 0 for an unknown payee (firstSeen 0); saturates at 65535 (_ageHours).
export function ageHours({ firstSeen, now }) {
  const f = big(firstSeen);
  if (f === 0n) return 0n;
  const n = big(now);
  const age = n > f ? (n - f) / BigInt(SECONDS_PER_HOUR) : 0n;
  return age > UINT16_MAX ? UINT16_MAX : age;
}

/// A confirmation counts when it exists, has not expired and was given by the current controller (_confirmationFor).
export function isConfirmed({ expiresAt, confirmedBy, controller, now }) {
  const e = big(expiresAt);
  return e !== 0n && big(now) <= e && !!confirmedBy && !!controller && confirmedBy.toLowerCase() === controller.toLowerCase();
}

// ------------------------------------------------------------------ packing (contracts/src/libraries/*Packing.sol)

function leBytes(word, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Number((word >> BigInt(8 * i)) & 0xffn);
  return out;
}
const fits = (v, max) => v >= 0n && v <= max;

/// DailyCapPacking.pack: amount | spent_today | daily_cap, uint32 little-endian each, 12 bytes. null if out of range.
export function packDailyCap(amount, spentToday, dailyCap) {
  const [a, s, c] = [big(amount), big(spentToday), big(dailyCap)];
  if (!fits(a, UINT32_MAX) || !fits(s, UINT32_MAX) || !fits(c, UINT32_MAX)) return null;
  return leBytes(a | (s << 32n) | (c << 64n), 12);
}

/// PayeeWhitelistPacking.pack: is_saved | age_hours<<1 | amount<<17 | trial_limit<<49 | cooling_off_hours<<81, 13 bytes.
export function packPayeeWhitelist(isSaved, ageHoursValue, amount, trialLimit, coolingOffHours) {
  const [h, a, t, c] = [big(ageHoursValue), big(amount), big(trialLimit), big(coolingOffHours)];
  if (!fits(h, UINT16_MAX) || !fits(a, UINT32_MAX) || !fits(t, UINT32_MAX) || !fits(c, UINT16_MAX)) return null;
  return leBytes((isSaved ? 1n : 0n) | (h << 1n) | (a << 17n) | (t << 49n) | (c << 81n), 13);
}

/// ConfirmationPacking.pack: amount | threshold<<32 | confirmed<<64, 9 bytes.
export function packConfirmation(amount, threshold, confirmed) {
  const [a, t] = [big(amount), big(threshold)];
  if (!fits(a, UINT32_MAX) || !fits(t, UINT32_MAX)) return null;
  return leBytes(a | (t << 32n) | ((confirmed ? 1n : 0n) << 64n), 9);
}

/// FreezePacking.pack: one byte, 0x01 when frozen.
export function packFreeze(frozen) {
  return Uint8Array.of(frozen ? 1 : 0);
}

/// Input bytes for one circuit kind from the decision context, exactly as CircuitWillEscrow._evaluate builds them.
/// null = the escrow could not pack them (recorded as NOT_EVALUATED, which blocks with INPUT_OUT_OF_RANGE).
export function packFor(kind, ctx) {
  switch (Number(kind)) {
    case KIND.DAILY_CAP:
      return packDailyCap(ctx.amount, ctx.spentBefore, ctx.dailyCap);
    case KIND.WHITELIST:
      return packPayeeWhitelist(ctx.isSaved, ctx.ageHours, ctx.amount, ctx.trialLimit, ctx.coolingOffHours);
    case KIND.CONFIRMATION:
      return packConfirmation(ctx.amount, ctx.threshold, ctx.confirmed);
    case KIND.FREEZE:
      return packFreeze(ctx.frozen);
    case KIND.CUSTOM:
      // The facts word is read from the escrow itself (customFactsFor), so rolling totals and the calendar match.
      return ctx.customInput ?? null;
    default:
      return null; // the escrow cannot attach other kinds
  }
}

/// Everything the escrow would read for a payment of `amount` to `to`, from raw on-chain values and an estimate of
/// the block time it lands in. `raw` holds the escrow views: spentToday, lastResetDay, dailyCap, payee {firstSeen,
/// saved}, trialLimit, coolingOffHours, confirmationThreshold, confirmation {expiresAt, confirmedBy}, controller, frozen.
export function buildContext(raw, { amount, now }) {
  const payee = raw.payee ?? { firstSeen: 0n, saved: false };
  const cf = raw.confirmation ?? { expiresAt: 0n, confirmedBy: null };
  return {
    now: big(now),
    amount: big(amount),
    newDay: dayOf(now) !== big(raw.lastResetDay),
    spentBefore: spentBefore({ spentToday: raw.spentToday, lastResetDay: raw.lastResetDay, now }),
    dailyCap: big(raw.dailyCap),
    known: big(payee.firstSeen) !== 0n,
    firstSeen: big(payee.firstSeen),
    isSaved: !!payee.saved,
    ageHours: ageHours({ firstSeen: payee.firstSeen, now }),
    trialLimit: big(raw.trialLimit),
    coolingOffHours: big(raw.coolingOffHours),
    threshold: big(raw.confirmationThreshold),
    confirmed: isConfirmed({ expiresAt: cf.expiresAt, confirmedBy: cf.confirmedBy, controller: raw.controller, now }),
    confirmationExpiresAt: big(cf.expiresAt),
    frozen: !!raw.frozen,
  };
}

/// Time limits that fall within CLOSE_CALL_SECONDS of `now` and could flip the answer before the payment lands.
export function closeCalls(ctx, kinds) {
  const now = ctx.now;
  const near = (t) => t >= now && t - now <= BigInt(CLOSE_CALL_SECONDS);
  const out = [];
  if (kinds.includes(KIND.DAILY_CAP) && near((dayOf(now) + 1n) * BigInt(SECONDS_PER_DAY))) out.push('midnight');
  if (kinds.includes(KIND.WHITELIST) && ctx.known && !ctx.isSaved && ctx.ageHours < ctx.coolingOffHours) {
    if (near(ctx.firstSeen + ctx.coolingOffHours * BigInt(SECONDS_PER_HOUR))) out.push('waiting');
  }
  if (kinds.includes(KIND.CONFIRMATION) && ctx.confirmed && near(ctx.confirmationExpiresAt)) out.push('approval');
  return out;
}

// ------------------------------------------------------------------ simulation

/// What the attached circuits would answer. `circuits` are the escrow's attached circuits in index order
/// ({ kind, processor, circuitId, netlistHash }); `netlists[i]` is { gates, nIn, nOut, hash } read for circuit i
/// (hash = keccak256 of the netlist bytes; checked against the attached netlistHash). A circuit whose netlist could
/// not be read or does not match is reported as `unknown`, and then the verdict is unknown too.
export function simulate({ circuits, netlists, ctx, balance }) {
  const results = circuits.map((c, i) => {
    const kind = Number(c.kind);
    const base = { index: i, kind, processor: c.processor, circuitId: c.circuitId, netlistHash: c.netlistHash };
    const bytes = packFor(kind, ctx);
    if (!bytes) return { ...base, status: STATUS.NOT_EVALUATED, input: '0x', output: '0x', ok: false };
    const net = netlists?.[i];
    const input = bytesToHex(bytes);
    if (!net || !net.gates) return { ...base, status: null, input, output: '0x', ok: null, unknown: 'unreadable' };
    if (net.hash && c.netlistHash && net.hash.toLowerCase() !== c.netlistHash.toLowerCase()) {
      return { ...base, status: null, input, output: '0x', ok: null, unknown: 'changed' };
    }
    const sig = evaluate(net.gates, net.nIn, bytes, net.nOut ?? 1);
    const bit = outputBits(sig, net.nOut ?? 1)[0];
    return { ...base, status: bit === 1 ? STATUS.ALLOW : STATUS.DENY, input, output: bit === 1 ? '0x01' : '0x00', ok: bit === 1 };
  });
  const unknown = results.some((r) => r.status == null);
  let reason = unknown ? null : reasonFromStatuses(results.map((r) => r.status));
  // A beneficiary may spend only while some custom rule limits the beneficiary (appliesTo bit 4).
  if (reason === REASON.NONE && ctx.isBeneficiary && !circuits.some((c) => Number(c.kind) === KIND.CUSTOM && (Number(c.appliesTo ?? 0) & 4))) {
    reason = REASON.NO_CUSTOM_RULE;
  }
  if (reason === REASON.NONE && big(balance) < ctx.amount) reason = REASON.INSUFFICIENT_BALANCE;
  const allowed = reason == null ? null : reason === REASON.NONE;
  const spentAfter = allowed ? ctx.spentBefore + ctx.amount : ctx.spentBefore;
  const balanceAfter = allowed ? big(balance) - ctx.amount : big(balance);
  return { results, reason, allowed, spentBefore: ctx.spentBefore, spentAfter, balance: big(balance), balanceAfter };
}

// ------------------------------------------------------------------ plain English

/// 50000000n -> "50", 12500000n -> "12.5".
export const money = (v) => formatUsdt0(v).replace(/\.?0+$/, '');
const hoursText = (h) => `${h} h`;

/// A few words for why one circuit said no, read from its input bytes (the History list uses the same words).
/// `c` = { kind, status, fields } where fields are the decoded inputs (decodeCircuitInput) or null.
export function shortReasonFor(c) {
  if (c.status === STATUS.NOT_EVALUATED) return 'amount too large';
  if (c.status === STATUS.REVERTED || c.status === STATUS.MALFORMED_OUTPUT) return 'couldn’t run';
  const f = c.fields;
  switch (c.kind) {
    case KIND.DAILY_CAP:
      return 'over today’s limit';
    case KIND.WHITELIST:
      if (!f) return 'said no';
      if (f.amount > f.trialLimit) return f.trialLimit === 0n ? 'not a trusted recipient' : 'more than a new recipient can get';
      if (f.ageHours === 0n) return 'not on your list yet';
      return 'added too recently';
    case KIND.CONFIRMATION:
      return 'not approved';
    case KIND.FREEZE:
      return 'frozen';
    case KIND.CUSTOM:
      return 'your custom rule said no';
    default:
      return 'said no';
  }
}

/// Who approves, as the reader would say it: the owner reads "your approval", the AI helper "the owner’s approval".
const approval = (role) => (role === 'owner' ? 'your approval' : 'the owner’s approval');
const approver = (role) => (role === 'owner' ? 'You' : 'The owner');

/// One rule's answer in the preview, in the style of the History explanations but about a payment not sent yet.
export function explainPreview(r, ctx, { role = 'owner' } = {}) {
  if (r.status == null) {
    return {
      ok: null,
      text: r.unknown === 'changed'
        ? 'Can’t preview: the circuit read from the chain doesn’t match the one attached to this CircuitWill.'
        : 'Can’t preview: the circuit couldn’t be read from the chain right now.',
    };
  }
  if (r.status === STATUS.NOT_EVALUATED) return { ok: false, text: `Would not be checked: the amount is larger than the circuits can handle (at most ${formatUsdt0(UINT32_MAX)} USDT0).` };
  const ok = r.status === STATUS.ALLOW;
  switch (r.kind) {
    case KIND.DAILY_CAP: {
      const total = ctx.spentBefore + ctx.amount;
      return ok
        ? { ok, text: `Within the daily limit: this would make ${money(total)} of ${money(ctx.dailyCap)} USDT0 for the day.` }
        : { ok, text: `Today’s spending would reach ${money(total)} USDT0, over the ${money(ctx.dailyCap)} USDT0 daily limit (${money(ctx.spentBefore)} already spent).` };
    }
    case KIND.WHITELIST: {
      if (ctx.isSaved) return { ok, text: 'The recipient is trusted.' };
      const tooMuch = ctx.amount > ctx.trialLimit;
      const tooSoon = ctx.ageHours < ctx.coolingOffHours;
      if (ok) {
        const when = ctx.known ? `added ${hoursText(ctx.ageHours)} ago` : 'no waiting time is set';
        return { ok, text: `New recipient: within the ${money(ctx.trialLimit)} USDT0 limit for new people, and ${when}.` };
      }
      const parts = [];
      if (tooMuch) parts.push(ctx.trialLimit === 0n ? 'only trusted recipients can be paid' : `new recipients can receive at most ${money(ctx.trialLimit)} USDT0`);
      if (tooSoon) {
        parts.push(
          !ctx.known
            ? `new recipients must wait ${hoursText(ctx.coolingOffHours)} after being added, and this one isn’t on your list yet`
            : `new recipients must wait ${hoursText(ctx.coolingOffHours)} after being added (this one was added ${ctx.ageHours === 0n ? 'less than an hour' : hoursText(ctx.ageHours)} ago)`,
        );
      }
      return { ok, text: `The recipient isn’t trusted, and ${parts.join(', and ') || 'the rule would say no'}.` };
    }
    case KIND.CONFIRMATION:
      if (ok) return { ok, text: ctx.confirmed && ctx.amount > ctx.threshold ? `${approver(role)} approved this exact payment.` : `At or below the ${money(ctx.threshold)} USDT0 approval limit.` };
      return { ok, text: `Payments above ${money(ctx.threshold)} USDT0 need ${approval(role)} first, and this one isn’t approved yet.` };
    case KIND.FREEZE:
      return ok ? { ok, text: 'Not frozen.' } : { ok, text: 'This CircuitWill is frozen.' };
    case KIND.CUSTOM:
      return ok ? { ok, text: 'Your custom rule allows it.' } : { ok, text: 'Your custom rule doesn’t allow this payment.' };
    default:
      return { ok, text: ok ? 'Would say yes.' : 'Would say no.' };
  }
}

/// Why one rule would block, as the end of "This payment would be blocked: …".
function blockerPhrase(r, ctx, role) {
  if (r.status === STATUS.NOT_EVALUATED) return `the amount is larger than the circuits can handle (at most ${formatUsdt0(UINT32_MAX)} USDT0)`;
  switch (r.kind) {
    case KIND.DAILY_CAP:
      return `it would take today’s spending to ${money(ctx.spentBefore + ctx.amount)} USDT0, over the ${money(ctx.dailyCap)} USDT0 daily limit`;
    case KIND.WHITELIST:
      if (ctx.amount > ctx.trialLimit) {
        return ctx.trialLimit === 0n ? 'only trusted recipients can be paid' : `new recipients can receive at most ${money(ctx.trialLimit)} USDT0`;
      }
      return ctx.known
        ? `this recipient was added ${ctx.ageHours === 0n ? 'less than an hour' : hoursText(ctx.ageHours)} ago and new recipients wait ${hoursText(ctx.coolingOffHours)}`
        : `this recipient isn’t on your list yet, and new recipients wait ${hoursText(ctx.coolingOffHours)} after being added`;
    case KIND.CONFIRMATION:
      return `above ${money(ctx.threshold)} USDT0 it needs ${approval(role)} first`;
    case KIND.FREEZE:
      return 'this CircuitWill is frozen';
    case KIND.CUSTOM:
      return 'your custom rule doesn’t allow it';
    default:
      return 'a rule would say no';
  }
}

/// The one verdict line. Returns { tone: 'allow' | 'block' | 'unknown', text, approveOnly } where approveOnly means
/// the Approval rule is the only thing in the way (so the page can offer its approve action).
export function verdictFor(sim, ctx, { role = 'owner', ruleName = (k) => `Rule ${k}`, decode = () => null } = {}) {
  if (sim.allowed == null) return { tone: 'unknown', text: 'Can’t preview this payment right now: a circuit couldn’t be read. You can still send it; the blockchain decides.', approveOnly: false };
  if (sim.reason === REASON.NO_CUSTOM_RULE) return { tone: 'block', text: 'This payment would be blocked: a beneficiary can only spend under a custom rule that limits the beneficiary, and none is turned on.', approveOnly: false };
  if (sim.reason === REASON.NO_CIRCUITS) return { tone: 'block', text: 'This payment would be blocked: no rules are turned on, so nothing can be paid.', approveOnly: false };
  if (sim.allowed) return { tone: 'allow', text: 'This payment would go through: every rule says yes.', approveOnly: false };
  if (sim.reason === REASON.INSUFFICIENT_BALANCE) {
    return { tone: 'block', text: `This payment would be blocked: every rule says yes, but this CircuitWill holds only ${money(sim.balance)} USDT0.`, approveOnly: false };
  }
  // A freeze explains everything else, so it leads (as in History).
  const bad = sim.results.filter((r) => r.status !== STATUS.ALLOW).sort((a, b) => (b.kind === KIND.FREEZE) - (a.kind === KIND.FREEZE));
  const approveOnly = bad.length === 1 && bad[0].kind === KIND.CONFIRMATION && bad[0].status === STATUS.DENY;
  if (bad.length === 1) return { tone: 'block', text: `This payment would be blocked: ${blockerPhrase(bad[0], ctx, role)}.`, approveOnly };
  const list = bad.map((r) => `${ruleName(r.kind)} (${shortReasonFor({ kind: r.kind, status: r.status, fields: decode(r.kind, r.input) })})`);
  const joined = list.length === 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
  return { tone: 'block', text: `This payment would be blocked by ${joined}.`, approveOnly: false };
}
