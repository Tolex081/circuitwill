// Shared NAND building blocks and LSB-first input packing for the Phase 2 circuits.
// (circuits/daily-cap/build.mjs keeps its own inline copy so its committed artifact never changes.)

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { toHex } from './tap02.mjs';

// Returns a signal that is 1 iff the unsigned value on `cBits` is >= the value on `sBits`.
// Both are arrays of signal indices, least significant bit first, of equal length.
//   bit 0:     ge = c0 OR NOT s0                                  (2 NAND)
//   bit i > 0: ge' = (c AND NOT s) OR (NOT (s AND NOT c) AND ge)  (5 NAND)
// The most significant differing bit decides; equal values give 1.
export function geUnsigned(b, cBits, sBits) {
  if (cBits.length !== sBits.length || cBits.length === 0) throw new Error('geUnsigned: width mismatch');
  let ge = b.nand(b.not(cBits[0]), sBits[0]);
  for (let i = 1; i < cBits.length; i++) {
    const c = cBits[i];
    const s = sBits[i];
    const x = b.nand(c, s);
    const u = b.nand(c, x); // NOT (c AND NOT s)
    const v = b.nand(s, x); // NOT (s AND NOT c)
    const w = b.nand(v, ge);
    ge = b.nand(u, w);
  }
  return ge;
}

// Signal indices for input pins [first, first + width).
export const pins = (b, first, width) => Array.from({ length: width }, (_, i) => b.input(first + i));

// Packs fields LSB-first: fields = [[value, width], ...] in pin order. Throws RangeError instead of
// truncating. Returns ceil(totalBits / 8) bytes (bit i = (byte[i >> 3] >> (i & 7)) & 1).
export function packFields(fields) {
  let word = 0n;
  let shift = 0n;
  for (const [value, width] of fields) {
    const v = typeof value === 'boolean' ? (value ? 1n : 0n) : BigInt(value);
    const max = (1n << BigInt(width)) - 1n;
    if (v < 0n || v > max) throw new RangeError(`value ${value} does not fit uint${width}`);
    word |= v << shift;
    shift += BigInt(width);
  }
  const out = new Uint8Array(Math.ceil(Number(shift) / 8));
  for (let j = 0; j < out.length; j++) out[j] = Number((word >> BigInt(8 * j)) & 0xffn);
  return out;
}

export function writeArtifacts(dir, slug, built, packing) {
  const outDir = join(dir, 'build');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${slug}.netlist.hex`), toHex(built.netlist) + '\n');
  writeFileSync(
    join(outDir, `${slug}.json`),
    JSON.stringify(
      {
        name: built.name,
        version: built.version,
        nIn: built.nIn,
        nOut: built.nOut,
        nState: 0,
        gateCount: built.gateCount,
        netlistBytes: built.netlist.length,
        pins: built.pins,
        packing,
        netlist: toHex(built.netlist),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`${built.name}: ${built.gateCount} NAND, ${built.netlist.length} bytes -> ${outDir}`);
}
