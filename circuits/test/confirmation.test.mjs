import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfirmation, packConfirmationInputs } from '../confirmation/build.mjs';
import { toHex } from '../lib/tap02.mjs';
import { U32, around, checkArtifact, prng, runBit } from './helpers.mjs';

const built = buildConfirmation();
const run = (amount, threshold, confirmed) => runBit(built, packConfirmationInputs(amount, threshold, confirmed));
const expected = (amount, threshold, confirmed) => (BigInt(amount) <= BigInt(threshold) || confirmed ? 1 : 0);
const check = (...a) => assert.equal(run(...a), expected(...a), a.join(','));

test('pinout and size', () => {
  assert.equal(built.nIn, 65);
  assert.equal(built.nOut, 1);
  assert.equal(built.gateCount, 160);
  assert.deepEqual(built.pins, { amount: [0, 31], threshold: [32, 63], confirmed: [64, 64] });
});

test('artifact', () => checkArtifact(built, 'confirmation', 'confirmation'));

test('packing: layout and range checks', () => {
  assert.equal(packConfirmationInputs(0, 0, false).length, 9);
  // Shared vector, also asserted in contracts/test/ConfirmationCircuit.t.sol.
  assert.equal(toHex(packConfirmationInputs(0x04030201, 0x08070605, true)), '0x010203040506070801');
  assert.equal(toHex(packConfirmationInputs(U32, U32, false)), '0xffffffffffffffff00');
  assert.throws(() => packConfirmationInputs(U32 + 1n, 0, false), RangeError);
  assert.throws(() => packConfirmationInputs(0, U32 + 1n, false), RangeError);
  assert.throws(() => packConfirmationInputs(-1, 0, false), RangeError);
  assert.throws(() => packConfirmationInputs(0, 0, 2), RangeError);
});

test('at, below and above the threshold, with and without confirmation', () => {
  for (const threshold of [0n, 1n, 100_000_000n, 0x7fffffffn, 0x80000000n, U32 - 1n, U32]) {
    for (const amount of around(threshold, U32)) {
      check(amount, threshold, false);
      check(amount, threshold, true);
    }
  }
  assert.equal(run(100_000_001n, 100_000_000n, false), 0, 'above threshold needs confirmation');
  assert.equal(run(100_000_001n, 100_000_000n, true), 1);
  assert.equal(run(100_000_000n, 100_000_000n, false), 1, 'exactly at threshold is allowed');
  assert.equal(run(U32, 0n, true), 1);
  assert.equal(run(U32, 0n, false), 0);
});

test('single-bit sweeps', () => {
  for (let i = 0; i < 32; i++) {
    const v = 1n << BigInt(i);
    for (const c of [false, true]) {
      check(v, v, c);
      check(v, v - 1n, c);
      check(v - 1n, v, c);
      check(v, U32 ^ v, c);
      check(U32 ^ v, v, c);
    }
  }
});

test('random vectors (deterministic PRNG)', () => {
  const next = prng(0x5eed0003);
  for (let k = 0; k < 20_000; k++) {
    const amount = next();
    const threshold = k % 2 === 0 ? (amount + (next() % 3n) + U32) & U32 : next();
    check(amount, threshold, (next() & 1n) === 1n);
  }
});
