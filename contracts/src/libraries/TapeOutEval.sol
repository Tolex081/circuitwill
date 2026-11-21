// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ITapeOutCircuits} from "../interfaces/ITapeOut.sol";

/// @notice Fail-closed adapter around TapeOut `eval`. It never reverts: every failure mode is
///         reported as a status so the caller can record a blocked decision.
library TapeOutEval {
    enum Status {
        NOT_EVALUATED, // 0: skipped (for example, inputs could not be packed)
        ALLOW, // 1: circuit returned output bit 0 = 1
        DENY, // 2: circuit returned output bit 0 = 0
        REVERTED, // 3: eval reverted or ran out of gas
        MALFORMED_OUTPUT // 4: no code at the processor, or return data is not abi-encoded `bytes` of the expected length
    }

    /// @dev Upper bound on the return data we copy. A correct single-output eval returns exactly 96 bytes
    ///      (offset, length, one padded word). Copying a fixed amount stops return-data bombs.
    uint256 private constant COPY = 96;

    /// @dev A call that runs out of gas behind proxies does not use its whole gas limit: every call or delegatecall
    ///      hop keeps back 1/64 of its gas (EIP-150) and reverts with it. TapeOut circuits contracts are beacon
    ///      proxies. A failed call that used at least `gasLimit - gasLimit / EXHAUSTION_SLACK` is treated as having
    ///      run out of gas: 1/16 covers four nested hops ((63/64)^4 ≈ 0.939).
    uint256 private constant EXHAUSTION_SLACK = 16;

    /// @param processor TapeOut circuits contract.
    /// @param circuitId Circuit id on that contract.
    /// @param input     Bit-packed (LSB-first) circuit inputs.
    /// @param outBytes  Expected output length in bytes (ceil(nOut / 8)); 1 for every CircuitWill circuit.
    /// @param gasLimit  Gas forwarded to the call.
    /// @return status    Evaluation result.
    /// @return output    The output bytes (only for ALLOW / DENY).
    /// @return exhausted True if the call failed after using at least `gasLimit - gasLimit / EXHAUSTION_SLACK` gas
    ///                   (measured around the call, including its own overhead), i.e. it most likely ran out of the
    ///                   gas it was given, possibly inside a proxy.
    function evalFirstBit(address processor, uint256 circuitId, bytes memory input, uint256 outBytes, uint256 gasLimit)
        internal
        view
        returns (Status status, bytes memory output, bool exhausted)
    {
        bytes memory data = abi.encodeCall(ITapeOutCircuits.eval, (circuitId, input));
        bool ok;
        uint256 size;
        uint256 used;
        uint256 w0;
        uint256 w1;
        uint256 w2;
        assembly ("memory-safe") {
            let g0 := gas()
            ok := staticcall(gasLimit, processor, add(data, 0x20), mload(data), 0, 0)
            used := sub(g0, gas())
            size := returndatasize()
            if and(ok, iszero(lt(size, COPY))) {
                let ptr := mload(0x40)
                returndatacopy(ptr, 0, COPY)
                w0 := mload(ptr)
                w1 := mload(add(ptr, 0x20))
                w2 := mload(add(ptr, 0x40))
            }
        }
        if (!ok) return (Status.REVERTED, "", used >= gasLimit - gasLimit / EXHAUSTION_SLACK);
        // abi.encode(bytes) = offset 0x20 | length | data padded to 32 bytes.
        if (size != COPY || w0 != 0x20 || w1 != outBytes || outBytes == 0 || outBytes > 32) {
            return (Status.MALFORMED_OUTPUT, "", false);
        }
        output = new bytes(outBytes);
        assembly ("memory-safe") {
            mstore(add(output, 0x20), w2)
        }
        status = (uint8(output[0]) & 1) == 1 ? Status.ALLOW : Status.DENY;
    }
}
