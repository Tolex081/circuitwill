// Freeze / Breaker circuit (docs/SPEC.md, circuit pinouts section 4).
//
// Pinout (nIn = 1, nOut = 1):
//   input  0  freeze_flag  (1 = frozen)
//   output 0  allow = NOT freeze_flag
//
// Pure combinational: the escrow stores the flag, so no LATCH (and no `step`) is needed.
// Structure (1 NAND): allow = NAND(freeze_flag, freeze_flag).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NetlistBuilder } from '../lib/tap02.mjs';
import { packFields, writeArtifacts } from '../lib/gates.mjs';

export const FREEZE = Object.freeze({
  name: 'CircuitWill Freeze',
  version: 1,
  nIn: 1,
  nOut: 1,
  pins: {
    freeze_flag: [0, 0],
  },
});

export function buildFreeze() {
  const b = new NetlistBuilder(FREEZE.nIn);
  b.not(b.input(0));
  const netlist = b.encode();
  return { ...FREEZE, gateCount: b.gates.length, gates: b.gates, netlist };
}

// Pack inputs exactly as FreezePacking.sol does: 1 byte, bit 0 = freeze_flag.
export function packFreezeInputs(frozen) {
  if (typeof frozen !== 'boolean' && frozen !== 0 && frozen !== 1) throw new RangeError('freeze_flag must be 0/1');
  return packFields([[frozen ? 1 : 0, 1]]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeArtifacts(
    dirname(fileURLToPath(import.meta.url)),
    'freeze',
    buildFreeze(),
    'LSB-first; 1 byte, bit 0 = freeze_flag',
  );
}
