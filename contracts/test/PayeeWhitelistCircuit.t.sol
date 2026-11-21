// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {PayeeWhitelistPacking} from "../src/libraries/PayeeWhitelistPacking.sol";

/// @notice The generated Payee Whitelist + Cooling-off netlist, evaluated by the mock processor, against the
///         reference rule: allow = is_saved OR (amount <= trial_limit AND age_hours >= cooling_off_hours).
contract PayeeWhitelistCircuitTest is Base {
    uint256 internal constant U16_MAX = type(uint16).max;

    function evalWl(bool saved, uint256 age, uint256 amount, uint256 trial, uint256 cooling)
        internal
        view
        returns (uint8)
    {
        (bool ok, bytes memory input) = PayeeWhitelistPacking.pack(saved, age, amount, trial, cooling);
        assertTrue(ok, "pack");
        bytes memory out = processor.eval(whitelistId, input);
        assertEq(out.length, 1, "one output byte");
        return uint8(out[0]);
    }

    function expected(bool saved, uint256 age, uint256 amount, uint256 trial, uint256 cooling)
        internal
        pure
        returns (uint8)
    {
        return saved || (amount <= trial && age >= cooling) ? 1 : 0;
    }

    function test_pinout() public view {
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = processor.circuitInfo(whitelistId);
        assertEq(nIn, 97);
        assertEq(nOut, 1);
        assertEq(nState, 0);
        assertEq(gates, 237);
        assertEq(PayeeWhitelistPacking.N_IN, 97);
    }

    function test_packingMatchesGenerator() public pure {
        // Same vector as circuits/test/payee-whitelist.test.mjs.
        (bool ok, bytes memory b) = PayeeWhitelistPacking.pack(true, 0x1234, 0x89abcdef, 0x01020304, 0xfedc);
        assertTrue(ok);
        assertEq(b, hex"6924de9b571309060402b8fd01");
    }

    function testFuzz_packingMatchesBitwiseReference(bool s, uint16 age, uint32 amt, uint32 trial, uint16 cool)
        public
        pure
    {
        (bool ok, bytes memory b) = PayeeWhitelistPacking.pack(s, age, amt, trial, cool);
        assertTrue(ok);
        assertEq(b, packWhitelist(s, age, amt, trial, cool));
    }

    function test_packingRejectsOutOfRange() public pure {
        (bool ok, bytes memory b) = PayeeWhitelistPacking.pack(false, U16_MAX + 1, 0, 0, 0);
        assertFalse(ok);
        assertEq(b.length, 0);
        (ok,) = PayeeWhitelistPacking.pack(false, 0, U32_MAX + 1, 0, 0);
        assertFalse(ok);
        (ok,) = PayeeWhitelistPacking.pack(false, 0, 0, U32_MAX + 1, 0);
        assertFalse(ok);
        (ok,) = PayeeWhitelistPacking.pack(false, 0, 0, 0, U16_MAX + 1);
        assertFalse(ok);
        (ok, b) = PayeeWhitelistPacking.pack(true, U16_MAX, U32_MAX, U32_MAX, U16_MAX);
        assertTrue(ok);
        assertEq(b, hex"ffffffffffffffffffffffff01");
    }

    function test_edgeVectors() public view {
        // [saved, age, amount, trial, cooling]
        uint256[5][16] memory v = [
            [uint256(1), 0, U32_MAX, 0, U16_MAX], // saved overrides everything
            [uint256(0), 0, 1, 0, 0], // amount above a zero trial limit
            [uint256(0), 0, 0, 0, 0], // all zero: 0 <= 0 and 0 >= 0
            [uint256(0), 23, 5, 5, 24], // one hour short
            [uint256(0), 24, 5, 5, 24], // exactly at cooling-off and at the trial limit
            [uint256(0), 25, 6, 5, 24], // one unit above the trial limit
            [uint256(0), U16_MAX, U32_MAX, U32_MAX, U16_MAX], // maxima
            [uint256(0), U16_MAX - 1, 1, 1, U16_MAX],
            [uint256(0), U16_MAX, U32_MAX, U32_MAX - 1, 0],
            [uint256(0), 0, 0x80000000, 0x7fffffff, 0], // MSB decides
            [uint256(0), 0x8000, 0, 0, 0x7fff],
            [uint256(0), 0x7fff, 0, 0, 0x8000],
            [uint256(0), 72, 5_000_000, 5_000_000, 72],
            [uint256(0), 72, 5_000_001, 5_000_000, 72],
            [uint256(1), 0, 5_000_001, 5_000_000, 72],
            [uint256(0), 71, 5_000_000, 5_000_000, 72]
        ];
        for (uint256 i; i < v.length; ++i) {
            bool s = v[i][0] == 1;
            assertEq(evalWl(s, v[i][1], v[i][2], v[i][3], v[i][4]), expected(s, v[i][1], v[i][2], v[i][3], v[i][4]));
        }
    }

    function testFuzz_matchesReference(bool s, uint16 age, uint32 amt, uint32 trial, uint16 cool) public view {
        assertEq(evalWl(s, age, amt, trial, cool), expected(s, age, amt, trial, cool));
    }

    function testFuzz_nearBoundary(uint32 amt, uint16 age, uint8 d1, uint8 d2, bool up1, bool up2) public view {
        uint256 trial = up1 ? _clamp(uint256(amt) + d1, U32_MAX) : (amt >= d1 ? amt - d1 : 0);
        uint256 cool = up2 ? _clamp(uint256(age) + d2, U16_MAX) : (age >= d2 ? age - d2 : 0);
        assertEq(evalWl(false, age, amt, trial, cool), expected(false, age, amt, trial, cool));
    }

    function _clamp(uint256 x, uint256 max) private pure returns (uint256) {
        return x > max ? max : x;
    }
}
