// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

interface ITapeOutWriteAny {
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256);
    function TAPEOUT_FEE() external view returns (uint256);
    function transistors() external view returns (address);
    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32);
}

interface ITransistorsBalance {
    function balanceOf(address, uint256) external view returns (uint256);
}

/// @notice Tapes out one of the generated CircuitWill netlists on an existing TapeOut CPU.
/// @dev NOT RUN AGAINST A LIVE NETWORK BY THIS PROJECT. Spends real funds when broadcast. Requirements (observed on a
///      fork, 2026-11-19): the broadcaster holds at least as many NAND transistors (ERC-1155 id 0) of the target CPU as
///      the netlist has elements, and sends TAPEOUT_FEE() in OKB (0.0013 OKB at the time).
///
///      CIRCUIT is one of: daily-cap (96 in, 447 NAND), payee-whitelist (97 in, 237 NAND),
///      confirmation (65 in, 160 NAND), freeze (1 in, 1 NAND).
///
///      TAPEOUT_CIRCUITS=<circuits address> CIRCUIT=payee-whitelist forge script script/TapeOutCircuit.s.sol \
///        --rpc-url xlayer --account <keystore>            (add --broadcast only to spend real funds)
contract TapeOutCircuit is Script {
    function run() external returns (uint256 id) {
        ITapeOutWriteAny circuits = ITapeOutWriteAny(vm.envAddress("TAPEOUT_CIRCUITS"));
        string memory slug = vm.envString("CIRCUIT");
        uint32 nIn = _nIn(slug);
        string memory path = string.concat("../circuits/", slug, "/build/", slug, ".netlist.hex");
        bytes memory nl = vm.parseBytes(vm.trim(vm.readFile(path)));
        uint256 gates = nl.length / 7;

        uint256 nand = ITransistorsBalance(circuits.transistors()).balanceOf(msg.sender, 0);
        require(nand >= gates, "not enough NAND transistors on this CPU");

        uint256 fee = circuits.TAPEOUT_FEE();
        vm.startBroadcast();
        id = circuits.tapeout{value: fee}(nl, nIn, 1);
        vm.stopBroadcast();

        (uint32 gotIn, uint32 nOut, uint32 nState, uint32 gateCount) = circuits.circuitInfo(id);
        require(gotIn == nIn && nOut == 1 && nState == 0 && gateCount == gates, "unexpected circuitInfo");
        console2.log("circuit:", slug);
        console2.log("circuit id:", id);
        console2.log("processor (circuits):", address(circuits));
    }

    function _nIn(string memory slug) internal pure returns (uint32) {
        bytes32 h = keccak256(bytes(slug));
        if (h == keccak256("daily-cap")) return 96;
        if (h == keccak256("payee-whitelist")) return 97;
        if (h == keccak256("confirmation")) return 65;
        if (h == keccak256("freeze")) return 1;
        revert("CIRCUIT must be daily-cap, payee-whitelist, confirmation or freeze");
    }
}
