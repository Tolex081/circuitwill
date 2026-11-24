import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANGE } from '../lib/meta.js';
import { isLoosening, describeChange, changeTiming, durationText, queueNotice, APPLY_WINDOW_SECONDS } from '../lib/changes.js';

const cur = { dailyCap: 50_000_000n, trialLimit: 5_000_000n, coolingOffHours: 24n, confirmationThreshold: 20_000_000n, frozen: true, ruleDelay: 86400n };

test('isLoosening mirrors CircuitWillEscrow._requireNotLoosening (contracts/test/LooseningDelay.t.sol)', () => {
  assert.equal(isLoosening(CHANGE.DAILY_CAP, 40_000_000n, cur), false, 'lower cap: at once');
  assert.equal(isLoosening(CHANGE.DAILY_CAP, 50_000_000n, cur), false, 'equal: at once');
  assert.equal(isLoosening(CHANGE.DAILY_CAP, 50_000_001n, cur), true);
  assert.equal(isLoosening(CHANGE.TRIAL_LIMIT, 0n, cur), false);
  assert.equal(isLoosening(CHANGE.TRIAL_LIMIT, 5_000_001n, cur), true);
  assert.equal(isLoosening(CHANGE.COOLING_OFF_HOURS, 48n, cur), false, 'longer wait: at once');
  assert.equal(isLoosening(CHANGE.COOLING_OFF_HOURS, 23n, cur), true);
  assert.equal(isLoosening(CHANGE.CONFIRMATION_THRESHOLD, 1n, cur), false);
  assert.equal(isLoosening(CHANGE.CONFIRMATION_THRESHOLD, 20_000_001n, cur), true);
  assert.equal(isLoosening(CHANGE.SAVE_PAYEE, 0n, { payeeSaved: false }), true);
  assert.equal(isLoosening(CHANGE.SAVE_PAYEE, 0n, { payeeSaved: true }), false);
  assert.equal(isLoosening(CHANGE.UNFREEZE, 0n, cur), true);
  assert.equal(isLoosening(CHANGE.UNFREEZE, 0n, { ...cur, frozen: false }), false);
  assert.equal(isLoosening(CHANGE.RULE_DELAY, 2n * 86400n, cur), false);
  assert.equal(isLoosening(CHANGE.RULE_DELAY, 3600n, cur), true);
  assert.equal(isLoosening(CHANGE.DETACH_CIRCUIT, 1n, cur), true);
  assert.equal(isLoosening(CHANGE.BENEFICIARY, 0n, cur), true);
  // A new AI helper waits only while some custom rule limits the owner but not the helper; removing one never waits.
  const helper = '0x00000000000000000000000000000000000000a1';
  assert.equal(isLoosening(CHANGE.AGENT, 0n, { ...cur, target: helper, ownerOnlyRule: true }), true);
  assert.equal(isLoosening(CHANGE.AGENT, 0n, { ...cur, target: helper, ownerOnlyRule: false }), false);
  assert.equal(isLoosening(CHANGE.AGENT, 0n, { ...cur, target: '0x0000000000000000000000000000000000000000', ownerOnlyRule: true }), false);
  assert.equal(isLoosening(CHANGE.AGENT, 0n, { ...cur, target: helper, ownerOnlyRule: true }, { live: false }), false);
});

test('setup mode (no circuit attached): nothing is delayed', () => {
  for (const k of Object.values(CHANGE)) assert.equal(isLoosening(k, 10n ** 12n, cur, { live: false }), false);
});

test('describeChange speaks plain English', () => {
  assert.equal(describeChange({ kind: CHANGE.DAILY_CAP, value: 80_000_000n }), 'Raise the daily limit to 80 USDT0');
  assert.equal(describeChange({ kind: CHANGE.UNFREEZE, value: 0n }), 'Unfreeze payments');
  assert.equal(describeChange({ kind: CHANGE.DETACH_CIRCUIT, value: 3n }, { circuitName: (u) => `Daily limit (#${u})` }), 'Turn off Daily limit (#3)');
  assert.match(describeChange({ kind: CHANGE.SAVE_PAYEE, target: '0x1234567890123456789012345678901234567890' }), /^Trust 0x1234…7890$/);
  assert.equal(describeChange({ kind: CHANGE.RULE_DELAY, value: 3600n }), 'Shorten the waiting time for rule changes to 1 hour');
  assert.equal(describeChange({ kind: CHANGE.BENEFICIARY, target: '0x0000000000000000000000000000000000000000' }), 'Remove the beneficiary');
  assert.equal(describeChange({ kind: CHANGE.AGENT, target: '0x00000000000000000000000000000000000000a1' }), 'Name 0x0000…00a1 as AI helper');
  assert.equal(describeChange({ kind: CHANGE.AGENT, target: '0x0000000000000000000000000000000000000000' }), 'Remove the AI helper');
});

test('changeTiming: waiting, ready within 7 days, then expired (ChangeNotReady / ChangeExpired)', () => {
  const c = { eta: 1000n };
  assert.equal(changeTiming(c, 999).state, 'waiting');
  assert.equal(changeTiming(c, 1000).state, 'ready');
  assert.equal(changeTiming(c, 1000 + APPLY_WINDOW_SECONDS).state, 'ready');
  assert.equal(changeTiming(c, 1001 + APPLY_WINDOW_SECONDS).state, 'expired');
  assert.match(changeTiming({ eta: 86400n }, 0).text, /1 day/);
});

test('durationText and the queue notice', () => {
  assert.equal(durationText(86400), '1 day');
  assert.equal(durationText(90000), '1 day 1 hour');
  assert.equal(durationText(3 * 3600), '3 hours');
  assert.equal(durationText(120), '2 min');
  assert.match(queueNotice('Raise the daily limit to 80 USDT0', 86400n), /wait 1 day.*cancel/s);
});
