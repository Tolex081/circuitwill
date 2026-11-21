// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {CircuitWillEscrow} from "../src/CircuitWillEscrow.sol";
import {CircuitWillKey} from "../src/CircuitWillKey.sol";
import {ITapeOutFactory} from "../src/interfaces/ITapeOut.sol";

/// @notice Deploys a CircuitWillEscrow and, if the broadcaster holds the controller NFT, configures it.
/// @dev NOT RUN AGAINST A LIVE NETWORK BY THIS PROJECT. See README "Deployment configuration".
///
///      Environment:
///        TOKEN                    ERC-20 held by the escrow (default: USDT0 on X Layer)
///        TAPEOUT_FACTORY          TapeOut factory for the isCPU check (default: X Layer factory; 0x0 disables)
///        CONTROLLER_NFT           leave unset: production uses CircuitWillKey (project decision). Only for tests
///                                 with another non-burnable ERC-721
///        CIRCUITWILL_KEY          existing CircuitWillKey to mint from (optional)
///        CONTROLLER_TOKEN_ID      token id when CONTROLLER_NFT is set
///        TAPEOUT_CIRCUITS         processor (circuits contract) holding the taped-out circuits
///        DAILY_CAP_CIRCUIT_ID     circuit id of the Daily Cap netlist (required)
///        DAILY_CAP                cap in token base units (<= 4294967295)
///        WHITELIST_CIRCUIT_ID     Payee Whitelist + Cooling-off circuit id (optional, 0 = not attached)
///        TRIAL_LIMIT              largest payment to a payee that is not saved (<= 4294967295, default 0)
///        COOLING_OFF_HOURS        hours before a new payee can be paid (<= 65535, default 0)
///        SAVED_PAYEES             comma-separated addresses to add as saved (optional)
///        CONFIRMATION_CIRCUIT_ID  Confirmation Threshold circuit id (optional, 0 = not attached)
///        CONFIRMATION_THRESHOLD   payments above this need confirmPayment (<= 4294967295, default 0)
///        FREEZE_CIRCUIT_ID        Freeze circuit id (optional, 0 = not attached)
///        AGENT                    agent key (optional)
///      With the whitelist attached, withdrawals to the controller's own wallet also need that wallet saved.
contract Deploy is Script {
    address internal constant X_LAYER_USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant X_LAYER_TAPEOUT_FACTORY = 0x1f09DAeFA827f02CBb40967cc91b259763760761;

    struct Config {
        address processor;
        uint256 dailyCapId;
        uint256 cap;
        uint256 whitelistId;
        uint256 trialLimit;
        uint256 coolingOffHours;
        address[] savedPayees;
        uint256 confirmationId;
        uint256 threshold;
        uint256 freezeId;
        address agent;
    }

    function _config() internal view returns (Config memory c) {
        c.processor = vm.envAddress("TAPEOUT_CIRCUITS");
        c.dailyCapId = vm.envUint("DAILY_CAP_CIRCUIT_ID");
        c.cap = vm.envUint("DAILY_CAP");
        c.whitelistId = vm.envOr("WHITELIST_CIRCUIT_ID", uint256(0));
        c.trialLimit = vm.envOr("TRIAL_LIMIT", uint256(0));
        c.coolingOffHours = vm.envOr("COOLING_OFF_HOURS", uint256(0));
        c.savedPayees = vm.envOr("SAVED_PAYEES", ",", new address[](0));
        c.confirmationId = vm.envOr("CONFIRMATION_CIRCUIT_ID", uint256(0));
        c.threshold = vm.envOr("CONFIRMATION_THRESHOLD", uint256(0));
        c.freezeId = vm.envOr("FREEZE_CIRCUIT_ID", uint256(0));
        c.agent = vm.envOr("AGENT", address(0));
        require(c.cap <= type(uint32).max, "DAILY_CAP exceeds uint32");
        require(c.trialLimit <= type(uint32).max, "TRIAL_LIMIT exceeds uint32");
        require(c.coolingOffHours <= type(uint16).max, "COOLING_OFF_HOURS exceeds uint16");
        require(c.threshold <= type(uint32).max, "CONFIRMATION_THRESHOLD exceeds uint32");
    }

    function run() external returns (CircuitWillEscrow escrow) {
        address token = vm.envOr("TOKEN", X_LAYER_USDT0);
        address factory = vm.envOr("TAPEOUT_FACTORY", X_LAYER_TAPEOUT_FACTORY);
        address nft = vm.envOr("CONTROLLER_NFT", address(0));
        uint256 tokenId = vm.envOr("CONTROLLER_TOKEN_ID", uint256(0));
        Config memory c = _config();

        vm.startBroadcast();
        if (nft == address(0)) {
            address existing = vm.envOr("CIRCUITWILL_KEY", address(0));
            CircuitWillKey key = existing == address(0) ? new CircuitWillKey() : CircuitWillKey(existing);
            tokenId = key.mint(msg.sender);
            nft = address(key);
        }
        escrow = new CircuitWillEscrow(IERC20(token), IERC721(nft), tokenId, ITapeOutFactory(factory));

        if (IERC721(nft).ownerOf(tokenId) == msg.sender) {
            _configure(escrow, c);
        } else {
            console2.log("Broadcaster does not own the controller NFT; the owner must attach and configure.");
        }
        vm.stopBroadcast();

        console2.log("CircuitWillEscrow:", address(escrow));
        console2.log("controller NFT:", nft);
        console2.log("controller token id:", tokenId);
    }

    function _configure(CircuitWillEscrow escrow, Config memory c) internal {
        // Parameters first, then circuits: each circuit is live as soon as it is attached.
        escrow.setDailyCap(c.cap);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, c.processor, c.dailyCapId);
        if (c.whitelistId != 0) {
            escrow.setTrialLimit(c.trialLimit);
            escrow.setCoolingOffHours(c.coolingOffHours);
            for (uint256 i; i < c.savedPayees.length; ++i) {
                escrow.setPayee(c.savedPayees[i], true);
            }
            escrow.attachCircuit(CircuitWillEscrow.CircuitKind.WHITELIST, c.processor, c.whitelistId);
        }
        if (c.confirmationId != 0) {
            escrow.setConfirmationThreshold(c.threshold);
            escrow.attachCircuit(CircuitWillEscrow.CircuitKind.CONFIRMATION, c.processor, c.confirmationId);
        }
        if (c.freezeId != 0) {
            escrow.attachCircuit(CircuitWillEscrow.CircuitKind.FREEZE, c.processor, c.freezeId);
        }
        if (c.agent != address(0)) escrow.setAgent(c.agent);
    }
}
