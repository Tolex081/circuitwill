// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {ConfirmationPacking} from "../src/libraries/ConfirmationPacking.sol";

/// @notice The generated Confirmation Threshold netlist, evaluated by the mock processor, against the reference rule:
///         allow = amount <= threshold OR confirmed.
contract ConfirmationCircuitTest is Base {
    function evalConf(uint256 amount, uint256 threshold, bool confirmed) internal view returns (uint8) {
        (bool ok, bytes memory input) = ConfirmationPacking.pack(amount, threshold, confirmed);
        assertTrue(ok, "pack");
        bytes memory out = processor.eval(confirmationId, input);
        assertEq(out.length, 1, "one output byte");
        return uint8(out[0]);
    }

    function expected(uint256 amount, uint256 threshold, bool confirmed) internal pure returns (uint8) {
        return amount <= threshold || confirmed ? 1 : 0;
    }

    function test_pinout() public view {
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = processor.circuitInfo(confirmationId);
        assertEq(nIn, 65);
        assertEq(nOut, 1);
        assertEq(nState, 0);
        assertEq(gates, 160);
        assertEq(ConfirmationPacking.N_IN, 65);
    }

    function test_packingMatchesGenerator() public pure {
        // Same vectors as circuits/test/confirmation.test.mjs.
        (bool ok, bytes memory b) = ConfirmationPacking.pack(0x04030201, 0x08070605, true);
        assertTrue(ok);
        assertEq(b, hex"010203040506070801");
        (ok, b) = ConfirmationPacking.pack(U32_MAX, U32_MAX, false);
        assertEq(b, hex"ffffffffffffffff00");
    }

    function testFuzz_packingMatchesBitwiseReference(uint32 a, uint32 t, bool c) public pure {
        (bool ok, bytes memory b) = ConfirmationPacking.pack(a, t, c);
        assertTrue(ok);
        assertEq(b, packConfirmation(a, t, c));
    }

    function test_packingRejectsOutOfRange() public pure {
        (bool ok, bytes memory b) = ConfirmationPacking.pack(U32_MAX + 1, 0, true);
        assertFalse(ok);
        assertEq(b.length, 0);
        (ok,) = ConfirmationPacking.pack(0, U32_MAX + 1, false);
        assertFalse(ok);
    }

    function test_edgeVectors() public view {
        uint256[2][12] memory v = [
            [uint256(0), 0],
            [uint256(1), 0],
            [uint256(0), U32_MAX],
            [U32_MAX, U32_MAX],
            [U32_MAX, U32_MAX - 1],
            [U32_MAX - 1, U32_MAX],
            [uint256(100_000_000), 100_000_000], // exactly at threshold
            [uint256(100_000_001), 100_000_000], // one above
            [uint256(99_999_999), 100_000_000],
            [uint256(0x80000000), 0x7fffffff],
            [uint256(0x7fffffff), 0x80000000],
            [U32_MAX, 0]
        ];
        for (uint256 i; i < v.length; ++i) {
            assertEq(evalConf(v[i][0], v[i][1], false), expected(v[i][0], v[i][1], false));
            assertEq(evalConf(v[i][0], v[i][1], true), 1, "confirmed always allows");
        }
    }

    function testFuzz_matchesReference(uint32 a, uint32 t, bool c) public view {
        assertEq(evalConf(a, t, c), expected(a, t, c));
    }

    function testFuzz_nearBoundary(uint32 a, uint8 d, bool up, bool c) public view {
        uint256 t = up ? uint256(a) + d : (a >= d ? a - d : 0);
        if (t > U32_MAX) t = U32_MAX;
        assertEq(evalConf(a, t, c), expected(a, t, c));
    }
}
