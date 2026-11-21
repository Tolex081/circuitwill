// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {Base} from "./Base.t.sol";
import {CircuitWillEscrow} from "../src/CircuitWillEscrow.sol";
import {ITapeOutFactory} from "../src/interfaces/ITapeOut.sol";
import {TapeOutEval} from "../src/libraries/TapeOutEval.sol";
import {ForwardingProxy, SwitchableProcessor} from "./mocks/HostileProcessors.sol";

interface ITapeOutReader {
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
    function netlist(uint256 id) external view returns (bytes memory);
}

/// @notice The escrow with all four rule circuits attached (generated netlists on the NAND-interpreting mock).
///         Parameters: daily cap 50, trial limit 5, cooling-off 24 h, confirmation threshold 20 (USDT0).
contract MultiCircuitTest is Base {
    uint256 internal constant TRIAL = 5 * USDT;
    uint256 internal constant COOLING = 24;
    uint256 internal constant THRESHOLD = 20 * USDT;

    address internal payee2 = makeAddr("payee2");
    address internal newPayee = makeAddr("newPayee");

    uint8 internal constant K_DAILY = uint8(CircuitWillEscrow.CircuitKind.DAILY_CAP);
    uint8 internal constant K_WL = uint8(CircuitWillEscrow.CircuitKind.WHITELIST);
    uint8 internal constant K_CONF = uint8(CircuitWillEscrow.CircuitKind.CONFIRMATION);
    uint8 internal constant K_FREEZE = uint8(CircuitWillEscrow.CircuitKind.FREEZE);

    function setUp() public override {
        super.setUp(); // Daily Cap attached at index 0, cap 50, agent set
        vm.startPrank(owner);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.WHITELIST, address(processor), whitelistId);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.CONFIRMATION, address(processor), confirmationId);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.FREEZE, address(processor), freezeId);
        escrow.setTrialLimit(TRIAL);
        escrow.setCoolingOffHours(COOLING);
        escrow.setConfirmationThreshold(THRESHOLD);
        escrow.setPayee(payee, true);
        escrow.setPayee(payee2, true);
        escrow.setPayee(owner, true);
        vm.stopPrank();
    }

    // ================================================================ helpers

    function _propose(address to, uint256 amount) internal returns (bool allowed) {
        vm.prank(agentKey);
        (, allowed) = escrow.proposePayment(to, amount, "");
    }

    function _confirm(address to, uint256 amount) internal returns (bytes32 h) {
        h = escrow.currentPaymentHash(to, amount);
        vm.prank(owner);
        escrow.confirmPayment(h);
    }

    function _statuses(CircuitLog[] memory cs) internal pure returns (uint8[4] memory s) {
        for (uint256 i; i < 4; ++i) {
            s[i] = cs[i].status;
        }
    }

    uint8 internal constant A = 1; // ALLOW
    uint8 internal constant D = 2; // DENY
    uint8 internal constant NE = 0; // NOT_EVALUATED

    function _expectStatuses(Vm.Log[] memory logs, uint8[4] memory want) internal view {
        CircuitLog[] memory cs = circuitLogs(logs);
        assertEq(cs.length, 4, "four circuits evaluated");
        for (uint256 i; i < 4; ++i) {
            assertEq(cs[i].status, want[i], string.concat("status of circuit ", vm.toString(i)));
        }
    }

    // ================================================================ all four attached

    function test_allFourAttached() public view {
        assertEq(escrow.circuitCount(), 4);
        CircuitWillEscrow.AttachedCircuit[] memory cs = escrow.circuits();
        assertEq(uint8(cs[0].kind), K_DAILY);
        assertEq(uint8(cs[1].kind), K_WL);
        assertEq(uint8(cs[2].kind), K_CONF);
        assertEq(uint8(cs[3].kind), K_FREEZE);
        assertEq(cs[1].netlistHash, keccak256(whitelistNetlist()));
        assertEq(cs[2].netlistHash, keccak256(confirmationNetlist()));
        assertEq(cs[3].netlistHash, keccak256(freezeNetlist()));
    }

    function test_enumValuesAreStable() public pure {
        // Part of the public event format: Phase 1 values unchanged, new kinds appended.
        assertEq(uint8(CircuitWillEscrow.CircuitKind.NONE), 0);
        assertEq(uint8(CircuitWillEscrow.CircuitKind.DAILY_CAP), 1);
        assertEq(uint8(CircuitWillEscrow.CircuitKind.WHITELIST), 2);
        assertEq(uint8(CircuitWillEscrow.CircuitKind.CONFIRMATION), 3);
        assertEq(uint8(CircuitWillEscrow.CircuitKind.FREEZE), 4);
    }

    function test_allowedPaymentRecordsAllFourInputs() public {
        vm.recordLogs();
        assertTrue(_propose(payee, 10 * USDT));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        CircuitLog[] memory cs = circuitLogs(logs);
        assertEq(cs.length, 4);
        assertEq(cs[0].input, packDailyCap(10 * USDT, 0, 50 * USDT));
        assertEq(cs[1].input, packWhitelist(true, 0, 10 * USDT, TRIAL, COOLING));
        assertEq(cs[2].input, packConfirmation(10 * USDT, THRESHOLD, false));
        assertEq(cs[3].input, hex"00");
        for (uint256 i; i < 4; ++i) {
            assertEq(cs[i].index, i);
            assertEq(cs[i].status, A);
            assertEq(cs[i].output, hex"01");
        }
        assertEq(usdt.balanceOf(payee), 10 * USDT);
        assertEq(escrow.spentToday(), 10 * USDT);
        assertEq(countTopic(logs, CircuitWillEscrow.ConfirmationConsumed.selector), 0);
    }

    function test_eachCircuitCanBlockAlone() public {
        // Daily Cap: 51 to a saved payee, confirmed (51 > threshold 20).
        _confirm(payee, 51 * USDT);
        vm.recordLogs();
        assertFalse(_propose(payee, 51 * USDT));
        _expectStatuses(vm.getRecordedLogs(), [D, A, A, A]);

        // Whitelist: 1 to an unknown payee.
        vm.recordLogs();
        assertFalse(_propose(stranger, 1 * USDT));
        _expectStatuses(vm.getRecordedLogs(), [A, D, A, A]);

        // Confirmation: 21 to a saved payee without confirmation.
        vm.recordLogs();
        assertFalse(_propose(payee, 21 * USDT));
        _expectStatuses(vm.getRecordedLogs(), [A, A, D, A]);

        // Freeze.
        vm.prank(owner);
        escrow.setFrozen(true);
        vm.recordLogs();
        assertFalse(_propose(payee, 1 * USDT));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _expectStatuses(logs, [A, A, A, D]);
        assertEq(decisionLogs(logs)[0].reason, reason(CircuitWillEscrow.Reason.CIRCUIT_DENIED));

        assertEq(usdt.balanceOf(payee), 0);
        assertEq(usdt.balanceOf(stranger), 0);
        assertEq(escrow.spentToday(), 0);
    }

    function test_amountAboveUint32_notEvaluatedNotTruncated() public {
        vm.recordLogs();
        assertFalse(_propose(payee, U32_MAX + 2));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _expectStatuses(logs, [NE, NE, NE, A]); // Freeze does not read the amount
        CircuitLog[] memory cs = circuitLogs(logs);
        assertEq(cs[0].input.length, 0);
        assertEq(cs[1].input.length, 0);
        assertEq(cs[2].input.length, 0);
        assertEq(decisionLogs(logs)[0].reason, reason(CircuitWillEscrow.Reason.INPUT_OUT_OF_RANGE));
    }

    // ================================================================ confirmation

    function test_confirmation_allowsExactPaymentOnce() public {
        assertFalse(_propose(payee, 30 * USDT), "above threshold, unconfirmed");

        bytes32 h = _confirm(payee, 30 * USDT);
        assertEq(h, escrow.hashPayment(payee, 30 * USDT, 0));
        assertTrue(escrow.isPaymentConfirmed(payee, 30 * USDT));

        vm.recordLogs();
        assertTrue(_propose(payee, 30 * USDT), "confirmed");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        CircuitLog[] memory cs = circuitLogs(logs);
        assertEq(cs[2].input, packConfirmation(30 * USDT, THRESHOLD, true));
        assertEq(countTopic(logs, CircuitWillEscrow.ConfirmationConsumed.selector), 1);
        assertEq(usdt.balanceOf(payee), 30 * USDT);

        // Consumed: deleted, and the recipient's nonce moved on.
        (uint64 expiresAt, address by) = escrow.confirmations(h);
        assertEq(expiresAt, 0);
        assertEq(by, address(0));
        assertEq(escrow.paymentNonce(payee), 1);
        assertFalse(escrow.isPaymentConfirmed(payee, 30 * USDT));

        // Cannot be reused, not even by re-submitting the old hash.
        vm.prank(owner);
        escrow.setDailyCap(U32_MAX);
        assertFalse(_propose(payee, 30 * USDT), "reuse blocked");
        vm.prank(owner);
        escrow.confirmPayment(h); // stale nonce: does not match the next payment
        assertFalse(_propose(payee, 30 * USDT), "old hash cannot be revived");
        assertEq(usdt.balanceOf(payee), 30 * USDT);

        // A fresh confirmation (nonce 1) allows exactly one more.
        _confirm(payee, 30 * USDT);
        assertTrue(_propose(payee, 30 * USDT));
        assertFalse(_propose(payee, 30 * USDT));
        assertEq(escrow.paymentNonce(payee), 2);
    }

    function test_confirmation_cannotBeUsedForDifferentPayment() public {
        _confirm(payee, 30 * USDT);
        assertFalse(_propose(payee, 30 * USDT + 1), "different amount");
        assertFalse(_propose(payee, 30 * USDT - 1), "smaller amount above threshold");
        assertFalse(_propose(payee2, 30 * USDT), "different recipient");
        assertEq(usdt.balanceOf(payee), 0);
        assertEq(usdt.balanceOf(payee2), 0);
        assertTrue(_propose(payee, 30 * USDT), "still valid for the exact payment");
    }

    function test_confirmation_validUntilExpiry() public {
        bytes32 h = _confirm(payee, 30 * USDT);
        (uint64 expiresAt,) = escrow.confirmations(h);
        assertEq(expiresAt, T0 + escrow.CONFIRMATION_TTL());
        vm.warp(expiresAt);
        assertTrue(_propose(payee, 30 * USDT), "valid at expiresAt");
    }

    function test_confirmation_expires() public {
        bytes32 h = _confirm(payee, 30 * USDT);
        (uint64 expiresAt,) = escrow.confirmations(h);
        vm.warp(uint256(expiresAt) + 1);
        assertFalse(escrow.isPaymentConfirmed(payee, 30 * USDT));
        vm.recordLogs();
        assertFalse(_propose(payee, 30 * USDT), "expired");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(circuitLogs(logs)[2].input, packConfirmation(30 * USDT, THRESHOLD, false));
        assertEq(escrow.paymentNonce(payee), 0, "nothing consumed");
    }

    function test_confirmation_blockedAttemptDoesNotConsume() public {
        _confirm(payee, 40 * USDT);
        assertTrue(_propose(payee, 15 * USDT)); // 15 <= threshold, no confirmation needed
        assertEq(escrow.paymentNonce(payee), 0);

        vm.recordLogs();
        assertFalse(_propose(payee, 40 * USDT), "15 + 40 > cap 50");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _expectStatuses(logs, [D, A, A, A]);
        assertEq(countTopic(logs, CircuitWillEscrow.ConfirmationConsumed.selector), 0);
        assertTrue(escrow.isPaymentConfirmed(payee, 40 * USDT), "still available");

        vm.prank(owner);
        escrow.setDailyCap(100 * USDT); // applies to the very next decision
        assertTrue(_propose(payee, 40 * USDT));
        assertEq(escrow.paymentNonce(payee), 1);
        assertEq(escrow.spentToday(), 55 * USDT);
    }

    function test_confirmation_belowThresholdStillConsumedWhenUsed() public {
        // A confirmation of the exact payment is consumed by it even if the amount did not need one.
        _confirm(payee, 10 * USDT);
        vm.recordLogs();
        assertTrue(_propose(payee, 10 * USDT));
        assertEq(countTopic(vm.getRecordedLogs(), CircuitWillEscrow.ConfirmationConsumed.selector), 1);
        assertEq(escrow.paymentNonce(payee), 1);
    }

    function test_confirmation_tokenFailureDoesNotConsume() public {
        _confirm(payee, 30 * USDT);
        usdt.setFrozen(true);
        assertFalse(_propose(payee, 30 * USDT));
        assertEq(escrow.paymentNonce(payee), 0);
        assertTrue(escrow.isPaymentConfirmed(payee, 30 * USDT));
        assertEq(escrow.spentToday(), 0);
    }

    function test_confirmation_previousOwnersConfirmationIsVoid() public {
        _confirm(payee, 30 * USDT);
        vm.prank(owner);
        key.transferFrom(owner, newOwner, keyId);
        assertFalse(escrow.isPaymentConfirmed(payee, 30 * USDT));

        vm.prank(newOwner);
        (, bool a) = escrow.proposePayment(payee, 30 * USDT, "");
        assertFalse(a, "old owner's confirmation does not count");

        bytes32 h = escrow.currentPaymentHash(payee, 30 * USDT);
        vm.prank(newOwner);
        escrow.confirmPayment(h);
        vm.prank(newOwner);
        (, a) = escrow.proposePayment(payee, 30 * USDT, "");
        assertTrue(a);
    }

    function test_confirmation_onlyControllerAndNonZero() public {
        bytes32 h = escrow.currentPaymentHash(payee, 30 * USDT);
        vm.prank(agentKey);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.confirmPayment(h);
        vm.prank(stranger);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.confirmPayment(h);
        vm.prank(agentKey);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.revokeConfirmation(h);
        vm.prank(owner);
        vm.expectRevert(CircuitWillEscrow.ZeroHash.selector);
        escrow.confirmPayment(bytes32(0));
    }

    function test_confirmation_revoke() public {
        bytes32 h = _confirm(payee, 30 * USDT);
        vm.prank(owner);
        escrow.revokeConfirmation(h);
        assertFalse(_propose(payee, 30 * USDT));
    }

    function test_paymentHash_bindsRecipientAmountNonceChainAndEscrow() public {
        bytes32 h = escrow.hashPayment(payee, 30 * USDT, 0);
        assertEq(
            h,
            keccak256(
                abi.encode(
                    keccak256(
                        "CircuitWill.Payment(uint256 chainId,address escrow,address to,uint256 amount,uint256 nonce)"
                    ),
                    block.chainid,
                    address(escrow),
                    payee,
                    30 * USDT,
                    uint256(0)
                )
            )
        );
        assertTrue(h != escrow.hashPayment(payee2, 30 * USDT, 0), "recipient");
        assertTrue(h != escrow.hashPayment(payee, 30 * USDT + 1, 0), "amount");
        assertTrue(h != escrow.hashPayment(payee, 30 * USDT, 1), "nonce");

        CircuitWillEscrow other = new CircuitWillEscrow(
            IERC20(address(usdt)), IERC721(address(key)), keyId, ITapeOutFactory(address(factory))
        );
        assertTrue(h != other.hashPayment(payee, 30 * USDT, 0), "escrow");

        uint256 chain = block.chainid;
        vm.chainId(chain + 1);
        assertTrue(h != escrow.hashPayment(payee, 30 * USDT, 0), "chain id");
        vm.chainId(chain);
    }

    function test_confirmation_appliesToWithdrawals() public {
        vm.prank(owner);
        (, bool a) = escrow.withdraw(owner, 30 * USDT);
        assertFalse(a, "withdrawal above threshold needs confirmation");
        _confirm(owner, 30 * USDT);
        vm.prank(owner);
        (, a) = escrow.withdraw(owner, 30 * USDT);
        assertTrue(a);
        assertEq(usdt.balanceOf(owner), 30 * USDT);
        assertEq(escrow.paymentNonce(owner), 1);
    }

    // ================================================================ freeze

    function test_freeze_blocksPaymentsAndWithdrawals() public {
        _confirm(owner, 30 * USDT);
        vm.prank(owner);
        escrow.setFrozen(true);
        assertTrue(escrow.frozen());

        assertFalse(_propose(payee, 1 * USDT), "agent payment");
        vm.prank(owner);
        (, bool a) = escrow.proposePayment(payee, 1 * USDT, "");
        assertFalse(a, "owner payment");

        vm.recordLogs();
        vm.prank(owner);
        (, a) = escrow.withdraw(owner, 30 * USDT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(a, "withdrawal is frozen too, even when confirmed");
        _expectStatuses(logs, [A, A, A, D]);
        assertEq(circuitLogs(logs)[3].input, hex"01");
        assertEq(decisionLogs(logs)[0].action, uint8(CircuitWillEscrow.Action.WITHDRAWAL));
        assertEq(usdt.balanceOf(owner), 0);
        assertEq(usdt.balanceOf(address(escrow)), 1_000 * USDT);
        assertEq(escrow.paymentNonce(owner), 0, "blocked: confirmation not consumed");

        vm.prank(owner);
        escrow.setFrozen(false);
        vm.prank(owner);
        (, a) = escrow.withdraw(owner, 30 * USDT);
        assertTrue(a, "unfrozen");
    }

    function test_freeze_requiresAttachedCircuitAndController() public {
        vm.prank(agentKey);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.setFrozen(true);

        vm.prank(owner);
        escrow.detachCircuit(3); // Freeze
        vm.prank(owner);
        vm.expectRevert(CircuitWillEscrow.FreezeCircuitNotAttached.selector);
        escrow.setFrozen(true);
        vm.prank(owner);
        escrow.setFrozen(false); // unfreezing is always possible
    }

    // ================================================================ payee whitelist + cooling-off

    function test_newPayee_blockedBeforeCoolingOff_allowedAfter() public {
        vm.prank(owner);
        escrow.setPayee(newPayee, false);

        vm.recordLogs();
        assertFalse(_propose(newPayee, TRIAL), "age 0 < 24 h");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _expectStatuses(logs, [A, D, A, A]);
        assertEq(circuitLogs(logs)[1].input, packWhitelist(false, 0, TRIAL, TRIAL, COOLING));

        vm.warp(T0 + 24 hours - 1);
        assertEq(escrow.payeeAgeHours(newPayee), 23);
        assertFalse(_propose(newPayee, TRIAL), "one second short of 24 h");

        vm.warp(T0 + 24 hours);
        assertEq(escrow.payeeAgeHours(newPayee), 24);
        vm.recordLogs();
        assertTrue(_propose(newPayee, TRIAL), "exactly at cooling-off, at the trial limit");
        assertEq(circuitLogs(vm.getRecordedLogs())[1].input, packWhitelist(false, 24, TRIAL, TRIAL, COOLING));

        assertFalse(_propose(newPayee, TRIAL + 1), "above the trial limit");
        vm.warp(T0 + 30 days);
        assertFalse(_propose(newPayee, TRIAL + 1), "trial limit applies until saved");

        vm.prank(owner);
        escrow.setPayee(newPayee, true);
        assertTrue(_propose(newPayee, TRIAL + 1), "saved");
        assertEq(usdt.balanceOf(newPayee), 2 * TRIAL + 1);
    }

    function test_unknownPayeeIsBlocked() public {
        vm.recordLogs();
        assertFalse(_propose(stranger, 1));
        CircuitLog[] memory cs = circuitLogs(vm.getRecordedLogs());
        assertEq(cs[1].input, packWhitelist(false, 0, 1, TRIAL, COOLING));
        assertEq(cs[1].status, D);
        // With cooling-off 0, an unknown payee gets the trial limit (age 0 >= 0).
        vm.prank(owner);
        escrow.setCoolingOffHours(0);
        assertTrue(_propose(stranger, 1));
        assertFalse(_propose(stranger, TRIAL + 1));
    }

    function test_withdrawalToNewAddressFollowsWhitelist() public {
        vm.prank(owner);
        (, bool a) = escrow.withdraw(newOwner, 1 * USDT);
        assertFalse(a, "withdrawal to an unknown address is blocked");
    }

    function test_setPayeeKeepsFirstSeen_removeRestartsCoolingOff() public {
        vm.prank(owner);
        escrow.setPayee(newPayee, false);
        vm.warp(T0 + 10 hours);
        vm.prank(owner);
        escrow.setPayee(newPayee, false); // no-op on firstSeen
        (uint64 firstSeen,) = escrow.payees(newPayee);
        assertEq(firstSeen, T0);
        assertEq(escrow.payeeAgeHours(newPayee), 10);

        vm.prank(owner);
        escrow.removePayee(newPayee);
        assertEq(escrow.payeeAgeHours(newPayee), 0);
        vm.prank(owner);
        escrow.setPayee(newPayee, false);
        (firstSeen,) = escrow.payees(newPayee);
        assertEq(firstSeen, T0 + 10 hours);
        vm.warp(T0 + 30 hours);
        assertFalse(_propose(newPayee, 1), "cooling-off restarted at re-add");
        vm.warp(T0 + 34 hours);
        assertTrue(_propose(newPayee, 1));
    }

    function test_ageSaturatesAtUint16Max() public {
        vm.startPrank(owner);
        escrow.setPayee(newPayee, false);
        escrow.setCoolingOffHours(type(uint16).max);
        vm.stopPrank();
        vm.warp(T0 + 8 * 365 days); // ~70,080 hours
        assertEq(escrow.payeeAgeHours(newPayee), type(uint16).max);
        vm.recordLogs();
        assertTrue(_propose(newPayee, 1));
        assertEq(
            circuitLogs(vm.getRecordedLogs())[1].input,
            packWhitelist(false, type(uint16).max, 1, TRIAL, type(uint16).max)
        );
    }

    // ================================================================ parameters

    function test_parameterRangeChecks() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.ValueOutOfRange.selector, U32_MAX + 1, U32_MAX));
        escrow.setTrialLimit(U32_MAX + 1);
        vm.expectRevert(
            abi.encodeWithSelector(CircuitWillEscrow.ValueOutOfRange.selector, 65_536, uint256(type(uint16).max))
        );
        escrow.setCoolingOffHours(65_536);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.ValueOutOfRange.selector, U32_MAX + 1, U32_MAX));
        escrow.setConfirmationThreshold(U32_MAX + 1);
        vm.expectRevert(CircuitWillEscrow.ZeroAddress.selector);
        escrow.setPayee(address(0), true);

        escrow.setTrialLimit(U32_MAX);
        escrow.setCoolingOffHours(type(uint16).max);
        escrow.setConfirmationThreshold(U32_MAX);
        vm.stopPrank();
        assertEq(escrow.trialLimit(), U32_MAX);
        assertEq(escrow.coolingOffHours(), type(uint16).max);
        assertEq(escrow.confirmationThreshold(), U32_MAX);
    }

    function test_parametersAreControllerOnly() public {
        address[2] memory notController = [agentKey, stranger];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(notController[i]);
            vm.expectRevert(CircuitWillEscrow.NotController.selector);
            escrow.setTrialLimit(1);
            vm.expectRevert(CircuitWillEscrow.NotController.selector);
            escrow.setCoolingOffHours(1);
            vm.expectRevert(CircuitWillEscrow.NotController.selector);
            escrow.setConfirmationThreshold(1);
            vm.expectRevert(CircuitWillEscrow.NotController.selector);
            escrow.setPayee(stranger, true);
            vm.expectRevert(CircuitWillEscrow.NotController.selector);
            escrow.removePayee(payee);
            vm.expectRevert(CircuitWillEscrow.NotController.selector);
            escrow.setFrozen(true);
            vm.stopPrank();
        }
    }

    function test_attachChecksPinoutPerKind() public {
        vm.startPrank(owner);
        escrow.detachCircuit(3);
        escrow.detachCircuit(2);
        escrow.detachCircuit(1);
        escrow.detachCircuit(0);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.PinoutMismatch.selector, 65, 1, 0));
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.WHITELIST, address(processor), confirmationId);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.PinoutMismatch.selector, 97, 1, 0));
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.CONFIRMATION, address(processor), whitelistId);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.PinoutMismatch.selector, 96, 1, 0));
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.FREEZE, address(processor), dailyCapId);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.PinoutMismatch.selector, 1, 1, 0));
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(processor), freezeId);

        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.FREEZE, address(processor), freezeId);
        vm.expectRevert(
            abi.encodeWithSelector(
                CircuitWillEscrow.DuplicateCircuitKind.selector, CircuitWillEscrow.CircuitKind.FREEZE
            )
        );
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.FREEZE, address(processor), freezeId);
        vm.stopPrank();
    }

    // ================================================================ fail closed with several circuits

    function _swapWhitelistFor(SwitchableProcessor.Mode mode) internal {
        SwitchableProcessor p = new SwitchableProcessor();
        p.setNIn(97);
        factory.register(address(p));
        vm.startPrank(owner);
        escrow.detachCircuit(1); // Freeze moves to index 1
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.WHITELIST, address(p), 1); // index 3
        vm.stopPrank();
        p.setMode(mode);
    }

    function test_failClosed_oneRevertingCircuitAmongFour() public {
        _swapWhitelistFor(SwitchableProcessor.Mode.REVERT);
        vm.recordLogs();
        assertFalse(_propose(payee, 1 * USDT));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _expectStatuses(logs, [A, A, A, uint8(TapeOutEval.Status.REVERTED)]);
        DecisionLog memory d = decisionLogs(logs)[0];
        assertEq(d.reason, reason(CircuitWillEscrow.Reason.EVAL_FAILED));
        assertEq(d.recordHash, escrow.decisionRecordHash(d.decisionId));
        assertEq(usdt.balanceOf(payee), 0);
    }

    function test_failClosed_gasBurnerAmongFourStillRecords() public {
        _swapWhitelistFor(SwitchableProcessor.Mode.BURN_GAS);
        vm.recordLogs();
        vm.prank(agentKey);
        (uint256 id, bool a) = escrow.proposePayment{gas: 12_000_000}(payee, 1 * USDT, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(a);
        assertEq(circuitLogs(logs).length, 4);
        assertEq(circuitLogs(logs)[3].status, uint8(TapeOutEval.Status.REVERTED));
        assertEq(decisionLogs(logs)[0].reason, reason(CircuitWillEscrow.Reason.EVAL_FAILED));
        assertTrue(escrow.decisionRecordHash(id) != bytes32(0));
        assertEq(usdt.balanceOf(payee), 0);
    }

    // ================================================================ re-evaluation with several circuits

    function test_thirdPartyReEvaluatesMultiCircuitDecisions() public {
        vm.prank(owner);
        escrow.setPayee(newPayee, false);
        _confirm(payee, 25 * USDT);

        vm.recordLogs();
        _propose(payee, 10 * USDT); // 1 allowed
        _propose(newPayee, 1 * USDT); // 2 blocked: cooling-off
        _propose(payee, 25 * USDT); // 3 allowed: above threshold but confirmed
        _propose(payee, 21 * USDT); // 4 blocked: confirmation + cap
        vm.prank(owner);
        escrow.setFrozen(true);
        vm.prank(owner);
        escrow.withdraw(owner, 1 * USDT); // 5 blocked: freeze
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // Change every parameter afterwards: the recorded inputs, not current state, are what was evaluated.
        vm.startPrank(owner);
        escrow.setFrozen(false);
        escrow.setDailyCap(1);
        escrow.setTrialLimit(0);
        escrow.setConfirmationThreshold(0);
        escrow.removePayee(payee);
        vm.stopPrank();

        DecisionLog[] memory ds = decisionLogs(logs);
        CircuitLog[] memory cs = circuitLogs(logs);
        assertEq(ds.length, 5);
        assertEq(cs.length, 20);

        bool[5] memory want = [true, false, true, false, false];
        vm.startPrank(stranger); // anyone
        for (uint256 i; i < ds.length; ++i) {
            CircuitLog[] memory mine = new CircuitLog[](4);
            bool all = true;
            for (uint256 k; k < 4; ++k) {
                CircuitLog memory c = cs[i * 4 + k];
                assertEq(c.decisionId, ds[i].decisionId);
                assertEq(c.index, k);
                // Re-run each circuit on its recorded input; it must return the recorded output.
                bytes memory out = ITapeOutReader(c.processor).eval(c.circuitId, c.input);
                assertEq(out, c.output);
                assertEq(keccak256(ITapeOutReader(c.processor).netlist(c.circuitId)), c.netlistHash);
                all = all && (uint8(out[0]) & 1) == 1;
                mine[k] = c;
            }
            // Recorded inputs agree with the decision summary.
            assertEq(cs[i * 4].input, packDailyCap(ds[i].amount, ds[i].spentBefore, 50 * USDT));
            assertEq(_unpackBits(cs[i * 4 + 1].input, 17, 32), ds[i].amount);
            assertEq(_unpackBits(cs[i * 4 + 2].input, 0, 32), ds[i].amount);
            // Outcome follows from the outputs (balance and transfer were fine here).
            assertEq(ds[i].allowed, all);
            assertEq(ds[i].allowed, want[i]);
            // The event data matches the on-chain commitment.
            assertEq(recomputeRecordHash(ds[i], mine), escrow.decisionRecordHash(ds[i].decisionId));
        }
        vm.stopPrank();
        assertEq(_unpackBits(cs[2 * 4 + 2].input, 64, 1), 1, "decision 3 was packed as confirmed");
    }

    function _unpackBits(bytes memory b, uint256 first, uint256 width) internal pure returns (uint256 v) {
        for (uint256 i; i < width; ++i) {
            uint256 bit = first + i;
            v |= uint256((uint8(b[bit >> 3]) >> (bit & 7)) & 1) << i;
        }
    }

    // ================================================================ gas

    function test_gas_fourCircuits() public {
        _confirm(payee, 30 * USDT);
        uint256 g = gasleft();
        assertTrue(_propose(payee, 30 * USDT));
        uint256 allowedGas = g - gasleft();

        g = gasleft();
        assertFalse(_propose(stranger, 1 * USDT));
        uint256 blockedGas = g - gasleft();

        emit log_named_uint("4 circuits, allowed + confirmation consumed, mock TapeOut (gas)", allowedGas);
        emit log_named_uint("4 circuits, blocked, mock TapeOut (gas)", blockedGas);
        // The mock interprets the netlists in Solidity; the fork test measures the real TapeOut cost.
        assertLt(allowedGas, 20_000_000);
    }

    // ================================================================ gas budget and gas estimation

    function _tryPropose(uint256 gasLimit, address to, uint256 amount) internal returns (bool ok, bytes memory ret) {
        vm.prank(agentKey);
        (ok, ret) = address(escrow).call{gas: gasLimit}(
            abi.encodeCall(CircuitWillEscrow.proposePayment, (to, amount, "estimate"))
        );
    }

    /// @dev What eth_estimateGas does: binary-search the smallest gas limit at which the call does not revert.
    function _estimate(address to, uint256 amount) internal returns (uint256 lo, uint256 hi) {
        lo = 50_000;
        hi = 30_000_000;
        while (hi - lo > 1_000) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (bool ok,) = _tryPropose(mid, to, amount);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
    }

    function _allowedFromReturn(bytes memory ret) internal pure returns (bool allowed) {
        (, allowed) = abi.decode(ret, (uint256, bool));
    }

    function test_gas_estimatedLimitIsEnoughToBeAllowed() public {
        (uint256 lo, uint256 hi) = _estimate(payee, 10 * USDT);
        emit log_named_uint("estimated gas, 4 circuits, mock TapeOut", hi);

        // Just below the estimate the call reverts with InsufficientGas: nothing is recorded, nothing moves.
        uint256 snap = vm.snapshotState();
        (bool ok, bytes memory ret) = _tryPropose(lo, payee, 10 * USDT);
        assertFalse(ok);
        assertEq(bytes4(ret), CircuitWillEscrow.InsufficientGas.selector);
        assertEq(escrow.decisionCount(), 0);
        vm.revertToState(snap);

        // At the estimate and above, the payment is evaluated in full and allowed (previously the estimate starved
        // the last circuits and the payment was recorded as blocked).
        uint256[4] memory limits = [hi, hi + 50_000, hi + 1_000_000, 25_000_000];
        for (uint256 i; i < limits.length; ++i) {
            snap = vm.snapshotState();
            vm.recordLogs();
            (ok, ret) = _tryPropose(limits[i], payee, 10 * USDT);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertTrue(ok, "no revert at or above the estimate");
            assertTrue(_allowedFromReturn(ret), "allowed at or above the estimate");
            _expectStatuses(logs, [A, A, A, A]);
            vm.revertToState(snap);
        }
    }

    /// @dev Real TapeOut circuits contracts are proxies: a starved eval reverts with 1/64 of its gas per hop left over.
    ///      The estimate must still be enough to evaluate every circuit (found on the fork, where it was not).
    function test_gas_estimatedLimitIsEnoughBehindProxies() public {
        address proxied = address(new ForwardingProxy(address(new ForwardingProxy(address(processor)))));
        factory.register(proxied);
        vm.startPrank(owner);
        for (uint256 i; i < 4; ++i) {
            escrow.detachCircuit(0);
        }
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, proxied, dailyCapId);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.WHITELIST, proxied, whitelistId);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.CONFIRMATION, proxied, confirmationId);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.FREEZE, proxied, freezeId);
        vm.stopPrank();

        (uint256 lo, uint256 hi) = _estimate(payee, 10 * USDT);
        emit log_named_uint("estimated gas, 4 circuits behind two proxy hops, mock TapeOut", hi);

        (bool ok, bytes memory ret) = _tryPropose(lo, payee, 10 * USDT);
        assertFalse(ok);
        assertEq(bytes4(ret), CircuitWillEscrow.InsufficientGas.selector);

        vm.recordLogs();
        (ok, ret) = _tryPropose(hi, payee, 10 * USDT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(ok);
        assertTrue(_allowedFromReturn(ret), "allowed at the estimate behind proxies");
        _expectStatuses(logs, [A, A, A, A]);
    }

    function test_gas_underfundedCallRevertsWithoutRecording() public {
        uint256 before = usdt.balanceOf(payee);
        (bool ok, bytes memory ret) = _tryPropose(600_000, payee, 10 * USDT);
        assertFalse(ok);
        assertEq(bytes4(ret), CircuitWillEscrow.InsufficientGas.selector);
        assertEq(escrow.decisionCount(), 0, "nothing recorded");
        assertEq(usdt.balanceOf(payee), before, "nothing moved");
    }

    function test_gas_burnerIsRecordedOnceItHasItsFullBudget() public {
        _swapWhitelistFor(SwitchableProcessor.Mode.BURN_GAS); // burner at index 3

        // Below budget + reserve: the burner starves because of the caller, so the call reverts.
        (bool ok, bytes memory ret) = _tryPropose(3_200_000, payee, 1 * USDT);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(CircuitWillEscrow.InsufficientGas.selector, 3));
        assertEq(escrow.decisionCount(), 0);

        // The estimate gives the burner its whole budget; it uses all of it and the decision is recorded as blocked.
        (, uint256 hi) = _estimate(payee, 1 * USDT);
        emit log_named_uint("estimated gas with a gas-burning circuit", hi);
        assertGt(hi, escrow.evalGasLimit());
        vm.recordLogs();
        (ok, ret) = _tryPropose(hi, payee, 1 * USDT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(ok);
        assertFalse(_allowedFromReturn(ret));
        assertEq(circuitLogs(logs)[3].status, uint8(TapeOutEval.Status.REVERTED));
        assertEq(decisionLogs(logs)[0].reason, reason(CircuitWillEscrow.Reason.EVAL_FAILED));
        assertEq(usdt.balanceOf(payee), 0);
    }

    function test_gas_evalGasLimitParameter() public {
        assertEq(escrow.evalGasLimit(), 3_000_000);
        vm.prank(agentKey);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.setEvalGasLimit(5_000_000);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.ValueOutOfRange.selector, 99_999, 30_000_000));
        escrow.setEvalGasLimit(99_999);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.ValueOutOfRange.selector, 30_000_001, 30_000_000));
        escrow.setEvalGasLimit(30_000_001);

        // A budget too small for the Daily Cap netlist: with plenty of caller gas, that eval exhausts its full budget
        // and is recorded as REVERTED (fail closed), not reverted.
        escrow.setEvalGasLimit(100_000);
        vm.stopPrank();
        vm.recordLogs();
        (bool ok, bytes memory ret) = _tryPropose(20_000_000, payee, 1 * USDT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(ok);
        assertFalse(_allowedFromReturn(ret));
        assertEq(circuitLogs(logs)[0].status, uint8(TapeOutEval.Status.REVERTED));

        vm.prank(owner);
        escrow.setEvalGasLimit(3_000_000);
        assertTrue(_propose(payee, 1 * USDT));
    }
}
