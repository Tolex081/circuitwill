// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TEST DOUBLE of a TapeOut circuits contract. It interprets NAND-only netlists using the
///         semantics observed on X Layer mainnet (docs/TAPEOUT_INTERFACE.md):
///           - NAND element: 0x00 a:u24 b:u24; signals 0 = const0, 1 = const1, 2..1+nIn = inputs
///           - outputs are the last nOut signals; inputs/outputs bit-packed LSB-first; missing input bytes = 0
///         It is NOT the TapeOut implementation: no fees, no transistor burns, no LATCH/REF support.
///         The optional fork test (test/fork/TapeOutFork.t.sol) runs the same netlist on the real contract.
contract MockTapeOutCircuits {
    struct Circuit {
        uint32 nIn;
        uint32 nOut;
        uint32 gateCount;
        bytes nl;
    }

    uint256 public nextId; // last assigned id, like TapeOut
    mapping(uint256 => Circuit) internal _c;
    mapping(uint256 => address) public ownerOf;

    event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState);

    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256 id) {
        require(nOut > 0, "no outputs");
        require(nl.length % 7 == 0, "mock: NAND only");
        uint256 gates = nl.length / 7;
        for (uint256 i; i < gates; ++i) {
            uint256 p = i * 7;
            require(nl[p] == 0x00, "mock: NAND only");
            uint256 self = 2 + uint256(nIn) + i;
            require(_u24(nl, p + 1) < self && _u24(nl, p + 4) < self, "NAND: future signal");
        }
        require(gates >= nOut, "too few signals for outputs");
        id = ++nextId;
        _c[id] = Circuit(nIn, nOut, uint32(gates), nl);
        ownerOf[id] = msg.sender;
        emit TapedOut(id, msg.sender, uint32(gates), 0);
    }

    function circuitInfo(uint256 id) external view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) {
        Circuit storage c = _c[id];
        require(c.nOut != 0, "no circuit");
        return (c.nIn, c.nOut, 0, c.gateCount);
    }

    function netlist(uint256 id) external view returns (bytes memory) {
        require(_c[id].nOut != 0, "no circuit");
        return _c[id].nl;
    }

    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory out) {
        Circuit memory c = _c[id];
        require(c.nOut != 0, "no circuit");
        uint256 nIn = c.nIn;
        uint256 total = 2 + nIn + c.gateCount;
        bytes memory sig = new bytes(total);
        sig[1] = 0x01;
        for (uint256 i; i < nIn; ++i) {
            uint256 byteIdx = i >> 3;
            uint8 b = byteIdx < inputs.length ? uint8(inputs[byteIdx]) : 0;
            sig[2 + i] = bytes1((b >> (i & 7)) & 1);
        }
        bytes memory nl = c.nl;
        uint256 base = 2 + nIn;
        for (uint256 i; i < c.gateCount; ++i) {
            uint256 p = i * 7;
            uint8 a = uint8(sig[_u24m(nl, p + 1)]);
            uint8 bb = uint8(sig[_u24m(nl, p + 4)]);
            sig[base + i] = bytes1(1 - (a & bb));
        }
        out = new bytes((uint256(c.nOut) + 7) / 8);
        uint256 first = total - c.nOut;
        for (uint256 o; o < c.nOut; ++o) {
            out[o >> 3] = bytes1(uint8(out[o >> 3]) | (uint8(sig[first + o]) << uint8(o & 7)));
        }
    }

    function _u24(bytes calldata d, uint256 p) private pure returns (uint256) {
        return (uint256(uint8(d[p])) << 16) | (uint256(uint8(d[p + 1])) << 8) | uint256(uint8(d[p + 2]));
    }

    function _u24m(bytes memory d, uint256 p) private pure returns (uint256) {
        return (uint256(uint8(d[p])) << 16) | (uint256(uint8(d[p + 1])) << 8) | uint256(uint8(d[p + 2]));
    }
}

contract MockTapeOutFactory {
    mapping(address => bool) public isCPU;

    function register(address circuits) external {
        isCPU[circuits] = true;
    }
}
