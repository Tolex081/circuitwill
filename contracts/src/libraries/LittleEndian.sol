// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Writes the low `n` bytes of a word, least significant byte first. With TapeOut's LSB-first bit order
///         this puts word bit i at input bit i.
/// @dev Callers range-check every field before building `word`, so no set bit lies above 8 * n.
library LittleEndian {
    function toBytes(uint256 word, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 j; j < n; ++j) {
            // Byte extraction from a range-checked word.
            out[j] = bytes1(uint8(word >> (8 * j)));
        }
    }
}
