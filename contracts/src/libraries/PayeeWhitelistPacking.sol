// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LittleEndian} from "./LittleEndian.sol";

/// @notice Input packing for the Payee Whitelist + Cooling-off circuit (CircuitWill_Circuit_Pinouts.md, section 2).
/// @dev Pins (nIn = 97, nOut = 1), bit-packed LSB-first per byte as TapeOut expects:
///        bit  0       is_saved
///        bits 1..16   age_hours          (uint16)
///        bits 17..48  amount             (uint32)
///        bits 49..80  trial_limit        (uint32)
///        bits 81..96  cooling_off_hours  (uint16)
///      The 97-bit word is written as 13 little-endian bytes. Out-of-range values are rejected, never truncated.
///      Must stay identical to circuits/payee-whitelist/build.mjs `packPayeeWhitelistInputs`.
library PayeeWhitelistPacking {
    uint32 internal constant N_IN = 97;
    uint32 internal constant N_OUT = 1;
    uint256 internal constant INPUT_BYTES = 13;

    function pack(bool isSaved, uint256 ageHours, uint256 amount, uint256 trialLimit, uint256 coolingOffHours)
        internal
        pure
        returns (bool ok, bytes memory input)
    {
        if (
            ageHours > type(uint16).max || amount > type(uint32).max || trialLimit > type(uint32).max
                || coolingOffHours > type(uint16).max
        ) {
            return (false, "");
        }
        uint256 word =
            uint256(isSaved ? 1 : 0) | (ageHours << 1) | (amount << 17) | (trialLimit << 49) | (coolingOffHours << 81);
        return (true, LittleEndian.toBytes(word, INPUT_BYTES));
    }
}
