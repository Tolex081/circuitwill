// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {DailyCapPacking} from "../src/libraries/DailyCapPacking.sol";

/// @notice The generated Daily Cap netlist, evaluated by the mock processor, against the reference rule.
contract DailyCapCircuitTest is Base {
    function evalCap(uint256 amount, uint256 spent, uint256 cap) internal view returns (uint8) {
        (bool ok, bytes memory input) = DailyCapPacking.pack(amount, spent, cap);
        assertTrue(ok, "pack");
        bytes memory out = processor.eval(dailyCapId, input);
        assertEq(out.length, 1, "one output byte");
        return uint8(out[0]);
    }

    function expected(uint256 a, uint256 s, uint256 c) internal pure returns (uint8) {
        return a + s <= c ? 1 : 0;
    }

    function test_pinout() public view {
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = processor.circuitInfo(dailyCapId);
        assertEq(nIn, 96);
        assertEq(nOut, 1);
        assertEq(nState, 0);
        assertEq(gates, 447);
    }

    function test_packingMatchesPinout() public pure {
        (bool ok, bytes memory b) = DailyCapPacking.pack(0x04030201, 0x08070605, 0x0c0b0a09);
        assertTrue(ok);
        assertEq(b, hex"0102030405060708090a0b0c");
    }

    function test_packingRejectsOutOfRange() public pure {
        (bool ok, bytes memory b) = DailyCapPacking.pack(U32_MAX + 1, 0, 0);
        assertFalse(ok);
        assertEq(b.length, 0);
        (ok,) = DailyCapPacking.pack(0, U32_MAX + 1, 0);
        assertFalse(ok);
        (ok,) = DailyCapPacking.pack(0, 0, U32_MAX + 1);
        assertFalse(ok);
        (ok,) = DailyCapPacking.pack(U32_MAX, U32_MAX, U32_MAX);
        assertTrue(ok);
    }

    function test_edgeVectors() public view {
        uint256[3][14] memory v = [
            [uint256(60), 0, 50],
            [uint256(30), 0, 50],
            [uint256(0), 0, 0],
            [uint256(1), 0, 0],
            [uint256(10), 40, 50],
            [uint256(10), 41, 50],
            [U32_MAX, 0, U32_MAX],
            [uint256(0), U32_MAX, U32_MAX],
            [uint256(1), U32_MAX, U32_MAX], // sum = 2^32: carry must block
            [U32_MAX, U32_MAX, U32_MAX], // wraps to MAX-1 in 32 bits: must block
            [uint256(0x80000000), 0x80000000, 0], // wraps to 0 in 32 bits: must block
            [uint256(0x80000000), 0x7fffffff, U32_MAX],
            [uint256(50_000_000), 0, 50_000_000],
            [uint256(50_000_001), 0, 50_000_000]
        ];
        for (uint256 i; i < v.length; ++i) {
            assertEq(evalCap(v[i][0], v[i][1], v[i][2]), expected(v[i][0], v[i][1], v[i][2]));
        }
    }

    function testFuzz_matchesReference(uint32 a, uint32 s, uint32 c) public view {
        assertEq(evalCap(a, s, c), expected(a, s, c));
    }

    function testFuzz_nearBoundary(uint32 a, uint32 s, uint8 delta, bool above) public view {
        uint256 sum = uint256(a) + s;
        vm.assume(sum <= U32_MAX);
        uint256 c = above ? (sum >= delta ? sum - delta : 0) : sum + delta;
        if (c > U32_MAX) c = U32_MAX;
        assertEq(evalCap(a, s, c), expected(a, s, c));
    }
}
