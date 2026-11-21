// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The subset of a TapeOut "circuits" contract (one per CPU, ERC-721, ids start at 1) that
///         CircuitWill uses.
/// @dev Checked against X Layer mainnet on 2026-11-19 (read-only calls, see docs/TAPEOUT_INTERFACE.md):
///      - `eval(uint256,bytes)` selector 0x934d06ea is present in the live circuit implementation
///        0x977f217887E085D298Cb3819cDAD5A0ee35F29B2 behind beacon 0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C.
///      - Inputs and outputs are bit-packed LSB-first per byte (XOR circuit #1 on CPU 0 returned
///        0x00,0x01,0x01,0x00 for inputs 0x00..0x03).
///      TapeOut has not published an official ABI document; signatures here come from the live
///      bytecode selectors plus community integrations. TapeOut's contracts are upgradeable by their
///      owner, so behaviour can change after this check.
interface ITapeOutCircuits {
    /// @dev Reverts for unknown ids and for sequential circuits ("has latch: use step").
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);

    /// @dev Reverts "no circuit" for unknown ids. gateCount and nState are flattened through REFs.
    function circuitInfo(uint256 id) external view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);

    /// @dev Returns the netlist bytes exactly as submitted to `tapeout`.
    function netlist(uint256 id) external view returns (bytes memory);
}

/// @notice TapeOut factory. `isCPU` is keyed by the circuits contract address.
interface ITapeOutFactory {
    function isCPU(address circuits) external view returns (bool);
}
