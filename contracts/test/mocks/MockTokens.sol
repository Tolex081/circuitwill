// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev 6-decimal stand-in for USDT0 in local tests.
contract MockUSDT0 is ERC20 {
    bool public frozen;

    constructor() ERC20("Mock USDT0", "USDT0") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Simulates a token-level failure (for example a blacklisted sender).
    function setFrozen(bool f) external {
        frozen = f;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!frozen, "frozen");
        super._update(from, to, value);
    }
}

/// @dev Burnable ERC-721 used only to show why a burnable controller NFT is unsafe.
contract BurnableNft is ERC721 {
    constructor() ERC721("Burnable", "BRN") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function burn(uint256 id) external {
        require(ownerOf(id) == msg.sender, "not owner");
        _burn(id);
    }
}
