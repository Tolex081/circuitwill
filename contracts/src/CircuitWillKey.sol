// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Non-burnable, non-upgradeable ERC-721 that can serve as the controller NFT of a
///         CircuitWillEscrow. Whoever holds the token controls the escrow.
/// @dev There is deliberately no burn function, so `ownerOf` keeps working for every minted id and
///      an escrow can never lose its controller. Minting is permissionless: each user mints a fresh
///      id for their own will.
contract CircuitWillKey is ERC721 {
    uint256 public totalMinted;

    constructor() ERC721("CircuitWill Key", "CWKEY") {}

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = ++totalMinted;
        _safeMint(to, tokenId);
    }
}
