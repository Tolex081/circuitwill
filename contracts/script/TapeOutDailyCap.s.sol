// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

interface ITapeOutWrite {
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256);
    function TAPEOUT_FEE() external view returns (uint256);
    function transistors() external view returns (address);
    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32);
}

interface ITransistorsRead {
    function balanceOf(address, uint256) external view returns (uint256);
}

/// @notice Tapes out circuits/daily-cap/build/daily-cap.netlist.hex on an existing TapeOut CPU.
/// @dev NOT RUN BY THIS PROJECT. Spends real funds when broadcast. Requirements (observed on a fork,
///      2026-11-19): the broadcaster holds >= 447 NAND (ERC-1155 id 0) of the target CPU, and sends
///      TAPEOUT_FEE() in OKB (0.0013 OKB at the time). Each NAND element burns one NAND transistor.
///
///      TAPEOUT_CIRCUITS=<circuits address> forge script script/TapeOutDailyCap.s.sol \
///        --rpc-url xlayer --account <keystore> --broadcast
contract TapeOutDailyCap is Script {
    function run() external returns (uint256 id) {
        ITapeOutWrite circuits = ITapeOutWrite(vm.envAddress("TAPEOUT_CIRCUITS"));
        bytes memory nl = vm.parseBytes(vm.trim(vm.readFile("../circuits/daily-cap/build/daily-cap.netlist.hex")));
        uint256 gates = nl.length / 7;

        uint256 nand = ITransistorsRead(circuits.transistors()).balanceOf(msg.sender, 0);
        require(nand >= gates, "not enough NAND transistors on this CPU");

        uint256 fee = circuits.TAPEOUT_FEE();
        vm.startBroadcast();
        id = circuits.tapeout{value: fee}(nl, 96, 1);
        vm.stopBroadcast();

        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) = circuits.circuitInfo(id);
        require(nIn == 96 && nOut == 1 && nState == 0 && gateCount == gates, "unexpected circuitInfo");
        console2.log("Daily Cap circuit id:", id);
        console2.log("processor (circuits):", address(circuits));
    }
}
