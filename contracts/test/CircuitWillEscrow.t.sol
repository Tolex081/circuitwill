// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {Base} from "./Base.t.sol";
import {CircuitWillEscrow} from "../src/CircuitWillEscrow.sol";
import {ITapeOutFactory} from "../src/interfaces/ITapeOut.sol";
import {TapeOutEval} from "../src/libraries/TapeOutEval.sol";
import {SwitchableProcessor} from "./mocks/HostileProcessors.sol";
import {BurnableNft} from "./mocks/MockTokens.sol";

contract CircuitWillEscrowTest is Base {
    // ================================================================ handoff success criteria

    function test_cap50_blocks60_allows30() public {
        vm.prank(agentKey);
        (, bool allowed) = escrow.proposePayment(payee, 60 * USDT, "too much");
        assertFalse(allowed, "60 must be blocked by cap 50");
        assertEq(usdt.balanceOf(payee), 0);

        vm.prank(agentKey);
        (, allowed) = escrow.proposePayment(payee, 30 * USDT, "fine");
        assertTrue(allowed, "30 must pass cap 50");
        assertEq(usdt.balanceOf(payee), 30 * USDT);
        assertEq(escrow.spentToday(), 30 * USDT);
    }

    // ================================================================ below / at / above

    function test_belowAtAboveCap() public {
        vm.startPrank(agentKey);
        (, bool a) = escrow.proposePayment(payee, 49_999_999, "below");
        assertTrue(a, "below cap");
        (, a) = escrow.proposePayment(payee, 1, "reaches cap exactly");
        assertTrue(a, "exactly at cap");
        assertEq(escrow.spentToday(), 50 * USDT);
        (, a) = escrow.proposePayment(payee, 1, "one unit above");
        assertFalse(a, "above cap");
        vm.stopPrank();
        assertEq(usdt.balanceOf(payee), 50 * USDT);
        assertEq(escrow.spentToday(), 50 * USDT, "blocked attempt does not count");
    }

    function test_singlePaymentAtAndAboveCap() public {
        vm.prank(owner);
        (, bool a) = escrow.proposePayment(payee, 50 * USDT + 1, "");
        assertFalse(a);
        vm.prank(owner);
        (, a) = escrow.proposePayment(payee, 50 * USDT, "");
        assertTrue(a);
    }

    // ================================================================ blocked decision is persisted

    function test_blockedDecisionPersistsEventsWithoutTransfer() public {
        uint256 escrowBefore = usdt.balanceOf(address(escrow));
        vm.recordLogs();
        vm.prank(agentKey);
        (uint256 id, bool allowed) = escrow.proposePayment(payee, 60 * USDT, "blocked memo");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // The call returned normally (no revert), so its logs and storage writes are part of the transaction.
        assertFalse(allowed);
        assertEq(id, 1);
        assertEq(escrow.decisionCount(), 1);
        assertEq(usdt.balanceOf(address(escrow)), escrowBefore, "no funds left the escrow");
        assertEq(usdt.balanceOf(payee), 0);
        assertEq(escrow.spentToday(), 0);

        DecisionLog[] memory ds = decisionLogs(logs);
        CircuitLog[] memory cs = circuitLogs(logs);
        assertEq(ds.length, 1);
        assertEq(cs.length, 1);
        assertEq(countTopic(logs, CircuitWillEscrow.PaymentBlocked.selector), 1);
        assertEq(countTopic(logs, CircuitWillEscrow.PaymentAllowed.selector), 0);

        DecisionLog memory d = ds[0];
        assertEq(d.decisionId, 1);
        assertEq(d.action, uint8(CircuitWillEscrow.Action.PAYMENT));
        assertFalse(d.allowed);
        assertEq(d.proposer, agentKey);
        assertEq(d.to, payee);
        assertEq(d.amount, 60 * USDT);
        assertEq(d.day, uint32(T0 / 86_400));
        assertEq(d.spentBefore, 0);
        assertEq(d.spentAfter, 0);
        assertEq(d.reason, reason(CircuitWillEscrow.Reason.CIRCUIT_DENIED));
        assertEq(d.memo, "blocked memo");
        assertEq(d.recordHash, escrow.decisionRecordHash(1));

        CircuitLog memory c = cs[0];
        assertEq(c.decisionId, 1);
        assertEq(c.index, 0);
        assertEq(c.kind, uint8(CircuitWillEscrow.CircuitKind.DAILY_CAP));
        assertEq(c.processor, address(processor));
        assertEq(c.circuitId, dailyCapId);
        assertEq(c.netlistHash, keccak256(dailyCapNetlist()));
        assertEq(c.input, packDailyCap(60 * USDT, 0, 50 * USDT));
        assertEq(c.status, status(TapeOutEval.Status.DENY));
        assertEq(c.output, hex"00");
    }

    function test_blockedEventsSurviveInATransaction() public {
        // A blocked proposal is a successful call: an outer caller observes no revert.
        vm.prank(agentKey);
        (bool ok,) = address(escrow).call(abi.encodeCall(CircuitWillEscrow.proposePayment, (payee, 60 * USDT, "")));
        assertTrue(ok, "blocked proposal must not revert");
        assertTrue(escrow.decisionRecordHash(1) != bytes32(0));
    }

    // ================================================================ successful transfer

    function test_allowedTransferMovesFundsAndRecords() public {
        vm.recordLogs();
        vm.prank(agentKey);
        (uint256 id, bool allowed) = escrow.proposePayment(payee, 30 * USDT, "rent");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertTrue(allowed);
        assertEq(usdt.balanceOf(payee), 30 * USDT);
        assertEq(usdt.balanceOf(address(escrow)), 970 * USDT);
        assertEq(escrow.spentToday(), 30 * USDT);

        DecisionLog memory d = decisionLogs(logs)[0];
        CircuitLog memory c = circuitLogs(logs)[0];
        assertEq(d.decisionId, id);
        assertTrue(d.allowed);
        assertEq(d.reason, reason(CircuitWillEscrow.Reason.NONE));
        assertEq(d.spentBefore, 0);
        assertEq(d.spentAfter, 30 * USDT);
        assertEq(c.status, status(TapeOutEval.Status.ALLOW));
        assertEq(c.output, hex"01");
        assertEq(countTopic(logs, CircuitWillEscrow.PaymentAllowed.selector), 1);
        assertEq(countTopic(logs, CircuitWillEscrow.PaymentBlocked.selector), 0);
    }

    function test_spentTodayIsPackedIntoNextDecision() public {
        vm.startPrank(agentKey);
        escrow.proposePayment(payee, 20 * USDT, "");
        vm.recordLogs();
        escrow.proposePayment(payee, 31 * USDT, "");
        vm.stopPrank();
        CircuitLog memory c = circuitLogs(vm.getRecordedLogs())[0];
        assertEq(c.input, packDailyCap(31 * USDT, 20 * USDT, 50 * USDT));
        assertEq(c.status, status(TapeOutEval.Status.DENY));
    }

    // ================================================================ UTC day reset

    function test_utcDayReset() public {
        vm.prank(agentKey);
        escrow.proposePayment(payee, 50 * USDT, "");
        uint256 nextDay = (T0 / 86_400 + 1) * 86_400; // 00:00:00 UTC

        vm.warp(nextDay - 1); // 23:59:59 same day
        vm.prank(agentKey);
        (, bool a) = escrow.proposePayment(payee, 1, "");
        assertFalse(a, "still the same UTC day");
        assertEq(escrow.currentSpentToday(), 50 * USDT);

        vm.warp(nextDay);
        assertEq(escrow.currentSpentToday(), 0, "view reflects the new day before any write");
        assertEq(escrow.spentToday(), 50 * USDT, "storage resets lazily");

        vm.recordLogs();
        vm.prank(agentKey);
        (, a) = escrow.proposePayment(payee, 50 * USDT, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(a, "new UTC day");
        assertEq(countTopic(logs, CircuitWillEscrow.DailySpendReset.selector), 1);
        assertEq(escrow.lastResetDay(), uint32(nextDay / 86_400));
        assertEq(escrow.spentToday(), 50 * USDT);
        DecisionLog memory d = decisionLogs(logs)[0];
        assertEq(d.spentBefore, 0);
        assertEq(d.day, uint32(nextDay / 86_400));
    }

    function test_blockedProposalStillResetsDay() public {
        vm.prank(agentKey);
        escrow.proposePayment(payee, 40 * USDT, "");
        vm.warp(T0 + 3 days);
        vm.prank(agentKey);
        (, bool a) = escrow.proposePayment(payee, 51 * USDT, "");
        assertFalse(a);
        assertEq(escrow.spentToday(), 0);
        assertEq(escrow.lastResetDay(), uint32((T0 + 3 days) / 86_400));
    }

    // ================================================================ withdrawals are circuit-gated

    function test_withdrawIsCircuitGated() public {
        vm.prank(owner);
        (, bool a) = escrow.withdraw(owner, 500 * USDT);
        assertFalse(a, "withdrawal above cap is blocked: no bypass");
        assertEq(usdt.balanceOf(owner), 0);
        assertEq(usdt.balanceOf(address(escrow)), 1_000 * USDT);

        vm.recordLogs();
        vm.prank(owner);
        (, a) = escrow.withdraw(owner, 40 * USDT);
        DecisionLog memory d = decisionLogs(vm.getRecordedLogs())[0];
        assertTrue(a);
        assertEq(d.action, uint8(CircuitWillEscrow.Action.WITHDRAWAL));
        assertEq(usdt.balanceOf(owner), 40 * USDT);
        assertEq(escrow.spentToday(), 40 * USDT, "withdrawals count toward the daily total");

        vm.prank(agentKey);
        (, a) = escrow.proposePayment(payee, 11 * USDT, "");
        assertFalse(a, "cap shared between withdrawals and payments");
    }

    // ================================================================ range and overflow

    function test_amountAboveUint32IsBlockedNotTruncated() public {
        usdt.mint(address(escrow), 10_000 * USDT);
        vm.prank(owner);
        escrow.setDailyCap(U32_MAX);

        // 2^32 + 1 would truncate to 1 (allowed) if packed carelessly.
        uint256 amount = U32_MAX + 2;
        vm.recordLogs();
        vm.prank(owner);
        (, bool a) = escrow.proposePayment(payee, amount, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(a);
        assertEq(usdt.balanceOf(payee), 0);
        DecisionLog memory d = decisionLogs(logs)[0];
        CircuitLog memory c = circuitLogs(logs)[0];
        assertEq(d.reason, reason(CircuitWillEscrow.Reason.INPUT_OUT_OF_RANGE));
        assertEq(c.status, status(TapeOutEval.Status.NOT_EVALUATED));
        assertEq(c.input.length, 0);
    }

    function test_capAboveUint32Reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.ValueOutOfRange.selector, U32_MAX + 1, U32_MAX));
        escrow.setDailyCap(U32_MAX + 1);
        vm.prank(owner);
        escrow.setDailyCap(U32_MAX); // exactly the max is fine
        assertEq(escrow.dailyCap(), U32_MAX);
    }

    function test_sumOverflowIsBlockedByCircuit() public {
        usdt.mint(address(escrow), 10_000 * USDT);
        vm.prank(owner);
        escrow.setDailyCap(U32_MAX);

        vm.prank(owner);
        (, bool a) = escrow.proposePayment(payee, U32_MAX, "max in one go");
        assertTrue(a, "amount == cap == uint32 max is allowed");
        assertEq(escrow.spentToday(), U32_MAX);

        // spent (2^32 - 1) + 1 = 2^32: the 33-bit sum carries out; a wrapping adder would see 0 and allow.
        vm.recordLogs();
        vm.prank(owner);
        (, a) = escrow.proposePayment(payee, 1, "overflow");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(a);
        CircuitLog memory c = circuitLogs(logs)[0];
        assertEq(c.input, packDailyCap(1, U32_MAX, U32_MAX));
        assertEq(c.status, status(TapeOutEval.Status.DENY));
        assertEq(escrow.spentToday(), U32_MAX);
    }

    // ================================================================ authorization

    function test_onlyOwnerOrAgentCanPropose() public {
        vm.prank(stranger);
        vm.expectRevert(CircuitWillEscrow.NotProposer.selector);
        escrow.proposePayment(payee, 1, "");

        vm.prank(owner);
        (, bool a) = escrow.proposePayment(payee, 1, "");
        assertTrue(a);
        vm.prank(agentKey);
        (, a) = escrow.proposePayment(payee, 1, "");
        assertTrue(a);
    }

    function test_agentCannotManageOrWithdraw() public {
        vm.startPrank(agentKey);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.withdraw(agentKey, 1);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.setDailyCap(1_000 * USDT);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.setAgent(stranger);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.detachCircuit(0);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(processor), dailyCapId);
        vm.stopPrank();
    }

    function test_strangerCannotManage() public {
        vm.startPrank(stranger);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.withdraw(stranger, 1);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.setDailyCap(0);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.setAgent(stranger);
        vm.stopPrank();
    }

    function test_nftTransferMovesControl() public {
        vm.prank(owner);
        key.transferFrom(owner, newOwner, keyId);
        assertEq(escrow.controller(), newOwner);

        // Old owner loses everything immediately.
        vm.startPrank(owner);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.withdraw(owner, 1);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.setDailyCap(1_000 * USDT);
        vm.expectRevert(CircuitWillEscrow.NotProposer.selector);
        escrow.proposePayment(owner, 1, "");
        vm.stopPrank();

        // The old owner's agent is no longer active.
        assertFalse(escrow.isActiveAgent(agentKey));
        vm.prank(agentKey);
        vm.expectRevert(CircuitWillEscrow.NotProposer.selector);
        escrow.proposePayment(payee, 1, "");

        // New owner manages and withdraws (still circuit-gated).
        vm.startPrank(newOwner);
        escrow.setDailyCap(100 * USDT);
        (, bool a) = escrow.withdraw(newOwner, 100 * USDT);
        assertTrue(a);
        (, a) = escrow.withdraw(newOwner, 1);
        assertFalse(a, "new owner is bound by the circuits too");
        address newAgent = makeAddr("newAgent");
        escrow.setAgent(newAgent);
        vm.stopPrank();
        assertEq(usdt.balanceOf(newOwner), 100 * USDT);
        assertTrue(escrow.isActiveAgent(newAgent));
    }

    function test_agentReactivatesIfNftReturns() public {
        // agentSetBy binds the agent to the owner that appointed it.
        vm.prank(owner);
        key.transferFrom(owner, newOwner, keyId);
        assertFalse(escrow.isActiveAgent(agentKey));
        vm.prank(newOwner);
        key.transferFrom(newOwner, owner, keyId);
        assertTrue(escrow.isActiveAgent(agentKey));
    }

    function test_clearAgent() public {
        vm.prank(owner);
        escrow.setAgent(address(0));
        assertFalse(escrow.isActiveAgent(agentKey));
        assertFalse(escrow.isActiveAgent(address(0)));
        vm.prank(agentKey);
        vm.expectRevert(CircuitWillEscrow.NotProposer.selector);
        escrow.proposePayment(payee, 1, "");
    }

    // ================================================================ fail closed

    function _attachSwitchable(SwitchableProcessor.Mode mode) internal returns (SwitchableProcessor p) {
        p = new SwitchableProcessor();
        factory.register(address(p));
        vm.startPrank(owner);
        escrow.detachCircuit(0);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(p), 1);
        vm.stopPrank();
        p.setMode(mode);
    }

    function _expectEvalFailed(SwitchableProcessor.Mode mode) internal {
        _attachSwitchable(mode);
        vm.recordLogs();
        vm.prank(agentKey);
        // Enough gas for the eval to get its full `evalGasLimit` budget (3M), so a gas burner is recorded.
        (uint256 id, bool a) = escrow.proposePayment{gas: 4_000_000}(payee, 1 * USDT, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(a, "fail closed");
        assertEq(usdt.balanceOf(payee), 0);
        assertEq(escrow.spentToday(), 0);
        DecisionLog memory d = decisionLogs(logs)[0];
        assertEq(d.decisionId, id);
        assertEq(d.reason, reason(CircuitWillEscrow.Reason.EVAL_FAILED));
        assertEq(countTopic(logs, CircuitWillEscrow.PaymentBlocked.selector), 1);
        uint8 st = circuitLogs(logs)[0].status;
        assertTrue(st == status(TapeOutEval.Status.REVERTED) || st == status(TapeOutEval.Status.MALFORMED_OUTPUT));
        assertEq(d.recordHash, escrow.decisionRecordHash(id));
    }

    function test_failClosed_revert() public {
        _expectEvalFailed(SwitchableProcessor.Mode.REVERT);
    }

    function test_failClosed_emptyReturn() public {
        _expectEvalFailed(SwitchableProcessor.Mode.EMPTY_RETURN);
    }

    function test_failClosed_wrongLength() public {
        _expectEvalFailed(SwitchableProcessor.Mode.WRONG_LENGTH);
    }

    function test_failClosed_badOffset() public {
        _expectEvalFailed(SwitchableProcessor.Mode.BAD_OFFSET);
    }

    function test_failClosed_hugeReturn() public {
        _expectEvalFailed(SwitchableProcessor.Mode.HUGE_RETURN);
    }

    function test_failClosed_outOfGas() public {
        _expectEvalFailed(SwitchableProcessor.Mode.BURN_GAS);
    }

    function test_failClosed_rawGarbage() public {
        _expectEvalFailed(SwitchableProcessor.Mode.RAW_GARBAGE);
    }

    function test_failClosed_processorCodeRemovedAfterAttach() public {
        SwitchableProcessor p = _attachSwitchable(SwitchableProcessor.Mode.ALLOW);
        vm.etch(address(p), "");
        vm.prank(agentKey);
        (, bool a) = escrow.proposePayment(payee, 1, "");
        assertFalse(a);
        assertEq(usdt.balanceOf(payee), 0);
    }

    function test_noCircuitsBlocks() public {
        vm.prank(owner);
        escrow.detachCircuit(0);
        vm.recordLogs();
        vm.prank(owner);
        (, bool a) = escrow.proposePayment(payee, 1, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(a, "no circuits means nothing can authorize");
        assertEq(decisionLogs(logs)[0].reason, reason(CircuitWillEscrow.Reason.NO_CIRCUITS));
        assertEq(circuitLogs(logs).length, 0);
        vm.prank(owner);
        (, a) = escrow.withdraw(owner, 1);
        assertFalse(a, "withdrawals too");
    }

    function test_insufficientBalanceIsRecorded() public {
        vm.prank(owner);
        escrow.setDailyCap(U32_MAX);
        vm.recordLogs();
        vm.prank(owner);
        (, bool a) = escrow.proposePayment(payee, 1_001 * USDT, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(a);
        assertEq(decisionLogs(logs)[0].reason, reason(CircuitWillEscrow.Reason.INSUFFICIENT_BALANCE));
        assertEq(circuitLogs(logs)[0].status, status(TapeOutEval.Status.ALLOW), "circuit said yes, balance said no");
        assertEq(escrow.spentToday(), 0);
    }

    function test_tokenFailureIsRecordedNotReverted() public {
        usdt.setFrozen(true);
        vm.recordLogs();
        vm.prank(agentKey);
        (, bool a) = escrow.proposePayment(payee, 1 * USDT, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(a);
        assertEq(decisionLogs(logs)[0].reason, reason(CircuitWillEscrow.Reason.TRANSFER_FAILED));
        assertEq(escrow.spentToday(), 0, "spending only counts after a successful transfer");
    }

    // ================================================================ input validation (pre-decision reverts)

    function test_rejectsMalformedRequests() public {
        vm.startPrank(agentKey);
        vm.expectRevert(CircuitWillEscrow.ZeroAmount.selector);
        escrow.proposePayment(payee, 0, "");
        vm.expectRevert(CircuitWillEscrow.ZeroAddress.selector);
        escrow.proposePayment(address(0), 1, "");
        vm.expectRevert(CircuitWillEscrow.MemoTooLong.selector);
        escrow.proposePayment(payee, 1, string(new bytes(257)));
        vm.stopPrank();
        assertEq(escrow.decisionCount(), 0);
    }

    // ================================================================ circuit management

    function test_attachValidatesPinoutAndRegistry() public {
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CircuitWillEscrow.DuplicateCircuitKind.selector, CircuitWillEscrow.CircuitKind.DAILY_CAP
            )
        );
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(processor), dailyCapId);

        escrow.detachCircuit(0);
        assertEq(escrow.circuitCount(), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                CircuitWillEscrow.UnsupportedCircuitKind.selector, CircuitWillEscrow.CircuitKind.NONE
            )
        );
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.NONE, address(processor), dailyCapId);

        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.NotAProcessor.selector, stranger));
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, stranger, 1);
        vm.stopPrank();

        // Wrong pinout: a 2-input XOR.
        uint256 xorId = processor.tapeout(hex"00000002000003000000020000040000000300000400000005000006", 2, 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.PinoutMismatch.selector, 2, 1, 0));
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(processor), xorId);

        // Unknown circuit id reverts in circuitInfo.
        vm.prank(owner);
        vm.expectRevert(bytes("no circuit"));
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(processor), 999);

        // Processor not registered with the TapeOut factory.
        SwitchableProcessor rogue = new SwitchableProcessor();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.NotAProcessor.selector, address(rogue)));
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(rogue), 1);

        vm.prank(owner);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(processor), dailyCapId);
        CircuitWillEscrow.AttachedCircuit memory c = escrow.circuitAt(0);
        assertEq(c.processor, address(processor));
        assertEq(c.circuitId, dailyCapId);
        assertEq(c.netlistHash, keccak256(dailyCapNetlist()));
    }

    // ================================================================ third-party re-evaluation

    function test_thirdPartyCanReEvaluateFromEvents() public {
        vm.recordLogs();
        vm.startPrank(agentKey);
        escrow.proposePayment(payee, 30 * USDT, "allowed one");
        escrow.proposePayment(payee, 30 * USDT, "blocked one");
        vm.stopPrank();
        vm.warp(T0 + 1 days);
        vm.prank(owner);
        escrow.withdraw(owner, 5 * USDT);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        DecisionLog[] memory ds = decisionLogs(logs);
        CircuitLog[] memory cs = circuitLogs(logs);
        assertEq(ds.length, 3);
        assertEq(cs.length, 3);

        // The circuit parameters may have changed since; the event inputs are what was evaluated.
        vm.prank(owner);
        escrow.setDailyCap(1);

        vm.startPrank(stranger); // anyone
        for (uint256 i; i < ds.length; ++i) {
            CircuitLog[] memory mine = new CircuitLog[](1);
            mine[0] = cs[i];
            assertEq(cs[i].decisionId, ds[i].decisionId);

            // 1. Re-run the exact circuit on the exact recorded inputs.
            bytes memory out = ITapeOutLike(cs[i].processor).eval(cs[i].circuitId, cs[i].input);
            assertEq(out, cs[i].output, "same output");
            // 2. The circuit is still the one that was attached.
            assertEq(keccak256(ITapeOutLike(cs[i].processor).netlist(cs[i].circuitId)), cs[i].netlistHash);
            // 3. The recorded inputs are consistent with the decision summary.
            (uint256 amt, uint256 spent) = unpackFirstTwo(cs[i].input);
            assertEq(amt, ds[i].amount);
            assertEq(spent, ds[i].spentBefore);
            // 4. The event data matches the on-chain commitment.
            assertEq(recomputeRecordHash(ds[i], mine), escrow.decisionRecordHash(ds[i].decisionId));
            // 5. Outcome follows from the outputs.
            assertEq(ds[i].allowed, uint8(out[0]) & 1 == 1);
        }
        vm.stopPrank();
        assertTrue(ds[0].allowed);
        assertFalse(ds[1].allowed);
        assertTrue(ds[2].allowed);
        assertEq(ds[2].action, uint8(CircuitWillEscrow.Action.WITHDRAWAL));
    }

    function unpackFirstTwo(bytes memory input) internal pure returns (uint256 amount, uint256 spent) {
        for (uint256 j; j < 4; ++j) {
            amount |= uint256(uint8(input[j])) << (8 * j);
            spent |= uint256(uint8(input[4 + j])) << (8 * j);
        }
    }

    // ================================================================ controller NFT

    function test_constructorRequiresExistingControllerToken() public {
        vm.expectRevert();
        new CircuitWillEscrow(IERC20(address(usdt)), IERC721(address(key)), 999, ITapeOutFactory(address(0)));
    }

    function test_circuitWillKeyHasNoBurn() public {
        (bool ok,) = address(key).call(abi.encodeWithSignature("burn(uint256)", keyId));
        assertFalse(ok, "no burn function");
        assertEq(key.ownerOf(keyId), owner);
    }

    function test_burnableControllerWouldStrandFunds() public {
        // Documents why the controller NFT must be non-burnable.
        BurnableNft nft = new BurnableNft();
        nft.mint(owner, 1);
        CircuitWillEscrow e =
            new CircuitWillEscrow(IERC20(address(usdt)), IERC721(address(nft)), 1, ITapeOutFactory(address(0)));
        vm.prank(owner);
        nft.burn(1);
        vm.prank(owner);
        vm.expectRevert();
        e.withdraw(owner, 1);
    }
}

interface ITapeOutLike {
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
    function netlist(uint256 id) external view returns (bytes memory);
}
