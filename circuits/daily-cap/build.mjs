// Daily Cap circuit (CircuitWill_Circuit_Pinouts.md, section 1).
//
// Pinout (nIn = 96, nOut = 1), bit-packed LSB-first:
//   inputs  0..31  amount       (uint32, token base units)
//   inputs 32..63  spent_today  (uint32)
//   inputs 64..95  daily_cap    (uint32)
//   output 0       allow = (spent_today + amount <= daily_cap) ? 1 : 0
//
// Overflow is handled explicitly: the sum is computed as a 33-bit value. If the carry out of
// bit 31 is set, the sum is >= 2^32 > any uint32 cap, so the circuit blocks. There is no
// wrap-around and no saturation.
//
// Structure (447 NAND):
//   1. 32-bit ripple-carry adder  S = amount + spent  -> 5 (half adder) + 31 * 9 (full adders)
//   2. LSB->MSB comparator chain  ge = (cap >= S)     -> 32 * 5
//   3. allow = ge AND NOT carry32                      -> 3
// The pinout document targets < 150 gates; that is not achievable for a 32-bit add-and-compare
// built from 2-input NANDs (the adder alone needs ~280). See docs/TAPEOUT_INTERFACE.md.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NetlistBuilder, toHex } from '../lib/tap02.mjs';

export const DAILY_CAP = Object.freeze({
  name: 'CircuitWill Daily Cap',
  version: 1,
  nIn: 96,
  nOut: 1,
  pins: {
    amount: [0, 31],
    spent_today: [32, 63],
    daily_cap: [64, 95],
  },
});

export function buildDailyCap() {
  const b = new NetlistBuilder(DAILY_CAP.nIn);
  const amount = (i) => b.input(i);
  const spent = (i) => b.input(32 + i);
  const cap = (i) => b.input(64 + i);

  // 1. Adder.
  const sum = [];
  let carry;
  {
    const a = amount(0);
    const s = spent(0);
    const t1 = b.nand(a, s);
    const t2 = b.nand(a, t1);
    const t3 = b.nand(s, t1);
    sum.push(b.nand(t2, t3)); // a XOR s
    carry = b.not(t1); // a AND s
  }
  for (let i = 1; i < 32; i++) {
    const a = amount(i);
    const s = spent(i);
    const t1 = b.nand(a, s);
    const t2 = b.nand(a, t1);
    const t3 = b.nand(s, t1);
    const x = b.nand(t2, t3); // a XOR s
    const t5 = b.nand(x, carry);
    const t6 = b.nand(x, t5);
    const t7 = b.nand(carry, t5);
    sum.push(b.nand(t6, t7)); // x XOR carry
    carry = b.nand(t1, t5); // (a AND s) OR (x AND carry)
  }
  const carry32 = carry;

  // 2. ge = (cap >= sum[0..31]); starts true (equal so far), the most significant difference wins.
  //    ge' = (c AND NOT s) OR (NOT (s AND NOT c) AND ge)
  let ge = NetlistBuilder.CONST1;
  for (let i = 0; i < 32; i++) {
    const c = cap(i);
    const s = sum[i];
    const x = b.nand(c, s);
    const u = b.nand(c, x); // NOT (c AND NOT s)
    const v = b.nand(s, x); // NOT (s AND NOT c)
    const w = b.nand(v, ge);
    ge = b.nand(u, w);
  }

  // 3. allow = ge AND NOT carry32 (must be the final gate: outputs are the last nOut signals).
  const noCarry = b.not(carry32);
  const t = b.nand(ge, noCarry);
  b.not(t);

  const bytes = b.encode();
  return { ...DAILY_CAP, gateCount: b.gates.length, gates: b.gates, netlist: bytes };
}

// Pack inputs exactly as CircuitWillEscrow does: 12 bytes, each value little-endian.
export function packDailyCapInputs(amount, spentToday, dailyCap) {
  const out = new Uint8Array(12);
  [amount, spentToday, dailyCap].forEach((v, k) => {
    const n = BigInt(v);
    if (n < 0n || n > 0xffffffffn) throw new RangeError(`value ${v} does not fit uint32`);
    for (let j = 0; j < 4; j++) out[k * 4 + j] = Number((n >> BigInt(8 * j)) & 0xffn);
  });
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = buildDailyCap();
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, 'build');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'daily-cap.netlist.hex'), toHex(built.netlist) + '\n');
  writeFileSync(
    join(outDir, 'daily-cap.json'),
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
        packing: 'LSB-first per byte; amount, spent_today, daily_cap as 4-byte little-endian words',
        netlist: toHex(built.netlist),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Daily Cap: ${built.gateCount} NAND, ${built.netlist.length} bytes -> ${outDir}`);
}
