// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {FreezePacking} from "../src/libraries/FreezePacking.sol";

/// @notice The generated Freeze netlist (1 NAND), evaluated by the mock processor: allow = NOT freeze_flag.
contract FreezeCircuitTest is Base {
    function test_pinout() public view {
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = processor.circuitInfo(freezeId);
        assertEq(nIn, 1);
        assertEq(nOut, 1);
        assertEq(nState, 0);
        assertEq(gates, 1);
        assertEq(freezeNetlist(), hex"00000002000002");
    }

    function test_packing() public pure {
        (bool ok, bytes memory b) = FreezePacking.pack(false);
        assertTrue(ok);
        assertEq(b, hex"00");
        (ok, b) = FreezePacking.pack(true);
        assertTrue(ok);
        assertEq(b, hex"01");
    }

    function test_exhaustive() public view {
        (, bytes memory off) = FreezePacking.pack(false);
        (, bytes memory on) = FreezePacking.pack(true);
        assertEq(processor.eval(freezeId, off), hex"01", "not frozen: allow");
        assertEq(processor.eval(freezeId, on), hex"00", "frozen: block");
    }
}
