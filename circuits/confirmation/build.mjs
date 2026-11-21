// Confirmation Threshold circuit (CircuitWill_Circuit_Pinouts.md, section 3).
//
// Pinout (nIn = 65, nOut = 1), bit-packed LSB-first:
//   inputs  0..31  amount     (uint32, token base units)
//   inputs 32..63  threshold  (uint32)
//   input  64      confirmed  (1 = the controller confirmed this exact payment)
//   output 0       allow = (amount <= threshold) OR confirmed
//
// Structure (160 NAND):
//   1. le = (threshold >= amount)    32-bit comparator   2 + 31 * 5 = 157
//   2. allow = NAND(NOT le, NOT confirmed)                           3
// The pinout document targets < 100 gates; a 32-bit unsigned comparison from 2-input NANDs needs
// about 5 gates per bit with this construction.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NetlistBuilder } from '../lib/tap02.mjs';
import { geUnsigned, packFields, pins, writeArtifacts } from '../lib/gates.mjs';

export const CONFIRMATION = Object.freeze({
  name: 'CircuitWill Confirmation Threshold',
  version: 1,
  nIn: 65,
  nOut: 1,
  pins: {
    amount: [0, 31],
    threshold: [32, 63],
    confirmed: [64, 64],
  },
});

export function buildConfirmation() {
  const b = new NetlistBuilder(CONFIRMATION.nIn);
  const amount = pins(b, 0, 32);
  const threshold = pins(b, 32, 32);
  const confirmed = b.input(64);

  const notConfirmed = b.not(confirmed);
  const withinThreshold = geUnsigned(b, threshold, amount); // amount <= threshold
  const above = b.not(withinThreshold);
  b.nand(above, notConfirmed); // withinThreshold OR confirmed; must be the final gate

  const netlist = b.encode();
  return { ...CONFIRMATION, gateCount: b.gates.length, gates: b.gates, netlist };
}

// Pack inputs exactly as ConfirmationPacking.sol does: 9 bytes, fields LSB-first in pin order.
export function packConfirmationInputs(amount, threshold, confirmed) {
  if (typeof confirmed !== 'boolean' && confirmed !== 0 && confirmed !== 1) throw new RangeError('confirmed must be 0/1');
  return packFields([
    [amount, 32],
    [threshold, 32],
    [confirmed ? 1 : 0, 1],
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeArtifacts(
    dirname(fileURLToPath(import.meta.url)),
    'confirmation',
    buildConfirmation(),
    'LSB-first per byte; 65 bits = amount | threshold<<32 | confirmed<<64, as 9 little-endian bytes',
  );
}
