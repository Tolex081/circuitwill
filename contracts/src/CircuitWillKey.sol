// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Non-burnable, non-upgradeable ERC-721 that can serve as the controller NFT of a
///         CircuitWillEscrow. Whoever holds the token controls the escrow.
/// @dev There is deliberately no burn function, so `ownerOf` keeps working for every minted id and
///      an escrow can never lose its controller. Minting is permissionless: each user mints a fresh
///      id for their own will.
///      `tokenURI` returns fully on-chain metadata (a base64 JSON data URI with an SVG image), so
///      wallets show the key with a plain warning that holding it means controlling the will. There
///      is no off-chain host to go down and no admin who could change the art.
contract CircuitWillKey is ERC721 {
    uint256 public totalMinted;

    string private constant DESCRIPTION = "The controller key of a CircuitWill on X Layer. Whoever holds this NFT controls "
        "the will's rules and can withdraw its money. Selling or transferring it hands over that control.";

    constructor() ERC721("CircuitWill Key", "CWKEY") {}

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = ++totalMinted;
        _safeMint(to, tokenId);
    }

    /// @notice On-chain metadata for `tokenId`. Reverts for ids that were never minted.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory id = Strings.toString(tokenId);
        string memory json = string.concat(
            '{"name":"CircuitWill Key #',
            id,
            '","description":"',
            DESCRIPTION,
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(id))),
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev 400x400 card in the dashboard's dark palette: the gate mark, the key number, one bar per
    ///      rule colour (daily limit, trusted recipients, approval, freeze) and the control warning.
    ///      Only generic font families, because wallets render the image without web fonts.
    function _svg(string memory id) private pure returns (string memory) {
        return string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400' width='400' height='400'>",
            "<rect width='400' height='400' fill='#111514'/>",
            "<rect x='20' y='20' width='360' height='360' rx='20' fill='#181d1c' stroke='#2a3130' stroke-width='1.5'/>",
            "<g fill='none' stroke-width='2.1' stroke-linecap='round' stroke-linejoin='round' transform='translate(44 44) scale(2.5)'>",
            "<path d='M9.5 8.5h6a7.5 7.5 0 0 1 0 15h-6zM3.5 12.5h6M3.5 19.5h6' stroke='#e8e4dc'/>",
            "<circle cx='25.25' cy='16' r='2.25' stroke='#9cb2ff'/></g>",
            "<text x='352' y='88' text-anchor='end' font-family='Menlo,Consolas,monospace' font-size='13' letter-spacing='2' fill='#a0a7a2'>X LAYER</text>",
            "<text x='48' y='196' font-family='Georgia,serif' font-size='32' fill='#e8e4dc'>CircuitWill Key</text>",
            "<text x='48' y='268' font-family='Menlo,Consolas,monospace' font-size='60' fill='#9cb2ff'>#",
            id,
            "</text>",
            "<rect x='48' y='296' width='70' height='4' rx='2' fill='#d39ef3'/>",
            "<rect x='126' y='296' width='70' height='4' rx='2' fill='#65d2d3'/>",
            "<rect x='204' y='296' width='70' height='4' rx='2' fill='#f893bc'/>",
            "<rect x='282' y='296' width='70' height='4' rx='2' fill='#a1c3db'/>",
            "<text font-family='Helvetica,Arial,sans-serif' font-size='14' fill='#a0a7a2'>",
            "<tspan x='48' y='332'>Whoever holds this key controls a CircuitWill.</tspan>",
            "<tspan x='48' y='352'>Transfer it only to hand over control.</tspan></text></svg>"
        );
    }
}
