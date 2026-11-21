import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayeeWhitelist, packPayeeWhitelistInputs } from '../payee-whitelist/build.mjs';
import { toHex } from '../lib/tap02.mjs';
import { U16, U32, around, checkArtifact, prng, runBit } from './helpers.mjs';

const built = buildPayeeWhitelist();
const run = (saved, age, amount, trial, cooling) =>
  runBit(built, packPayeeWhitelistInputs(saved, age, amount, trial, cooling));
const expected = (saved, age, amount, trial, cooling) =>
  saved || (BigInt(amount) <= BigInt(trial) && BigInt(age) >= BigInt(cooling)) ? 1 : 0;
const check = (...a) => assert.equal(run(...a), expected(...a), a.join(','));

test('pinout and size', () => {
  assert.equal(built.nIn, 97);
  assert.equal(built.nOut, 1);
  assert.equal(built.gateCount, 237);
  assert.deepEqual(built.pins, {
    is_saved: [0, 0],
    age_hours: [1, 16],
    amount: [17, 48],
    trial_limit: [49, 80],
    cooling_off_hours: [81, 96],
  });
});

test('artifact', () => checkArtifact(built, 'payee-whitelist', 'payee-whitelist'));

test('packing: bit positions, width and range checks', () => {
  // Each field set to all-ones alone lights exactly its pin range.
  const lit = (bytes) => {
    const s = [];
    for (let i = 0; i < bytes.length * 8; i++) if ((bytes[i >> 3] >> (i & 7)) & 1) s.push(i);
    return [s[0], s[s.length - 1], s.length];
  };
  assert.equal(packPayeeWhitelistInputs(false, 0, 0, 0, 0).length, 13);
  assert.deepEqual(lit(packPayeeWhitelistInputs(true, 0, 0, 0, 0)), [0, 0, 1]);
  assert.deepEqual(lit(packPayeeWhitelistInputs(false, U16, 0, 0, 0)), [1, 16, 16]);
  assert.deepEqual(lit(packPayeeWhitelistInputs(false, 0, U32, 0, 0)), [17, 48, 32]);
  assert.deepEqual(lit(packPayeeWhitelistInputs(false, 0, 0, U32, 0)), [49, 80, 32]);
  assert.deepEqual(lit(packPayeeWhitelistInputs(false, 0, 0, 0, U16)), [81, 96, 16]);
  // Shared vector, also asserted in contracts/test/PayeeWhitelistCircuit.t.sol.
  assert.equal(
    toHex(packPayeeWhitelistInputs(true, 0x1234, 0x89abcdef, 0x01020304, 0xfedc)),
    '0x6924de9b571309060402b8fd01',
  );
  assert.throws(() => packPayeeWhitelistInputs(false, U16 + 1n, 0, 0, 0), RangeError);
  assert.throws(() => packPayeeWhitelistInputs(false, 0, U32 + 1n, 0, 0), RangeError);
  assert.throws(() => packPayeeWhitelistInputs(false, 0, 0, U32 + 1n, 0), RangeError);
  assert.throws(() => packPayeeWhitelistInputs(false, 0, 0, 0, U16 + 1n), RangeError);
  assert.throws(() => packPayeeWhitelistInputs(false, -1, 0, 0, 0), RangeError);
  assert.throws(() => packPayeeWhitelistInputs(2, 0, 0, 0, 0), RangeError);
});

test('saved payee is always allowed, whatever the other inputs', () => {
  for (const age of [0n, 1n, U16])
    for (const amount of [0n, 1n, U32])
      for (const trial of [0n, U32])
        for (const cooling of [0n, U16]) assert.equal(run(true, age, amount, trial, cooling), 1);
});

test('new payee: trial limit edges (0, max, exact)', () => {
  for (const trial of [0n, 1n, 50_000_000n, 0x80000000n, U32]) {
    for (const amount of around(trial, U32)) {
      check(false, 10, amount, trial, 0);
      check(false, 0, amount, trial, 1); // too young regardless of amount
    }
  }
});

test('new payee: cooling-off edges (0, max, exact)', () => {
  for (const cooling of [0n, 1n, 24n, 72n, 0x8000n, U16]) {
    for (const age of around(cooling, U16)) {
      check(false, age, 1, 1, cooling);
      check(false, age, 2, 1, cooling); // above the trial limit regardless of age
    }
  }
});

test('single-bit sweeps on every field', () => {
  for (let i = 0; i < 32; i++) {
    const v = 1n << BigInt(i);
    check(false, 0, v, v, 0);
    check(false, 0, v, v - 1n, 0);
    check(false, 0, v - 1n, v, 0);
    check(false, 0, v, U32 ^ v, 0);
  }
  for (let i = 0; i < 16; i++) {
    const v = 1n << BigInt(i);
    check(false, v, 0, 0, v);
    check(false, v - 1n, 0, 0, v);
    check(false, v, 0, 0, v - 1n);
    check(false, U16 ^ v, 0, 0, v);
  }
});

test('exhaustive over small widths (4-bit values, both is_saved)', () => {
  for (const saved of [false, true])
    for (let age = 0; age < 16; age++)
      for (let cooling = 0; cooling < 16; cooling++)
        for (let amount = 0; amount < 16; amount++)
          for (const trial of [0, 7, 8, 15]) check(saved, age, amount, trial, cooling);
});

test('random vectors (deterministic PRNG)', () => {
  const next = prng(0x5eed0002);
  for (let k = 0; k < 20_000; k++) {
    const saved = (next() & 7n) === 0n;
    const amount = next();
    const age = next() & U16;
    // bias toward the boundaries so both outcomes are covered
    const trial = k % 2 === 0 ? (amount + (next() % 3n) + U32) & U32 : next();
    const cooling = k % 3 === 0 ? (age + (next() % 3n) + U16) & U16 : next() & U16;
    check(saved, age, amount, trial, cooling);
  }
});
