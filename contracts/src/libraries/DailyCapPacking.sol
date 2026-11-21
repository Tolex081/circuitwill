// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Input packing for the Daily Cap circuit (CircuitWill_Circuit_Pinouts.md, section 1).
/// @dev Pins (nIn = 96, nOut = 1), bit-packed LSB-first per byte as TapeOut expects:
///        bits  0..31  amount       -> bytes 0..3,  little-endian
///        bits 32..63  spent_today  -> bytes 4..7,  little-endian
///        bits 64..95  daily_cap    -> bytes 8..11, little-endian
///      Values above type(uint32).max are rejected, never truncated.
///      Must stay identical to circuits/daily-cap/build.mjs `packDailyCapInputs`.
library DailyCapPacking {
    uint32 internal constant N_IN = 96;
    uint32 internal constant N_OUT = 1;
    uint256 internal constant INPUT_BYTES = 12;

    function pack(uint256 amount, uint256 spentToday, uint256 dailyCap)
        internal
        pure
        returns (bool ok, bytes memory input)
    {
        if (amount > type(uint32).max || spentToday > type(uint32).max || dailyCap > type(uint32).max) {
            return (false, "");
        }
        input = new bytes(INPUT_BYTES);
        for (uint256 j; j < 4; ++j) {
            uint256 shift = 8 * j;
            // Byte extraction from values already proven to fit in 32 bits.
            input[j] = bytes1(uint8(amount >> shift));
            input[4 + j] = bytes1(uint8(spentToday >> shift));
            input[8 + j] = bytes1(uint8(dailyCap >> shift));
        }
        ok = true;
    }
}
