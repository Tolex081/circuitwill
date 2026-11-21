// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LittleEndian} from "./LittleEndian.sol";

/// @notice Input packing for the Confirmation Threshold circuit (CircuitWill_Circuit_Pinouts.md, section 3).
/// @dev Pins (nIn = 65, nOut = 1), bit-packed LSB-first per byte:
///        bits  0..31  amount     (uint32) -> bytes 0..3, little-endian
///        bits 32..63  threshold  (uint32) -> bytes 4..7, little-endian
///        bit  64      confirmed           -> byte 8, bit 0
///      Out-of-range values are rejected, never truncated.
///      Must stay identical to circuits/confirmation/build.mjs `packConfirmationInputs`.
library ConfirmationPacking {
    uint32 internal constant N_IN = 65;
    uint32 internal constant N_OUT = 1;
    uint256 internal constant INPUT_BYTES = 9;

    function pack(uint256 amount, uint256 threshold, bool confirmed)
        internal
        pure
        returns (bool ok, bytes memory input)
    {
        if (amount > type(uint32).max || threshold > type(uint32).max) {
            return (false, "");
        }
        // uint256 cast before shifting: `confirmed ? 1 : 0` alone is a uint8, which `<< 64` would clear.
        uint256 word = amount | (threshold << 32) | (uint256(confirmed ? 1 : 0) << 64);
        return (true, LittleEndian.toBytes(word, INPUT_BYTES));
    }
}
