// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Base: reports a valid pinout (Daily Cap by default; see `setNIn`) so it can be attached, then misbehaves
///      in `eval`.
abstract contract PinoutOk {
    uint32 public nIn = 96;

    function setNIn(uint32 n) external {
        nIn = n;
    }

    function circuitInfo(uint256) external view returns (uint32, uint32, uint32, uint32) {
        return (nIn, 1, 0, 447);
    }

    function netlist(uint256) external pure returns (bytes memory) {
        return hex"00000002000003";
    }
}

/// @dev Switchable processor: behaves well (always allow) until `mode` is changed.
contract SwitchableProcessor is PinoutOk {
    enum Mode {
        ALLOW,
        DENY,
        REVERT,
        EMPTY_RETURN,
        WRONG_LENGTH,
        BAD_OFFSET,
        HUGE_RETURN,
        BURN_GAS,
        RAW_GARBAGE
    }

    Mode public mode;

    function setMode(Mode m) external {
        mode = m;
    }

    function eval(uint256, bytes calldata) external view returns (bytes memory) {
        Mode m = mode;
        if (m == Mode.ALLOW) return hex"01";
        if (m == Mode.DENY) return hex"00";
        if (m == Mode.REVERT) revert("has latch: use step");
        if (m == Mode.EMPTY_RETURN) {
            assembly {
                return(0, 0)
            }
        }
        if (m == Mode.WRONG_LENGTH) return hex"0101";
        if (m == Mode.BAD_OFFSET) {
            assembly {
                mstore(0, 0x40)
                mstore(0x20, 1)
                mstore(0x40, shl(248, 1))
                return(0, 0x60)
            }
        }
        if (m == Mode.HUGE_RETURN) {
            assembly {
                mstore(0, 0x20)
                mstore(0x20, 1)
                mstore(0x40, shl(248, 1))
                return(0, 100000)
            }
        }
        if (m == Mode.BURN_GAS) {
            uint256 x;
            while (true) {
                x = uint256(keccak256(abi.encode(x)));
            }
        }
        // RAW_GARBAGE: 3 bytes that are not abi-encoded `bytes`.
        assembly {
            mstore(0, shl(232, 0x010101))
            return(0, 3)
        }
    }
}

/// @dev Forwards every call to `target` with all its gas (like a proxy hop), returning or reverting with the result.
///      A starved call behind it fails without using the caller's whole gas limit (EIP-150 keeps 1/64 here), which is
///      how real TapeOut circuits contracts (beacon proxies) behave.
contract ForwardingProxy {
    address public immutable target;

    constructor(address t) {
        target = t;
    }

    /// @dev Assembly forwarding like an OpenZeppelin proxy: after a failed inner call only a few gas are spent on
    ///      the revert, so the 1/64 kept back is not burned here.
    fallback() external {
        address t = target;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := staticcall(gas(), t, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
