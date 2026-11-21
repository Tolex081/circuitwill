// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Input packing for the Freeze circuit (CircuitWill_Circuit_Pinouts.md, section 4).
/// @dev Pins (nIn = 1, nOut = 1): bit 0 = freeze_flag. One byte, 0x00 or 0x01.
///      Must stay identical to circuits/freeze/build.mjs `packFreezeInputs`.
library FreezePacking {
    uint32 internal constant N_IN = 1;
    uint32 internal constant N_OUT = 1;
    uint256 internal constant INPUT_BYTES = 1;

    function pack(bool frozen) internal pure returns (bool ok, bytes memory input) {
        input = new bytes(INPUT_BYTES);
        if (frozen) input[0] = 0x01;
        ok = true;
    }
}
