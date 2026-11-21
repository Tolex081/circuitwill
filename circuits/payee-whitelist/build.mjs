// Payee Whitelist + Cooling-off circuit (CircuitWill_Circuit_Pinouts.md, section 2).
//
// Pinout (nIn = 97, nOut = 1), bit-packed LSB-first:
//   input  0       is_saved           (1 = saved payee)
//   inputs 1..16   age_hours          (uint16, computed by the escrow from the payee's first-seen time)
//   inputs 17..48  amount             (uint32, token base units)
//   inputs 49..80  trial_limit        (uint32)
//   inputs 81..96  cooling_off_hours  (uint16)
//   output 0       allow = is_saved OR (amount <= trial_limit AND age_hours >= cooling_off_hours)
//
// Structure (237 NAND):
//   1. le = (trial_limit >= amount)        32-bit comparator   2 + 31 * 5 = 157
//   2. old = (age_hours >= cooling_off)    16-bit comparator   2 + 15 * 5 =  77
//   3. allow = NAND(NOT is_saved, NAND(le, old))                              3
// The pinout document targets < 200 gates. Two unsigned comparators (48 bits) built from 2-input
// NANDs need about 5 gates per bit, so 237 is the size of this straightforward construction.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NetlistBuilder } from '../lib/tap02.mjs';
import { geUnsigned, packFields, pins, writeArtifacts } from '../lib/gates.mjs';

export const PAYEE_WHITELIST = Object.freeze({
  name: 'CircuitWill Payee Whitelist + Cooling-off',
  version: 1,
  nIn: 97,
  nOut: 1,
  pins: {
    is_saved: [0, 0],
    age_hours: [1, 16],
    amount: [17, 48],
    trial_limit: [49, 80],
    cooling_off_hours: [81, 96],
  },
});

export function buildPayeeWhitelist() {
  const b = new NetlistBuilder(PAYEE_WHITELIST.nIn);
  const isSaved = b.input(0);
  const age = pins(b, 1, 16);
  const amount = pins(b, 17, 32);
  const trial = pins(b, 49, 32);
  const cooling = pins(b, 81, 16);

  const withinTrial = geUnsigned(b, trial, amount); // amount <= trial_limit
  const cooledOff = geUnsigned(b, age, cooling); // age_hours >= cooling_off_hours
  const notSaved = b.not(isSaved);
  const notBoth = b.nand(withinTrial, cooledOff);
  b.nand(notSaved, notBoth); // is_saved OR (withinTrial AND cooledOff); must be the final gate

  const netlist = b.encode();
  return { ...PAYEE_WHITELIST, gateCount: b.gates.length, gates: b.gates, netlist };
}

// Pack inputs exactly as PayeeWhitelistPacking.sol does: 13 bytes, fields LSB-first in pin order.
export function packPayeeWhitelistInputs(isSaved, ageHours, amount, trialLimit, coolingOffHours) {
  if (typeof isSaved !== 'boolean' && isSaved !== 0 && isSaved !== 1) throw new RangeError('is_saved must be 0/1');
  return packFields([
    [isSaved ? 1 : 0, 1],
    [ageHours, 16],
    [amount, 32],
    [trialLimit, 32],
    [coolingOffHours, 16],
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeArtifacts(
    dirname(fileURLToPath(import.meta.url)),
    'payee-whitelist',
    buildPayeeWhitelist(),
    'LSB-first per byte; 97 bits = is_saved | age_hours<<1 | amount<<17 | trial_limit<<49 | cooling_off_hours<<81, as 13 little-endian bytes',
  );
}
