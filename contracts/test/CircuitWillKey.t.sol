// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {CircuitWillKey} from "../src/CircuitWillKey.sol";

contract CircuitWillKeyTest is Test {
    string internal constant JSON_PREFIX = "data:application/json;base64,";
    string internal constant SVG_PREFIX = "data:image/svg+xml;base64,";

    CircuitWillKey internal key;
    address internal owner = makeAddr("owner");

    function setUp() public {
        key = new CircuitWillKey();
    }

    function test_tokenURI_isOnChainJsonWithSvg() public {
        uint256 id = key.mint(owner);
        string memory json = _decodeDataUri(key.tokenURI(id), JSON_PREFIX);

        assertEq(vm.parseJsonString(json, ".name"), "CircuitWill Key #1");
        string memory description = vm.parseJsonString(json, ".description");
        assertTrue(_contains(description, "Whoever holds this NFT controls"));
        assertTrue(_contains(description, "hands over that control"));

        string memory svg = _decodeDataUri(vm.parseJsonString(json, ".image"), SVG_PREFIX);
        assertTrue(_startsWith(svg, "<svg xmlns='http://www.w3.org/2000/svg'"));
        assertTrue(_contains(svg, ">#1</text>"));
        assertTrue(_contains(svg, "Whoever holds this key controls a CircuitWill."));
        assertTrue(_contains(svg, "Transfer it only to hand over control."));
        assertTrue(_endsWith(svg, "</svg>"));
        // Chain-neutral: the art is fixed at deployment and the key may be deployed on any EVM chain.
        assertFalse(_contains(svg, "LAYER"));
        assertFalse(_contains(description, "Layer"));
    }

    function test_tokenURI_showsEachKeysOwnNumber() public {
        for (uint256 i; i < 11; i++) {
            key.mint(owner);
        }
        string memory json = _decodeDataUri(key.tokenURI(11), JSON_PREFIX);
        assertEq(vm.parseJsonString(json, ".name"), "CircuitWill Key #11");
        string memory svg = _decodeDataUri(vm.parseJsonString(json, ".image"), SVG_PREFIX);
        assertTrue(_contains(svg, ">#11</text>"));
        assertFalse(_contains(svg, ">#1</text>"));
    }

    function test_tokenURI_followsTheTokenNotTheHolder() public {
        uint256 id = key.mint(owner);
        string memory before = key.tokenURI(id);
        vm.prank(owner);
        key.transferFrom(owner, makeAddr("newOwner"), id);
        assertEq(key.tokenURI(id), before);
    }

    function test_tokenURI_revertsForUnmintedId() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        key.tokenURI(1);
        key.mint(owner);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 2));
        key.tokenURI(2);
    }

    // ---- helpers ----

    function _decodeDataUri(string memory uri, string memory prefix) internal pure returns (string memory) {
        bytes memory u = bytes(uri);
        bytes memory p = bytes(prefix);
        require(_startsWith(uri, prefix), "missing data URI prefix");
        bytes memory payload = new bytes(u.length - p.length);
        for (uint256 i; i < payload.length; i++) {
            payload[i] = u[p.length + i];
        }
        return string(_base64Decode(payload));
    }

    /// Standard-alphabet base64 with '=' padding (what OpenZeppelin's Base64.encode produces).
    function _base64Decode(bytes memory data) internal pure returns (bytes memory out) {
        require(data.length % 4 == 0, "base64 length");
        uint256 pad = data.length > 0 && data[data.length - 1] == "=" ? (data[data.length - 2] == "=" ? 2 : 1) : 0;
        out = new bytes((data.length / 4) * 3 - pad);
        uint256 o;
        for (uint256 i; i < data.length; i += 4) {
            uint256 n = (_b64(data[i]) << 18) | (_b64(data[i + 1]) << 12) | (_b64(data[i + 2]) << 6) | _b64(data[i + 3]);
            for (uint256 k; k < 3 && o < out.length; k++) {
                out[o++] = bytes1(uint8(n >> (16 - 8 * k)));
            }
        }
    }

    function _b64(bytes1 c) internal pure returns (uint256) {
        uint8 x = uint8(c);
        if (x >= 65 && x <= 90) return x - 65; // A-Z
        if (x >= 97 && x <= 122) return x - 71; // a-z
        if (x >= 48 && x <= 57) return x + 4; // 0-9
        if (c == "+") return 62;
        if (c == "/") return 63;
        if (c == "=") return 0;
        revert("base64 char");
    }

    function _contains(string memory s, string memory needle) internal pure returns (bool) {
        return vm.indexOf(s, needle) != type(uint256).max;
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        return vm.indexOf(s, prefix) == 0;
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(suffix);
        if (b.length > a.length) return false;
        for (uint256 i; i < b.length; i++) {
            if (a[a.length - b.length + i] != b[i]) return false;
        }
        return true;
    }
}
