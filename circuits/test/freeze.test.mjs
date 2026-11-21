import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFreeze, packFreezeInputs } from '../freeze/build.mjs';
import { evalPacked, toHex } from '../lib/tap02.mjs';
import { checkArtifact, runBit } from './helpers.mjs';

const built = buildFreeze();

test('pinout and size', () => {
  assert.equal(built.nIn, 1);
  assert.equal(built.nOut, 1);
  assert.equal(built.gateCount, 1);
  assert.equal(toHex(built.netlist), '0x00000002000002'); // NAND(input 0, input 0)
});

test('artifact', () => checkArtifact(built, 'freeze', 'freeze'));

test('exhaustive', () => {
  assert.equal(runBit(built, packFreezeInputs(false)), 1, 'not frozen: allow');
  assert.equal(runBit(built, packFreezeInputs(true)), 0, 'frozen: block');
});

test('packing', () => {
  assert.equal(toHex(packFreezeInputs(false)), '0x00');
  assert.equal(toHex(packFreezeInputs(true)), '0x01');
  assert.throws(() => packFreezeInputs(2), RangeError);
});

test('only bit 0 is read', () => {
  // Bits above nIn are ignored, as on TapeOut; the escrow only ever sends 0x00 or 0x01.
  assert.equal(evalPacked(built.gates, 1, 1, Uint8Array.of(0xfe))[0], 1);
  assert.equal(evalPacked(built.gates, 1, 1, Uint8Array.of(0xff))[0], 0);
});
