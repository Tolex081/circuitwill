// "Tightening is instant, loosening waits": the page side of CircuitWillEscrow's loosening delay.
//
// Pure functions (no DOM, no ethers; tested by test/changes.test.mjs). They mirror _requireNotLoosening and the
// setters' checks so the page can choose, before the wallet opens, between the direct setter (applies now) and
// queueChange (applies after ruleDelay). The contract still decides: if the page guesses wrong, the setter reverts
// with LooseningIsDelayed and nothing changes.

import { CHANGE } from './meta.js';
import { formatUsdt0 } from './units.js';

export const APPLY_WINDOW_SECONDS = 7 * 24 * 3600;

const big = (v) => BigInt(v ?? 0);
const money = (v) => formatUsdt0(v).replace(/\.?0+$/, '');
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

/// True when the contract would refuse this change as an instant setter call. `live` = at least one circuit is
/// attached (before that the escrow is in setup, every transfer is blocked, and every change applies at once).
/// `cur` holds the current values: dailyCap, trialLimit, coolingOffHours, confirmationThreshold, frozen, ruleDelay,
/// `payeeSaved` for SAVE_PAYEE, and for AGENT `target` (the new helper) and `ownerOnlyRule` (some custom rule limits
/// the owner but not the helper, so a new helper would escape it).
export function isLoosening(kind, value, cur, { live = true } = {}) {
  if (!live) return false;
  switch (kind) {
    case CHANGE.DAILY_CAP:
      return big(value) > big(cur.dailyCap);
    case CHANGE.TRIAL_LIMIT:
      return big(value) > big(cur.trialLimit);
    case CHANGE.COOLING_OFF_HOURS:
      return big(value) < big(cur.coolingOffHours);
    case CHANGE.CONFIRMATION_THRESHOLD:
      return big(value) > big(cur.confirmationThreshold);
    case CHANGE.SAVE_PAYEE:
      return !cur.payeeSaved;
    case CHANGE.UNFREEZE:
      return !!cur.frozen;
    case CHANGE.RULE_DELAY:
      return big(value) < big(cur.ruleDelay);
    case CHANGE.AGENT:
      return !!cur.ownerOnlyRule && !!cur.target && !/^0x0{40}$/i.test(cur.target);
    case CHANGE.DETACH_CIRCUIT:
    case CHANGE.BENEFICIARY:
      return true; // removing a circuit or naming a beneficiary always waits
    default:
      return true;
  }
}

/// "24 hours", "3 days", "1 day 6 hours", "45 min".
export function durationText(seconds) {
  let s = Math.max(0, Math.round(Number(seconds)));
  if (s < 3600) return `${Math.max(1, Math.ceil(s / 60))} min`;
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s - h * 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`);
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (!d && m) parts.push(`${m} min`);
  return parts.join(' ') || '0 min';
}

/// One waiting change in plain English. `circuitName(uid)` names the circuit a DETACH_CIRCUIT targets.
export function describeChange(c, { circuitName = (uid) => `rule #${uid}` } = {}) {
  const v = big(c.value);
  switch (Number(c.kind)) {
    case CHANGE.DAILY_CAP:
      return `Raise the daily limit to ${money(v)} USDT0`;
    case CHANGE.TRIAL_LIMIT:
      return `Let new recipients receive up to ${money(v)} USDT0`;
    case CHANGE.COOLING_OFF_HOURS:
      return `Shorten the waiting time for new recipients to ${v} hours`;
    case CHANGE.CONFIRMATION_THRESHOLD:
      return `Require approval only above ${money(v)} USDT0`;
    case CHANGE.SAVE_PAYEE:
      return `Trust ${shortAddr(c.target)}`;
    case CHANGE.UNFREEZE:
      return 'Unfreeze payments';
    case CHANGE.DETACH_CIRCUIT:
      return `Turn off ${circuitName(v)}`;
    case CHANGE.RULE_DELAY:
      return `Shorten the waiting time for rule changes to ${durationText(v)}`;
    case CHANGE.BENEFICIARY:
      return c.target && !/^0x0{40}$/i.test(c.target) ? `Name ${shortAddr(c.target)} as beneficiary` : 'Remove the beneficiary';
    case CHANGE.AGENT:
      return c.target && !/^0x0{40}$/i.test(c.target) ? `Name ${shortAddr(c.target)} as AI helper` : 'Remove the AI helper';
    default:
      return `Unknown change (${c.kind})`;
  }
}

/// Where a queued change stands at time `now` (seconds): waiting, ready to apply, or expired.
export function changeTiming(c, now, { applyWindow = APPLY_WINDOW_SECONDS } = {}) {
  const eta = Number(c.eta);
  const t = Number(now);
  if (t < eta) return { state: 'waiting', text: `Can be applied in ${durationText(eta - t)}` };
  if (t > eta + applyWindow) return { state: 'expired', text: 'Expired: it was not applied within 7 days. Cancel it and queue it again if you still want it.' };
  return { state: 'ready', text: `Ready. Apply it within ${durationText(eta + applyWindow - t)}.` };
}

/// The confirmation shown before queueing a loosening change.
export function queueNotice(description, ruleDelaySeconds) {
  return (
    `${description} loosens your rules, so it can't happen straight away. ` +
    `It will wait ${durationText(ruleDelaySeconds)}, then you apply it from "Waiting changes" on the Rules tab. ` +
    'Until then the current rule keeps applying, and you can cancel it at any time. This protects you if someone gets hold of your key.'
  );
}
