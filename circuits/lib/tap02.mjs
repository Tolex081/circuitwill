// TAP-02 netlist encoding and a reference simulator (NAND-only, combinational).
//
// Wire format and evaluation semantics, as checked against TapeOut on X Layer mainnet
// (see docs/TAPEOUT_INTERFACE.md for the evidence and what is NOT verified):
//   NAND element  = 0x00 a:u24 b:u24   (big-endian signal indices)
//   signals       = 0: const0, 1: const1, 2..1+nIn: inputs, then one signal per NAND, in order
//   outputs       = the last nOut element signals
//   eval bytes    = bit i is (byte[i >> 3] >> (i & 7)) & 1   (LSB-first per byte)
// LATCH (0x01) and REF (0x02) elements are intentionally unsupported here: Phase 1 circuits are
// plain combinational NAND netlists.

export class NetlistBuilder {
  constructor(nIn) {
    if (!Number.isInteger(nIn) || nIn < 1) throw new Error('nIn must be a positive integer');
    this.nIn = nIn;
    this.gates = []; // [a, b]
  }

  static CONST0 = 0;
  static CONST1 = 1;

  input(i) {
    if (i < 0 || i >= this.nIn) throw new Error(`input ${i} out of range`);
    return 2 + i;
  }

  get nextSignal() {
    return 2 + this.nIn + this.gates.length;
  }

  nand(a, b) {
    const next = this.nextSignal;
    if (a >= next || b >= next) throw new Error(`NAND: future signal (${a}, ${b}) >= ${next}`);
    this.gates.push([a, b]);
    return next;
  }

  not(a) {
    return this.nand(a, a);
  }

  // Returns the netlist bytes. Outputs are the last nOut gates, so callers must emit them last.
  encode() {
    const out = new Uint8Array(this.gates.length * 7);
    let p = 0;
    const w24 = (v) => {
      if (v < 0 || v > 0xffffff) throw new Error('signal index exceeds u24');
      out[p++] = (v >>> 16) & 0xff;
      out[p++] = (v >>> 8) & 0xff;
      out[p++] = v & 0xff;
    };
    for (const [a, b] of this.gates) {
      out[p++] = 0x00;
      w24(a);
      w24(b);
    }
    return out;
  }
}

export function decodeNandNetlist(bytes) {
  if (bytes.length % 7 !== 0) throw new Error('netlist length is not a multiple of 7 (NAND-only decoder)');
  const gates = [];
  for (let p = 0; p < bytes.length; p += 7) {
    if (bytes[p] !== 0x00) throw new Error(`unsupported opcode 0x${bytes[p].toString(16)} at byte ${p}`);
    const a = (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    const b = (bytes[p + 4] << 16) | (bytes[p + 5] << 8) | bytes[p + 6];
    gates.push([a, b]);
  }
  return gates;
}

// Mirrors the on-chain tapeout checks we rely on (future signals, enough outputs).
export function validate(gates, nIn, nOut) {
  if (nOut < 1) throw new Error('no outputs');
  if (gates.length < nOut) throw new Error('too few signals for outputs');
  gates.forEach(([a, b], i) => {
    const self = 2 + nIn + i;
    if (a >= self || b >= self) throw new Error(`NAND: future signal at gate ${i}`);
  });
}

// Evaluate with packed LSB-first input bytes; returns packed LSB-first output bytes.
export function evalPacked(gates, nIn, nOut, inputBytes) {
  validate(gates, nIn, nOut);
  const sig = new Uint8Array(2 + nIn + gates.length);
  sig[1] = 1;
  for (let i = 0; i < nIn; i++) {
    const byte = i >> 3 < inputBytes.length ? inputBytes[i >> 3] : 0; // missing bytes read as 0
    sig[2 + i] = (byte >> (i & 7)) & 1;
  }
  const base = 2 + nIn;
  gates.forEach(([a, b], i) => {
    sig[base + i] = 1 - (sig[a] & sig[b]);
  });
  const out = new Uint8Array(Math.ceil(nOut / 8));
  const first = sig.length - nOut;
  for (let o = 0; o < nOut; o++) out[o >> 3] |= sig[first + o] << (o & 7);
  return out;
}

export const toHex = (bytes) => '0x' + Buffer.from(bytes).toString('hex');
export const fromHex = (hex) => new Uint8Array(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
