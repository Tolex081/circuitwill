import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDailyCap, packDailyCapInputs } from '../daily-cap/build.mjs';
import { decodeNandNetlist, evalPacked, fromHex, toHex } from '../lib/tap02.mjs';

const MAX = 0xffffffffn;
const built = buildDailyCap();

const run = (amount, spent, cap) =>
  evalPacked(built.gates, built.nIn, built.nOut, packDailyCapInputs(amount, spent, cap))[0] & 1;

const expected = (amount, spent, cap) => (BigInt(amount) + BigInt(spent) <= BigInt(cap) ? 1 : 0);

test('pinout and size', () => {
  assert.equal(built.nIn, 96);
  assert.equal(built.nOut, 1);
  assert.equal(built.gateCount, 447);
  assert.equal(built.netlist.length, 447 * 7);
});

test('netlist round-trips through the decoder', () => {
  assert.deepEqual(decodeNandNetlist(built.netlist), built.gates);
});

test('committed build artifact matches the generator', () => {
  const hex = readFileSync(new URL('../daily-cap/build/daily-cap.netlist.hex', import.meta.url), 'utf8').trim();
  assert.equal(hex, toHex(built.netlist), 'run `npm run build` in circuits/ to regenerate');
});

test('handoff success criteria: cap 50 blocks 60, allows 30', () => {
  assert.equal(run(60, 0, 50), 0);
  assert.equal(run(30, 0, 50), 1);
});

test('below, at and above the cap', () => {
  const cap = 50_000_000n; // 50 USDT0 (6 decimals)
  assert.equal(run(10_000_000n, 39_999_999n, cap), 1); // below
  assert.equal(run(10_000_000n, 40_000_000n, cap), 1); // exactly at
  assert.equal(run(10_000_000n, 40_000_001n, cap), 0); // one unit above
  assert.equal(run(cap, 0n, cap), 1);
  assert.equal(run(cap + 1n, 0n, cap), 0);
});

test('edge values: zeros, max uint32, overflow of the 32-bit sum', () => {
  const cases = [
    [0n, 0n, 0n],
    [1n, 0n, 0n],
    [0n, 1n, 0n],
    [0n, 0n, MAX],
    [MAX, 0n, MAX],
    [0n, MAX, MAX],
    [1n, MAX, MAX], // sum = 2^32: carry out must block, never wrap to 0
    [MAX, 1n, MAX],
    [MAX, MAX, MAX], // sum = 2^33 - 2, wraps to MAX-1 in 32 bits: must block
    [MAX, MAX, 0n],
    [0x80000000n, 0x80000000n, 0n], // wraps to exactly 0 in 32 bits: must block
    [0x7fffffffn, 0x80000000n, MAX],
    [0x80000000n, 0x80000000n, MAX],
  ];
  for (const [a, s, c] of cases) assert.equal(run(a, s, c), expected(a, s, c), `a=${a} s=${s} c=${c}`);
});

test('single-bit sweeps on each operand', () => {
  for (let i = 0; i < 32; i++) {
    const v = 1n << BigInt(i);
    for (const [a, s, c] of [
      [v, 0n, v],
      [v, 0n, v - 1n],
      [0n, v, v],
      [0n, v, v - 1n],
      [v, v, 2n * v > MAX ? MAX : 2n * v],
      [v, v, 2n * v - 1n > MAX ? MAX : 2n * v - 1n],
      [v, v - 1n, MAX],
    ]) {
      assert.equal(run(a, s, c), expected(a, s, c), `bit ${i}: a=${a} s=${s} c=${c}`);
    }
  }
});

test('random vectors (deterministic PRNG)', () => {
  let x = 0x2545f491n;
  const next = () => {
    x ^= (x << 13n) & 0xffffffffn;
    x ^= x >> 17n;
    x ^= (x << 5n) & 0xffffffffn;
    return x & MAX;
  };
  for (let k = 0; k < 20_000; k++) {
    const a = next();
    const s = k % 3 === 0 ? next() >> 1n : next();
    // bias the cap toward the boundary so both outcomes are well covered
    const sum = a + s;
    const c = k % 2 === 0 && sum <= MAX ? (sum + (next() % 3n) - 1n) & MAX : next();
    assert.equal(run(a, s, c), expected(a, s, c), `a=${a} s=${s} c=${c}`);
  }
});

test('packing rejects out-of-range values instead of truncating', () => {
  assert.throws(() => packDailyCapInputs(MAX + 1n, 0, 0), RangeError);
  assert.throws(() => packDailyCapInputs(0, -1, 0), RangeError);
  assert.equal(toHex(packDailyCapInputs(0x04030201, 0x08070605, 0x0c0b0a09)), '0x0102030405060708090a0b0c');
});

test('LSB-first semantics match the live TapeOut XOR circuit #1 (CPU 0) vectors', () => {
  // netlist(1) read from 0x839bdD6fa7A66416A609A735e11DE5411B98574e on X Layer mainnet; eval
  // returned 0x00, 0x01, 0x01, 0x00 for inputs 0x00..0x03 (see docs/TAPEOUT_INTERFACE.md).
  const xor = decodeNandNetlist(fromHex('0x00000002000003000000020000040000000300000400000005000006'));
  const outs = [0, 1, 2, 3].map((i) => evalPacked(xor, 2, 1, Uint8Array.of(i))[0]);
  assert.deepEqual(outs, [0, 1, 1, 0]);
});
