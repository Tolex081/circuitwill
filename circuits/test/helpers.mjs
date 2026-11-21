import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeNandNetlist, evalPacked, toHex } from '../lib/tap02.mjs';

export const U16 = 0xffffn;
export const U32 = 0xffffffffn;

// Deterministic xorshift32, returns BigInt in [0, 2^32).
export function prng(seed) {
  let x = BigInt(seed) & U32;
  return () => {
    x ^= (x << 13n) & U32;
    x ^= x >> 17n;
    x ^= (x << 5n) & U32;
    return x & U32;
  };
}

export const runBit = (built, inputBytes) => {
  const out = evalPacked(built.gates, built.nIn, built.nOut, inputBytes);
  assert.equal(out.length, 1, 'one output byte');
  return out[0] & 1;
};

// Checks shared by every generated circuit: round trip, committed artifact, LATCH-free netlist.
export function checkArtifact(built, dir, slug) {
  assert.deepEqual(decodeNandNetlist(built.netlist), built.gates, 'netlist round-trips through the decoder');
  assert.equal(built.netlist.length, built.gateCount * 7);
  const hex = readFileSync(new URL(`../${dir}/build/${slug}.netlist.hex`, import.meta.url), 'utf8').trim();
  assert.equal(hex, toHex(built.netlist), 'committed artifact drifted: run `npm run build` in circuits/');
  const meta = JSON.parse(readFileSync(new URL(`../${dir}/build/${slug}.json`, import.meta.url), 'utf8'));
  assert.equal(meta.nIn, built.nIn);
  assert.equal(meta.nOut, built.nOut);
  assert.equal(meta.nState, 0);
  assert.equal(meta.gateCount, built.gateCount);
  assert.equal(meta.netlist, toHex(built.netlist));
}

// Values around a boundary b within [0, max]: b-1, b, b+1 (clamped), plus 0 and max.
export function around(b, max) {
  const s = new Set([0n, max, b]);
  if (b > 0n) s.add(b - 1n);
  if (b < max) s.add(b + 1n);
  return [...s];
}
