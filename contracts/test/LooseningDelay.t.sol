// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {Base} from "./Base.t.sol";
import {CircuitWillEscrow} from "../src/CircuitWillEscrow.sol";
import {ITapeOutFactory} from "../src/interfaces/ITapeOut.sol";

/// @notice "Tightening is instant, loosening waits" (docs/RULE_SUGGESTIONS.md section 7, with detach by uid).
///         Base setUp: Daily Cap attached (cap 50 USDT0), agent set.
contract LooseningDelayTest is Base {
    uint256 internal constant DELAY = 24 hours;

    function queue(CircuitWillEscrow.ChangeKind kind, address target, uint256 value) internal returns (uint256 id) {
        vm.prank(owner);
        id = escrow.queueChange(kind, target, value);
    }

    function apply_(uint256 id) internal {
        vm.prank(owner);
        escrow.applyChange(id);
    }

    function test_settersTightenAtOnceAndRefuseToLoosen() public {
        vm.startPrank(owner);
        escrow.setDailyCap(40 * USDT); // lower: at once
        escrow.setDailyCap(40 * USDT); // equal: at once
        vm.expectRevert(CircuitWillEscrow.LooseningIsDelayed.selector);
        escrow.setDailyCap(41 * USDT);

        vm.expectRevert(CircuitWillEscrow.LooseningIsDelayed.selector);
        escrow.setTrialLimit(1);
        escrow.setTrialLimit(0);

        escrow.setCoolingOffHours(48); // longer: at once
        vm.expectRevert(CircuitWillEscrow.LooseningIsDelayed.selector);
        escrow.setCoolingOffHours(47);

        vm.expectRevert(CircuitWillEscrow.LooseningIsDelayed.selector);
        escrow.setConfirmationThreshold(1);

        escrow.setPayee(payee, false); // new payee, unsaved: its cooling-off is the delay
        vm.expectRevert(CircuitWillEscrow.LooseningIsDelayed.selector);
        escrow.setPayee(payee, true);
        escrow.removePayee(payee); // always at once

        escrow.setRuleDelay(2 days); // longer: at once
        vm.expectRevert(CircuitWillEscrow.LooseningIsDelayed.selector);
        escrow.setRuleDelay(1 days);

        vm.expectRevert(CircuitWillEscrow.LooseningIsDelayed.selector);
        escrow.setBeneficiary(stranger);
        escrow.setBeneficiary(address(0));

        // Unchanged by the delay: agent, eval gas limit, confirmations.
        escrow.setAgent(stranger);
        escrow.setEvalGasLimit(5_000_000);
        escrow.confirmPayment(keccak256("x"));
        vm.stopPrank();
        assertEq(escrow.dailyCap(), 40 * USDT);
        assertEq(escrow.coolingOffHours(), 48);
    }

    function test_setupBeforeFirstCircuitIsImmediate() public {
        CircuitWillEscrow e = new CircuitWillEscrow(
            IERC20(address(usdt)), IERC721(address(key)), keyId, ITapeOutFactory(address(factory))
        );
        vm.startPrank(owner);
        e.setDailyCap(100 * USDT);
        e.setTrialLimit(5 * USDT);
        e.setCoolingOffHours(0);
        e.setConfirmationThreshold(20 * USDT);
        e.setPayee(payee, true);
        e.setBeneficiary(stranger);
        e.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(processor), dailyCapId);
        vm.expectRevert(CircuitWillEscrow.LooseningIsDelayed.selector);
        e.setDailyCap(101 * USDT);
        vm.stopPrank();
    }

    function test_queueApplyAfterDelay_emitsTheSetterEvent() public {
        uint256 id = queue(CircuitWillEscrow.ChangeKind.DAILY_CAP, address(0), 80 * USDT);
        (CircuitWillEscrow.ChangeKind kind, uint64 eta, address target, address by, uint256 value) =
            escrow.pendingChanges(id);
        assertEq(uint8(kind), uint8(CircuitWillEscrow.ChangeKind.DAILY_CAP));
        assertEq(eta, T0 + DELAY);
        assertEq(target, address(0));
        assertEq(by, owner);
        assertEq(value, 80 * USDT);

        vm.warp(T0 + DELAY - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.ChangeNotReady.selector, uint64(T0 + DELAY)));
        escrow.applyChange(id);

        // A payment while the change is pending is decided under the old rule.
        vm.prank(agentKey);
        (, bool a) = escrow.proposePayment(payee, 60 * USDT, "");
        assertFalse(a, "still capped at 50");

        vm.warp(T0 + DELAY);
        vm.expectEmit(address(escrow));
        emit CircuitWillEscrow.DailyCapSet(50 * USDT, 80 * USDT, owner);
        vm.expectEmit(address(escrow));
        emit CircuitWillEscrow.ChangeApplied(id, owner);
        apply_(id);
        assertEq(escrow.dailyCap(), 80 * USDT);
        vm.prank(agentKey);
        (, a) = escrow.proposePayment(payee, 60 * USDT, "");
        assertTrue(a);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.UnknownChange.selector, id));
        escrow.applyChange(id); // only once
    }

    function test_expiredChangeCannotBeApplied() public {
        uint256 id = queue(CircuitWillEscrow.ChangeKind.DAILY_CAP, address(0), 80 * USDT);
        vm.warp(T0 + DELAY + 7 days + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.ChangeExpired.selector, uint64(T0 + DELAY)));
        escrow.applyChange(id);
    }

    function test_cancel() public {
        uint256 id = queue(CircuitWillEscrow.ChangeKind.TRIAL_LIMIT, address(0), 5 * USDT);
        vm.prank(owner);
        escrow.cancelChange(id);
        vm.warp(T0 + DELAY);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.UnknownChange.selector, id));
        escrow.applyChange(id);
    }

    function test_nftTransferKillsChangesQueuedByThePreviousOwner() public {
        uint256 id = queue(CircuitWillEscrow.ChangeKind.DAILY_CAP, address(0), 1_000 * USDT);
        vm.prank(owner);
        key.transferFrom(owner, newOwner, keyId);
        vm.warp(T0 + DELAY);
        vm.prank(newOwner);
        vm.expectRevert(CircuitWillEscrow.QueuedByPreviousController.selector);
        escrow.applyChange(id);
        vm.prank(owner);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.applyChange(id);
    }

    function test_detachByUid_survivesIndexMoves() public {
        vm.startPrank(owner);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.WHITELIST, address(processor), whitelistId); // index 1
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.FREEZE, address(processor), freezeId); // index 2
        vm.stopPrank();
        uint64 dailyUid = escrow.circuitAt(0).uid;
        uint64 freezeUid = escrow.circuitAt(2).uid;
        uint256 a = queue(CircuitWillEscrow.ChangeKind.DETACH_CIRCUIT, address(0), dailyUid);
        uint256 b = queue(CircuitWillEscrow.ChangeKind.DETACH_CIRCUIT, address(0), freezeUid);
        uint256 c = queue(CircuitWillEscrow.ChangeKind.DETACH_CIRCUIT, address(0), freezeUid);
        vm.warp(T0 + DELAY);
        apply_(a); // Freeze moves from index 2 to index 0
        assertEq(escrow.circuitAt(0).uid, freezeUid);
        apply_(b); // still finds Freeze by uid
        assertEq(escrow.circuitCount(), 1);
        assertEq(uint8(escrow.circuitAt(0).kind), uint8(CircuitWillEscrow.CircuitKind.WHITELIST));
        vm.prank(owner);
        vm.expectRevert(CircuitWillEscrow.ChangeTargetGone.selector);
        escrow.applyChange(c);
    }

    function test_ruleDelay_shorteningWaitsTheOldDelay() public {
        vm.prank(owner);
        escrow.setRuleDelay(3 days);
        uint256 id = queue(CircuitWillEscrow.ChangeKind.RULE_DELAY, address(0), 1 hours);
        (, uint64 eta,,,) = escrow.pendingChanges(id);
        assertEq(eta, T0 + 3 days, "waits the current (longer) delay");
        vm.warp(T0 + 3 days);
        apply_(id);
        assertEq(escrow.ruleDelay(), 1 hours);
    }

    function test_queueChecksRangesAtOnce() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.ValueOutOfRange.selector, U32_MAX + 1, U32_MAX));
        escrow.queueChange(CircuitWillEscrow.ChangeKind.DAILY_CAP, address(0), U32_MAX + 1);
        vm.expectRevert(
            abi.encodeWithSelector(CircuitWillEscrow.ValueOutOfRange.selector, 65_536, uint256(type(uint16).max))
        );
        escrow.queueChange(CircuitWillEscrow.ChangeKind.COOLING_OFF_HOURS, address(0), 65_536);
        vm.expectRevert(CircuitWillEscrow.ZeroAddress.selector);
        escrow.queueChange(CircuitWillEscrow.ChangeKind.SAVE_PAYEE, address(0), 0);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.UnknownCircuit.selector, uint64(42)));
        escrow.queueChange(CircuitWillEscrow.ChangeKind.DETACH_CIRCUIT, address(0), 42);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.ValueOutOfRange.selector, 59 minutes, 30 days));
        escrow.queueChange(CircuitWillEscrow.ChangeKind.RULE_DELAY, address(0), 59 minutes);
        vm.stopPrank();
    }

    function test_agentAndStrangersCannotQueueApplyOrCancel() public {
        uint256 id = queue(CircuitWillEscrow.ChangeKind.DAILY_CAP, address(0), 80 * USDT);
        vm.warp(T0 + DELAY);
        address[2] memory who = [agentKey, stranger];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(who[i]);
            vm.expectRevert(CircuitWillEscrow.NotController.selector);
            escrow.queueChange(CircuitWillEscrow.ChangeKind.DAILY_CAP, address(0), 1);
            vm.expectRevert(CircuitWillEscrow.NotController.selector);
            escrow.applyChange(id);
            vm.expectRevert(CircuitWillEscrow.NotController.selector);
            escrow.cancelChange(id);
            vm.expectRevert(CircuitWillEscrow.NotController.selector);
            escrow.checkIn();
            vm.stopPrank();
        }
    }

    function test_savePayeeAndUnfreezeThroughTheQueue() public {
        vm.startPrank(owner);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.FREEZE, address(processor), freezeId);
        escrow.setFrozen(true); // at once
        vm.stopPrank();
        uint256 u = queue(CircuitWillEscrow.ChangeKind.UNFREEZE, address(0), 0);
        uint256 s = queue(CircuitWillEscrow.ChangeKind.SAVE_PAYEE, payee, 0);
        vm.warp(T0 + DELAY);
        apply_(u);
        apply_(s);
        assertFalse(escrow.frozen());
        (uint64 firstSeen, bool saved,) = escrow.payees(payee);
        assertTrue(saved);
        assertEq(firstSeen, T0 + DELAY);
    }
}
