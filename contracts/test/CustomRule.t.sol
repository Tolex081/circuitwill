// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {CircuitWillEscrow} from "../src/CircuitWillEscrow.sol";
import {TapeOutEval} from "../src/libraries/TapeOutEval.sol";
import {SpendWindows} from "../src/libraries/SpendWindows.sol";
import {MockTapeOutCircuits} from "./mocks/MockTapeOut.sol";

/// @notice Forwards to a real (mock) processor but lets the test change what `netlist` returns, like a TapeOut upgrade
///         that altered stored circuits.
contract TamperableProcessor {
    MockTapeOutCircuits public immutable inner;
    bytes public override_;
    bool public tampered;

    constructor(MockTapeOutCircuits inner_) {
        inner = inner_;
    }

    function tamper(bytes calldata nl) external {
        override_ = nl;
        tampered = true;
    }

    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32) {
        return inner.circuitInfo(id);
    }

    function netlist(uint256 id) external view returns (bytes memory) {
        return tampered ? override_ : inner.netlist(id);
    }

    function eval(uint256 id, bytes calldata input) external view returns (bytes memory) {
        return inner.eval(id, input);
    }
}

/// @notice Custom rules: attach checks, the facts layout, enforcement of the example rules compiled by
///         frontend/lib/rule-compiler.js (circuits/custom/build), the beneficiary and check-in, and the tamper check.
///         Base setUp: Daily Cap attached (cap 50 USDT0), agent set, 1,000 USDT0 in the escrow, T0 = Thursday 12:00 UTC.
contract CustomRuleTest is Base {
    uint256 internal sonId;
    uint256 internal daily10Id;
    uint256 internal agent50Id;
    uint256 internal weekId;
    uint256 internal inheritId;
    uint256 internal ownerOnlyId;
    address internal daughter = makeAddr("daughter");

    uint8 internal constant K_CUSTOM = uint8(CircuitWillEscrow.CircuitKind.CUSTOM);

    function setUp() public override {
        super.setUp();
        sonId = processor.tapeout(customNetlist("son"), 256, 1);
        daily10Id = processor.tapeout(customNetlist("daily-10"), 256, 1);
        agent50Id = processor.tapeout(customNetlist("agent-50-5-trusted"), 256, 1);
        weekId = processor.tapeout(customNetlist("week-200-48h"), 256, 1);
        inheritId = processor.tapeout(customNetlist("inheritance"), 256, 1);
        ownerOnlyId = processor.tapeout(customNetlist("owner-10"), 256, 1);
    }

    // ================================================================ helpers

    function customNetlist(string memory slug) internal view returns (bytes memory) {
        string memory path = string.concat("../circuits/custom/build/", slug, ".netlist.hex");
        return vm.parseBytes(vm.trim(vm.readFile(path)));
    }

    function specHash(string memory slug) internal view returns (bytes32) {
        return keccak256(bytes(vm.readFile(string.concat("../circuits/custom/build/", slug, ".spec.txt"))));
    }

    function attach(string memory slug, uint256 id) internal returns (uint64 uid) {
        vm.prank(owner);
        (, uid) = escrow.attachCustomRule(
            address(processor),
            id,
            keccak256(customNetlist(slug)),
            specHash(slug),
            appliesTo(slug),
            string.concat("rule ", slug)
        );
    }

    /// @dev The roles each example rule limits (circuits/custom/examples.mjs appliesTo): 1 owner, 2 agent, 4 beneficiary.
    function appliesTo(string memory slug) internal pure returns (uint8) {
        bytes32 h = keccak256(bytes(slug));
        if (h == keccak256("son") || h == keccak256("agent-50-5-trusted")) return 2;
        if (h == keccak256("inheritance")) return 4;
        if (h == keccak256("owner-10")) return 1;
        return 7; // daily-10, week-200-48h
    }

    function propose(address from, address to, uint256 amount) internal returns (bool allowed) {
        vm.prank(from);
        (, allowed) = escrow.proposePayment(to, amount, "");
    }

    /// @dev Unix time of local (UTC+1) weekday `d` (0 = Monday) hh:mm in the week of T0 (Thursday 2026-11-19).
    function lagos(uint256 d, uint256 hh, uint256 mm) internal pure returns (uint256) {
        uint256 monday = 1_794_787_200; // Monday 2026-11-16 00:00 UTC
        return monday + d * 1 days + hh * 1 hours + mm * 1 minutes - 1 hours;
    }

    /// @dev Independent packer for the facts layout, bit by bit (not via a word), to check the escrow's packing.
    function packFactsRef(uint256[15] memory v) internal pure returns (bytes memory b) {
        b = new bytes(32);
        uint256[15] memory first = [uint256(0), 32, 64, 96, 128, 160, 168, 178, 179, 180, 181, 197, 213, 215, 216];
        uint256[15] memory width = [uint256(32), 32, 32, 32, 32, 8, 10, 1, 1, 1, 16, 16, 2, 1, 1];
        for (uint256 f; f < 15; ++f) {
            for (uint256 i; i < width[f]; ++i) {
                if ((v[f] >> i) & 1 == 1) {
                    uint256 bit = first[f] + i;
                    b[bit >> 3] = bytes1(uint8(b[bit >> 3]) | uint8(1 << (bit & 7)));
                }
            }
        }
    }

    // ================================================================ attach

    function test_attachCustomRule_pinsNetlistAndSpec() public {
        bytes32 nh = keccak256(customNetlist("son"));
        vm.recordLogs();
        uint64 uid = attach("son", sonId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(escrow.customRuleCount(), 1);
        assertEq(escrow.customSpecHash(uid), specHash("son"));
        assertEq(escrow.customAppliesTo(uid), 2);
        CircuitWillEscrow.AttachedCircuit memory c = escrow.circuitAt(1);
        assertEq(uint8(c.kind), K_CUSTOM);
        assertEq(c.netlistHash, nh);
        assertEq(c.uid, uid);
        assertEq(escrow.indexOfCircuit(uid), 1);
        assertFalse(c.tampered);

        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != CircuitWillEscrow.CustomRuleAttached.selector) continue;
            seen = true;
            assertEq(uint64(uint256(logs[i].topics[1])), uid);
            (bytes32 h, bytes32 s, uint32 v, uint8 a, string memory text) =
                abi.decode(logs[i].data, (bytes32, bytes32, uint32, uint8, string));
            assertEq(h, nh);
            assertEq(s, specHash("son"));
            assertEq(v, 1);
            assertEq(a, 2, "the son rule limits the AI helper only");
            assertEq(text, "rule son");
        }
        assertTrue(seen, "CustomRuleAttached emitted");
    }

    function test_attachCustomRule_rejectsWrongCircuits() public {
        bytes32 nh = keccak256(customNetlist("son"));
        bytes32 sh = specHash("son");
        vm.startPrank(owner);
        // The circuit id must be the one the owner previewed.
        vm.expectRevert(
            abi.encodeWithSelector(
                CircuitWillEscrow.NetlistHashMismatch.selector, nh, keccak256(customNetlist("daily-10"))
            )
        );
        escrow.attachCustomRule(address(processor), daily10Id, nh, sh, 2, "");
        // Official circuits do not have the facts pinout.
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.PinoutMismatch.selector, 96, 1, 0));
        escrow.attachCustomRule(address(processor), dailyCapId, nh, sh, 2, "");
        vm.expectRevert(CircuitWillEscrow.ZeroHash.selector);
        escrow.attachCustomRule(address(processor), sonId, nh, bytes32(0), 2, "");
        // It must say which roles it limits (owner 1, agent 2, beneficiary 4).
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.ValueOutOfRange.selector, 0, 7));
        escrow.attachCustomRule(address(processor), sonId, nh, sh, 0, "");
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.ValueOutOfRange.selector, 8, 7));
        escrow.attachCustomRule(address(processor), sonId, nh, sh, 8, "");
        vm.expectRevert(CircuitWillEscrow.RuleTextTooLong.selector);
        escrow.attachCustomRule(address(processor), sonId, nh, sh, 2, string(new bytes(281)));
        vm.expectRevert(
            abi.encodeWithSelector(
                CircuitWillEscrow.UnsupportedCircuitKind.selector, CircuitWillEscrow.CircuitKind.CUSTOM
            )
        );
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.CUSTOM, address(processor), sonId);
        vm.stopPrank();

        // Too many gates: a 1,001-gate chain with the right pinout.
        bytes memory big = new bytes(1001 * 7);
        for (uint256 i; i < 1001; ++i) {
            uint256 s = i == 0 ? 2 : 2 + 256 + i - 1;
            big[i * 7 + 3] = bytes1(uint8(s));
            big[i * 7 + 2] = bytes1(uint8(s >> 8));
            big[i * 7 + 6] = bytes1(uint8(s));
            big[i * 7 + 5] = bytes1(uint8(s >> 8));
        }
        uint256 bigId = processor.tapeout(big, 256, 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.TooManyGates.selector, 1001, 1000));
        escrow.attachCustomRule(address(processor), bigId, keccak256(big), sh, 2, "");

        // Only the controller.
        vm.prank(agentKey);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.attachCustomRule(address(processor), sonId, nh, sh, 2, "");
    }

    function test_attachCustomRule_atMostThree() public {
        attach("son", sonId);
        attach("daily-10", daily10Id);
        attach("agent-50-5-trusted", agent50Id);
        vm.prank(owner);
        vm.expectRevert(CircuitWillEscrow.TooManyCustomRules.selector);
        escrow.attachCustomRule(
            address(processor), weekId, keccak256(customNetlist("week-200-48h")), specHash("week-200-48h"), 7, ""
        );
    }

    // ================================================================ facts

    function test_facts_matchIndependentPacking() public {
        vm.startPrank(owner);
        escrow.setPayee(payee, false); // known, not saved, age 0
        vm.stopPrank();
        attach("daily-10", daily10Id);
        assertTrue(propose(owner, payee, 3 * USDT + 1)); // 300.0001 cents -> 301 rounded up in the ring/month

        vm.warp(T0 + 5 hours + 7 minutes);
        // amount 2.5 USDT = 250 cents; spent today 3.000001 + 2.5 = 550.0001 -> 551 cents (rounded up)
        (bool ok, bytes memory got) = escrow.customFactsFor(agentKey, payee, 2_500_000, false);
        assertTrue(ok);
        uint256 slot = 3 * 96 + 68; // Thursday 17:07 UTC: slot 68 of the day (17:00-17:15)
        uint256 bal = (1_000 * USDT - 3 * USDT - 1 - 2_500_000) / 10_000;
        uint256[15] memory v = [uint256(250), 551, 301 + 250, 301 + 250, bal, 2, slot, 0, 1, 1, 5, 5, 1, 0, 0];
        assertEq(got, packFactsRef(v));

        // The owner's withdrawal: role 0, withdrawal flag set.
        (, got) = escrow.customFactsFor(owner, owner, 1, true);
        uint256[15] memory w =
            [uint256(1), 301, 302, 302, (1_000 * USDT - 3 * USDT - 2) / 10_000, 2, slot, 0, 0, 0, 0, 5, 0, 0, 1];
        assertEq(got, packFactsRef(w));
    }

    function test_facts_amountTooLargeIsNotEvaluated() public {
        attach("daily-10", daily10Id);
        usdt.mint(address(escrow), 1e18);
        (bool ok,) = escrow.customFactsFor(owner, payee, uint256(type(uint32).max) * 10_000 + 1, false);
        assertFalse(ok, "amount above 2^32 - 1 cents cannot be packed");
    }

    function test_facts_rollingWeekAndMonth() public {
        attach("daily-10", daily10Id); // any custom rule, so facts are computed; owner is limited to 10/day
        // Thursday 19 Nov: 10. Then 10 every day through Wednesday 25 Nov (7 days, 70 total).
        for (uint256 d; d < 7; ++d) {
            vm.warp(T0 + d * 1 days);
            assertTrue(propose(owner, payee, 10 * USDT), "10 a day");
        }
        vm.warp(T0 + 6 days + 1 hours);
        (, bytes memory f) = escrow.customFactsFor(owner, payee, 1, false);
        assertEq(_field(f, 64, 32), 7000 + 1, "rolling 7 days incl. this payment");
        // Thursday 26 Nov: 19 Nov has dropped out of the window.
        vm.warp(T0 + 7 days);
        (, f) = escrow.customFactsFor(owner, payee, 1, false);
        assertEq(_field(f, 64, 32), 6000 + 1);
        assertEq(_field(f, 96, 32), 7000 + 1, "November month total");
        assertEq(_field(f, 160, 8), 1, "first payment today");
        // 1 December: new month.
        vm.warp(1_796_083_200 + 1 hours); // 2026-12-01 01:00 UTC
        (, f) = escrow.customFactsFor(owner, payee, 1, false);
        assertEq(_field(f, 96, 32), 1);
        assertEq(_field(f, 64, 32), 1000 + 1, "of the paid days only 25 Nov is still in the 7-day window");
    }

    function _field(bytes memory b, uint256 first, uint256 width) internal pure returns (uint256 v) {
        for (uint256 i; i < width; ++i) {
            uint256 bit = first + i;
            if ((uint8(b[bit >> 3]) >> (bit & 7)) & 1 == 1) v |= 1 << i;
        }
    }

    function test_spendWindows_calendar() public pure {
        assertEq(SpendWindows.monthKey(0), 1970 * 12, "1970-01-01");
        assertEq(SpendWindows.monthKey(20_776), 2026 * 12 + 10, "2026-11-19");
        assertEq(SpendWindows.monthKey(20_788), 2026 * 12 + 11, "2026-12-01");
        assertEq(SpendWindows.monthKey(11_016), 2000 * 12 + 1, "2000-02-29");
        assertEq(SpendWindows.monthKey(11_017), 2000 * 12 + 2, "2000-03-01");
        assertEq(SpendWindows.slotOfWeek(1_794_787_200), 0, "Monday 00:00 UTC");
        assertEq(SpendWindows.slotOfWeek(1_794_787_200 + 7 days - 1), 671, "Sunday 23:59:59 UTC");
    }

    // ================================================================ enforcement

    function test_sonRule_weekdaysBefore9pmUpTo10() public {
        attach("son", sonId);
        vm.warp(lagos(4, 20, 45)); // Friday 20:45 Lagos
        assertTrue(propose(agentKey, payee, 6 * USDT));
        assertTrue(propose(agentKey, payee, 4 * USDT), "exactly 10.00 today");
        assertFalse(propose(agentKey, payee, 10_000), "10.01 today");
        assertTrue(propose(owner, payee, 20 * USDT), "the owner is not limited by the son's rule");

        vm.warp(lagos(4, 21, 0)); // Friday 21:00 Lagos, new UTC day not yet (20:00 UTC)
        assertFalse(propose(agentKey, payee, 1), "not at 9 pm");
        vm.warp(lagos(5, 10, 0)); // Saturday
        assertFalse(propose(agentKey, payee, 1), "not on Saturday");
        vm.warp(lagos(7, 0, 0)); // next Monday 00:00 Lagos = Sunday 23:00 UTC
        assertTrue(propose(agentKey, payee, 1), "Monday just after midnight, local time");
    }

    function test_decisionRecordsTheFactsAndIsReEvaluable() public {
        attach("son", sonId);
        vm.warp(lagos(4, 9, 0));
        vm.recordLogs();
        assertTrue(propose(agentKey, payee, 5 * USDT));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        CircuitLog[] memory cs = circuitLogs(logs);
        assertEq(cs.length, 2);
        assertEq(cs[1].kind, K_CUSTOM);
        assertEq(cs[1].input.length, 32);
        assertEq(processor.eval(sonId, cs[1].input), hex"01", "anyone can re-run the recorded input");
        DecisionLog memory d = decisionLogs(logs)[0];
        assertEq(recomputeRecordHash(d, cs), d.recordHash, "record hash format unchanged");
    }

    /// @dev AND composition: attaching a custom rule can only turn "allowed" into "blocked", never the reverse.
    function testFuzz_addingACustomRuleNeverAllowsMore(uint256 amount, uint256 dt, uint8 who, uint8 rule) public {
        amount = bound(amount, 1, 80 * USDT);
        dt = bound(dt, 0, 14 days);
        address from = who % 2 == 0 ? owner : agentKey;
        vm.warp(T0 + dt);
        uint256 snap = vm.snapshotState();
        bool without = propose(from, payee, amount);
        vm.revertToState(snap);
        uint256 r = rule % 4;
        if (r == 0) attach("son", sonId);
        else if (r == 1) attach("daily-10", daily10Id);
        else if (r == 2) attach("agent-50-5-trusted", agent50Id);
        else attach("week-200-48h", weekId);
        bool with_ = propose(from, payee, amount);
        if (with_) assertTrue(without, "a custom rule allowed something the official rules blocked");
    }

    // ================================================================ beneficiary and check-in

    function test_beneficiary_isDelayedAndNeedsACustomRule() public {
        vm.prank(owner);
        vm.expectRevert(CircuitWillEscrow.LooseningIsDelayed.selector);
        escrow.setBeneficiary(daughter);
        loosenNow(CircuitWillEscrow.ChangeKind.BENEFICIARY, daughter, 0);
        assertTrue(escrow.isActiveBeneficiary(daughter));
        assertEq(escrow.roleOf(daughter), 2);

        vm.recordLogs();
        assertFalse(propose(daughter, daughter, 1), "no custom rule: the beneficiary may do nothing");
        assertEq(decisionLogs(vm.getRecordedLogs())[0].reason, reason(CircuitWillEscrow.Reason.NO_CUSTOM_RULE));

        // Clearing applies at once.
        vm.prank(owner);
        escrow.setBeneficiary(address(0));
        vm.prank(daughter);
        vm.expectRevert(CircuitWillEscrow.NotProposer.selector);
        escrow.proposePayment(daughter, 1, "");
    }

    /// @dev Security review 2026-11-24: a custom rule that does not limit the beneficiary (here the son rule, which
    ///      limits only the AI helper) must not hand a named beneficiary the owner's spending power.
    function test_beneficiary_needsARuleThatLimitsTheBeneficiary() public {
        loosenNow(CircuitWillEscrow.ChangeKind.BENEFICIARY, daughter, 0);
        attach("son", sonId);
        vm.warp(lagos(0, 10, 0) + 7 days); // next Monday 10:00 in Lagos: the son rule itself would let her through
        vm.recordLogs();
        assertFalse(propose(daughter, daughter, 40 * USDT), "the son rule says nothing about the beneficiary");
        assertEq(decisionLogs(vm.getRecordedLogs())[0].reason, reason(CircuitWillEscrow.Reason.NO_CUSTOM_RULE));

        // A rule that does limit the beneficiary is what lets her act, within that rule.
        attach("inheritance", inheritId);
        assertFalse(propose(daughter, daughter, 40 * USDT), "inheritance rule: owner checked in recently");
        vm.warp(lagos(0, 10, 0) + 7 days + 182 days);
        assertTrue(propose(daughter, daughter, 40 * USDT), "inheritance rule unlocked after 180 days");
    }

    /// @dev Security review 2026-11-24: naming an AI helper that a custom rule does not limit, while that rule limits
    ///      the owner, would let a stolen key escape the owner's own limit at once. It waits like any loosening.
    function test_setAgent_isDelayedWhileARuleLimitsTheOwnerButNotTheAgent() public {
        attach("owner-10", ownerOnlyId);
        address thiefAgent = makeAddr("thiefAgent");
        assertTrue(propose(owner, payee, 10 * USDT));
        assertFalse(propose(owner, payee, 1 * USDT), "the owner is held to 10 a day");

        vm.prank(owner);
        vm.expectRevert(CircuitWillEscrow.LooseningIsDelayed.selector);
        escrow.setAgent(thiefAgent);
        // Clearing the AI helper still applies at once.
        vm.prank(owner);
        escrow.setAgent(address(0));
        assertFalse(escrow.isActiveAgent(agentKey));

        // Through the queue it works after the delay, so the owner has a day to notice and cancel.
        loosenNow(CircuitWillEscrow.ChangeKind.AGENT, thiefAgent, 0);
        assertTrue(escrow.isActiveAgent(thiefAgent));
    }

    /// @dev With only rules that also limit the AI helper, replacing the helper gives no one more power than the owner
    ///      already has, so it still applies at once.
    function test_setAgent_staysImmediateWhenEveryRuleLimitsTheAgent() public {
        attach("daily-10", daily10Id);
        address newAgent = makeAddr("newAgent");
        vm.prank(owner);
        escrow.setAgent(newAgent);
        assertTrue(escrow.isActiveAgent(newAgent));
    }

    function test_inheritance_unlocksAfter180DaysWithoutCheckIn() public {
        loosenNow(CircuitWillEscrow.ChangeKind.BENEFICIARY, daughter, 0);
        attach("inheritance", inheritId);
        assertFalse(propose(daughter, daughter, 1 * USDT), "owner checked in recently");

        vm.warp(T0 + 179 days);
        vm.prank(owner);
        escrow.checkIn(); // still alive
        vm.warp(T0 + 179 days + 179 days);
        assertFalse(propose(daughter, daughter, 1 * USDT), "check-in restarted the clock");

        vm.warp(T0 + 179 days + 180 days);
        assertTrue(propose(daughter, daughter, 40 * USDT));
        assertTrue(propose(owner, owner, 1 * USDT), "the owner is not limited by the inheritance rule");

        // The agent cannot check in for the owner.
        vm.prank(agentKey);
        vm.expectRevert(CircuitWillEscrow.NotController.selector);
        escrow.checkIn();
    }

    function test_inheritance_monthlyLimit() public {
        loosenNow(CircuitWillEscrow.ChangeKind.BENEFICIARY, daughter, 0);
        attach("inheritance", inheritId);
        // 2027-06-01 00:00 UTC: more than 180 days after T0, start of a month.
        vm.warp(1_811_808_000);
        for (uint256 d; d < 10; ++d) {
            vm.warp(1_811_808_000 + d * 1 days);
            assertTrue(propose(daughter, daughter, 50 * USDT), "50 a day within 500 a month");
        }
        vm.warp(1_811_808_000 + 10 days);
        assertFalse(propose(daughter, daughter, 1), "500.01 this month");
        vm.warp(1_814_400_000); // 2027-07-01
        assertTrue(propose(daughter, daughter, 50 * USDT), "new month");
    }

    // ================================================================ tamper check

    function test_tamperCheck_marksChangedCircuitAsFailed() public {
        TamperableProcessor tp = new TamperableProcessor(processor);
        factory.register(address(tp));
        bytes memory nl = customNetlist("daily-10");
        vm.prank(owner);
        (, uint64 uid) = escrow.attachCustomRule(address(tp), daily10Id, keccak256(nl), specHash("daily-10"), 7, "");

        assertTrue(escrow.checkCircuit(uid), "unchanged: nothing happens");
        assertFalse(escrow.circuitAt(1).tampered);
        assertTrue(propose(agentKey, payee, 1 * USDT));

        tp.tamper(hex"00000002000002");
        vm.prank(stranger); // anyone may call it
        assertFalse(escrow.checkCircuit(uid));
        assertTrue(escrow.circuitAt(1).tampered);

        vm.recordLogs();
        assertFalse(propose(agentKey, payee, 1 * USDT), "a tampered circuit always fails");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(circuitLogs(logs)[1].status, status(TapeOutEval.Status.REVERTED));
        assertEq(decisionLogs(logs)[0].reason, reason(CircuitWillEscrow.Reason.EVAL_FAILED));

        // Removing it goes through the delay like any detach.
        detachNow(1);
        assertEq(escrow.customRuleCount(), 0);
        assertEq(escrow.customSpecHash(uid), bytes32(0));
        assertTrue(propose(agentKey, payee, 1 * USDT));
    }

    function test_tamperCheck_unknownUidReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CircuitWillEscrow.UnknownCircuit.selector, uint64(99)));
        escrow.checkCircuit(99);
    }
}
