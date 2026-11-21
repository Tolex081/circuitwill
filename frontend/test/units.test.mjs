import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsdt0,
  formatUsdt0,
  parseHours,
  parseEvalGasLimit,
  checkMemo,
  decodeCircuitInput,
  UINT32_MAX,
} from '../lib/units.js';
import { reasonFromStatuses, REASON, STATUS } from '../lib/meta.js';

test('parseUsdt0: exact 6-decimal parsing', () => {
  assert.equal(parseUsdt0('50'), 50_000_000n);
  assert.equal(parseUsdt0('0.000001'), 1n);
  assert.equal(parseUsdt0('12.5'), 12_500_000n);
  assert.equal(parseUsdt0('4294.967295'), UINT32_MAX);
  assert.equal(parseUsdt0('0', { allowZero: true }), 0n);
});

test('parseUsdt0: rejects values the circuits cannot take', () => {
  assert.throws(() => parseUsdt0('4294.967296'), /circuit limit/);
  assert.throws(() => parseUsdt0('5000'), /circuit limit/);
  assert.throws(() => parseUsdt0('0'), /greater than 0/);
  assert.throws(() => parseUsdt0('1.0000001'), /6 decimals/);
  assert.throws(() => parseUsdt0('-1'));
  assert.throws(() => parseUsdt0('1e6'));
  assert.throws(() => parseUsdt0(''));
});

test('formatUsdt0', () => {
  assert.equal(formatUsdt0(50_000_000n), '50.000000');
  assert.equal(formatUsdt0(UINT32_MAX), '4,294.967295');
  assert.equal(formatUsdt0(1n), '0.000001');
});

test('hours, eval gas limit and memo bounds', () => {
  assert.equal(parseHours('65535'), 65535n);
  assert.throws(() => parseHours('65536'));
  assert.equal(parseEvalGasLimit('100000'), 100000n);
  assert.throws(() => parseEvalGasLimit('99999'));
  assert.throws(() => parseEvalGasLimit('30000001'));
  assert.equal(checkMemo('x'.repeat(256)).length, 256);
  assert.throws(() => checkMemo('x'.repeat(257)));
  assert.throws(() => checkMemo('é'.repeat(129))); // 258 UTF-8 bytes
});

test('decodeCircuitInput: inputs recorded on the anvil fork', () => {
  // Daily Cap: amount 60, spent 10, cap 50 (USDT0 base units, uint32 LE)
  assert.deepEqual(decodeCircuitInput(1, '0x008793038096980080f0fa02'), { amount: 60_000_000n, spentToday: 10_000_000n, dailyCap: 50_000_000n });
  // Whitelist: saved, age 0, amount 10, trial 5, cooling-off 24
  assert.deepEqual(decodeCircuitInput(2, '0x0100002d310180969800300000'), {
    isSaved: 1n, ageHours: 0n, amount: 10_000_000n, trialLimit: 5_000_000n, coolingOffHours: 24n,
  });
  // Confirmation: amount 60, threshold 20, not confirmed
  assert.deepEqual(decodeCircuitInput(3, '0x00879303002d310100'), { amount: 60_000_000n, threshold: 20_000_000n, confirmed: 0n });
  assert.deepEqual(decodeCircuitInput(4, '0x01'), { frozen: 1n });
  assert.equal(decodeCircuitInput(1, '0x'), null);
});

test('reasonFromStatuses follows the escrow priority', () => {
  assert.equal(reasonFromStatuses([]), REASON.NO_CIRCUITS);
  assert.equal(reasonFromStatuses([STATUS.ALLOW, STATUS.ALLOW]), REASON.NONE);
  assert.equal(reasonFromStatuses([STATUS.DENY, STATUS.ALLOW]), REASON.CIRCUIT_DENIED);
  assert.equal(reasonFromStatuses([STATUS.DENY, STATUS.REVERTED]), REASON.EVAL_FAILED);
  assert.equal(reasonFromStatuses([STATUS.MALFORMED_OUTPUT, STATUS.NOT_EVALUATED, STATUS.DENY]), REASON.INPUT_OUT_OF_RANGE);
});
