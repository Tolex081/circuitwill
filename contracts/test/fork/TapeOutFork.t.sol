// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {CircuitWillEscrow} from "../../src/CircuitWillEscrow.sol";
import {CircuitWillKey} from "../../src/CircuitWillKey.sol";
import {ITapeOutCircuits, ITapeOutFactory} from "../../src/interfaces/ITapeOut.sol";
import {DailyCapPacking} from "../../src/libraries/DailyCapPacking.sol";
import {PayeeWhitelistPacking} from "../../src/libraries/PayeeWhitelistPacking.sol";
import {ConfirmationPacking} from "../../src/libraries/ConfirmationPacking.sol";
import {FreezePacking} from "../../src/libraries/FreezePacking.sol";

interface IForkFactory {
    function deployFee() external view returns (uint256);
    function isCPU(address circuits) external view returns (bool);
    function createCPU(string calldata, string calldata, string calldata, uint256, uint256)
        external
        returns (address transistors, address circuits);
}

interface IForkTransistors {
    function mint(uint256 id, uint256 amount) external payable;
    function mintPrice() external view returns (uint256);
    function protocolFee() external view returns (uint256);
    function balanceOf(address, uint256) external view returns (uint256);
}

interface IForkCircuits is ITapeOutCircuits {
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256);
    function TAPEOUT_FEE() external view returns (uint256);
    function ownerOf(uint256 id) external view returns (address);
}

/// @notice Runs the four generated netlists and the escrow against TapeOut's real X Layer contracts on a
///         LOCAL FORK. Nothing is broadcast. Skipped unless XLAYER_FORK_RPC is set:
///           XLAYER_FORK_RPC=https://rpc.xlayer.tech forge test --match-path test/fork/TapeOutFork.t.sol -vv
contract TapeOutForkTest is Test {
    address internal constant FACTORY = 0x1f09DAeFA827f02CBb40967cc91b259763760761;
    address internal constant USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant BEM = 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952;
    uint256 internal constant U32_MAX = type(uint32).max;

    uint256 internal constant U16_MAX = type(uint16).max;

    IForkCircuits internal circuits;
    uint256 internal dailyCapId;
    uint256 internal whitelistId;
    uint256 internal confirmationId;
    uint256 internal freezeId;
    bytes internal nl;
    bytes internal wlNl;
    bytes internal confNl;
    bytes internal freezeNl;
    bool internal enabled;

    function _read(string memory slug) internal view returns (bytes memory) {
        return vm.parseBytes(vm.trim(vm.readFile(string.concat("../circuits/", slug, "/build/", slug, ".netlist.hex"))));
    }

    /// @dev Tapes out on the fork CPU (caller is pranked as the designer). Tries without OKB first, then with the fee.
    function _tapeout(bytes memory netlist_, uint32 nIn) internal returns (uint256 id) {
        address c = address(circuits);
        (bool ok, bytes memory ret) = c.call(abi.encodeCall(IForkCircuits.tapeout, (netlist_, nIn, 1)));
        if (ok) {
            emit log("tapeout: succeeded without OKB value");
        } else {
            uint256 fee = circuits.TAPEOUT_FEE();
            (ok, ret) = c.call{value: fee}(abi.encodeCall(IForkCircuits.tapeout, (netlist_, nIn, 1)));
            emit log_named_uint("tapeout: required OKB value (wei)", fee);
        }
        assertTrue(ok, "tapeout failed");
        id = abi.decode(ret, (uint256));
    }

    function setUp() public {
        string memory rpc = vm.envOr("XLAYER_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        enabled = true;
        nl = _read("daily-cap");
        wlNl = _read("payee-whitelist");
        confNl = _read("confirmation");
        freezeNl = _read("freeze");

        uint256 blockNumber = vm.envOr("XLAYER_FORK_BLOCK", uint256(0));
        if (blockNumber == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blockNumber);
        assertEq(block.chainid, 196, "not X Layer");

        address designer = makeAddr("designer");
        vm.deal(designer, 1 ether);
        IForkFactory f = IForkFactory(FACTORY);
        // Observed 2026-11-19: the factory was upgraded (impl 0x336e9f0f...). createCPU is now non-payable and
        // pulls deployFee() (1e7 = 0.1 BEM, 8 decimals) via BEM transferFrom. New CPUs get a transistor
        // implementation (0x44Ebf334...) whose mint is also non-payable, so fees are approved in BEM here.
        // Fee details beyond "it succeeds on a fork" are NOT verified; see docs/TAPEOUT_INTERFACE.md.
        deal(BEM, designer, 1_000_000e8);
        vm.startPrank(designer);
        IERC20(BEM).approve(FACTORY, type(uint256).max);
        (address transistors, address c) = f.createCPU("CircuitWill Fork Test", "CWFT", "fork-only", 10_000, 0);
        circuits = IForkCircuits(c);
        IERC20(BEM).approve(transistors, type(uint256).max);
        IERC20(BEM).approve(c, type(uint256).max);
        uint256 gates = (nl.length + wlNl.length + confNl.length + freezeNl.length) / 7; // 447 + 237 + 160 + 1
        IForkTransistors(transistors).mint(0, gates); // id 0 = NAND
        assertEq(IForkTransistors(transistors).balanceOf(designer, 0), gates, "NAND minted");

        dailyCapId = _tapeout(nl, 96);
        whitelistId = _tapeout(wlNl, 97);
        confirmationId = _tapeout(confNl, 65);
        freezeId = _tapeout(freezeNl, 1);
        assertEq(IForkTransistors(transistors).balanceOf(designer, 0), 0, "one NAND transistor burned per element");
        vm.stopPrank();
    }

    function _assertInfo(uint256 id, bytes memory netlist_, uint32 wantIn, uint32 wantGates) internal view {
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) = circuits.circuitInfo(id);
        assertEq(nIn, wantIn);
        assertEq(nOut, 1);
        assertEq(nState, 0);
        assertEq(gateCount, wantGates);
        assertEq(circuits.netlist(id), netlist_);
    }

    function _bit(bytes memory out) internal pure returns (uint8) {
        assertEq(out.length, 1, "one output byte");
        return uint8(out[0]);
    }

    function test_fork_realTapeOutEvaluatesPayeeWhitelist() public {
        if (!enabled) vm.skip(true);
        _assertInfo(whitelistId, wlNl, 97, 237);
        // [saved, age, amount, trial, cooling]
        uint256[5][12] memory v = [
            [uint256(1), 0, U32_MAX, 0, U16_MAX],
            [uint256(0), 0, 0, 0, 0],
            [uint256(0), 0, 1, 0, 0],
            [uint256(0), 23, 5, 5, 24],
            [uint256(0), 24, 5, 5, 24],
            [uint256(0), 24, 6, 5, 24],
            [uint256(0), U16_MAX, U32_MAX, U32_MAX, U16_MAX],
            [uint256(0), U16_MAX - 1, 0, 0, U16_MAX],
            [uint256(0), 0, 0x80000000, 0x7fffffff, 0],
            [uint256(0), 0x8000, 0, 0, 0x7fff],
            [uint256(0), 0x7fff, 0, 0, 0x8000],
            [uint256(1), 0, 1, 0, 1]
        ];
        for (uint256 i; i < v.length; ++i) {
            bool s = v[i][0] == 1;
            (bool ok, bytes memory input) = PayeeWhitelistPacking.pack(s, v[i][1], v[i][2], v[i][3], v[i][4]);
            assertTrue(ok);
            uint8 want = s || (v[i][2] <= v[i][3] && v[i][1] >= v[i][4]) ? 1 : 0;
            assertEq(_bit(circuits.eval(whitelistId, input)), want, vm.toString(i));
        }
        (, bytes memory in0) = PayeeWhitelistPacking.pack(false, 24, 5, 5, 24);
        uint256 g = gasleft();
        circuits.eval(whitelistId, in0);
        emit log_named_uint("real TapeOut eval gas (Payee Whitelist, 237 NAND, incl. call overhead)", g - gasleft());
    }

    function test_fork_realTapeOutEvaluatesConfirmation() public {
        if (!enabled) vm.skip(true);
        _assertInfo(confirmationId, confNl, 65, 160);
        uint256[2][8] memory v = [
            [uint256(0), 0],
            [uint256(1), 0],
            [U32_MAX, U32_MAX],
            [U32_MAX, U32_MAX - 1],
            [uint256(20_000_000), 20_000_000],
            [uint256(20_000_001), 20_000_000],
            [uint256(0x80000000), 0x7fffffff],
            [U32_MAX, 0]
        ];
        for (uint256 i; i < v.length; ++i) {
            for (uint256 c; c < 2; ++c) {
                (bool ok, bytes memory input) = ConfirmationPacking.pack(v[i][0], v[i][1], c == 1);
                assertTrue(ok);
                uint8 want = v[i][0] <= v[i][1] || c == 1 ? 1 : 0;
                assertEq(_bit(circuits.eval(confirmationId, input)), want, vm.toString(i));
            }
        }
        (, bytes memory in0) = ConfirmationPacking.pack(30, 20, true);
        uint256 g = gasleft();
        circuits.eval(confirmationId, in0);
        emit log_named_uint("real TapeOut eval gas (Confirmation, 160 NAND, incl. call overhead)", g - gasleft());
    }

    function test_fork_realTapeOutEvaluatesFreeze() public {
        if (!enabled) vm.skip(true);
        _assertInfo(freezeId, freezeNl, 1, 1);
        (, bytes memory off) = FreezePacking.pack(false);
        (, bytes memory on) = FreezePacking.pack(true);
        assertEq(_bit(circuits.eval(freezeId, off)), 1);
        assertEq(_bit(circuits.eval(freezeId, on)), 0);
        uint256 g = gasleft();
        circuits.eval(freezeId, on);
        emit log_named_uint("real TapeOut eval gas (Freeze, 1 NAND, incl. call overhead)", g - gasleft());
    }

    function test_fork_estimatedGasIsEnoughWithFourCircuits() public {
        if (!enabled) vm.skip(true);
        address owner = makeAddr("owner");
        address saved = makeAddr("saved");
        CircuitWillKey key = new CircuitWillKey();
        uint256 keyId = key.mint(owner);
        CircuitWillEscrow escrow =
            new CircuitWillEscrow(IERC20(USDT0), IERC721(address(key)), keyId, ITapeOutFactory(FACTORY));
        vm.startPrank(owner);
        escrow.setDailyCap(50e6); // parameters first: loosening is delayed once a circuit is attached
        escrow.setConfirmationThreshold(20e6);
        escrow.setPayee(saved, true);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(circuits), dailyCapId);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.WHITELIST, address(circuits), whitelistId);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.CONFIRMATION, address(circuits), confirmationId);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.FREEZE, address(circuits), freezeId);
        vm.stopPrank();
        deal(USDT0, address(escrow), 200e6);

        // eth_estimateGas-style search: smallest gas limit at which proposePayment does not revert.
        bytes memory callData = abi.encodeCall(CircuitWillEscrow.proposePayment, (saved, 10e6, "fork: estimate"));
        uint256 lo = 50_000;
        uint256 hi = 30_000_000;
        while (hi - lo > 1_000) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            vm.prank(owner);
            (bool ok,) = address(escrow).call{gas: mid}(callData);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        emit log_named_uint("estimated proposePayment gas on fork (4 circuits)", hi);

        vm.prank(owner);
        (bool ok2, bytes memory ret) = address(escrow).call{gas: lo}(callData);
        assertFalse(ok2, "just below the estimate reverts");
        assertEq(bytes4(ret), CircuitWillEscrow.InsufficientGas.selector);

        vm.recordLogs();
        vm.prank(owner);
        (ok2, ret) = address(escrow).call{gas: hi}(callData);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(ok2);
        uint8[] memory statuses = _statuses(logs, address(escrow));
        assertEq(statuses.length, 4);
        for (uint256 i; i < 4; ++i) {
            emit log_named_uint("status at the estimate, circuit", i * 10 + statuses[i]);
        }
        (, bool allowed) = abi.decode(ret, (uint256, bool));
        assertTrue(allowed, "the estimated limit evaluates every circuit and allows the payment");
        assertEq(IERC20(USDT0).balanceOf(saved), 10e6);
    }

    /// @dev Status of each CircuitEvaluated log (1 = ALLOW).
    function _statuses(Vm.Log[] memory logs, address escrow) internal pure returns (uint8[] memory out) {
        bytes32 sig = CircuitWillEscrow.CircuitEvaluated.selector;
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == escrow && logs[i].topics[0] == sig) ++n;
        }
        out = new uint8[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != escrow || logs[i].topics[0] != sig) continue;
            (,,,,, uint8 status,) = abi.decode(logs[i].data, (uint8, address, uint256, bytes32, bytes, uint8, bytes));
            out[n++] = status;
        }
    }

    function test_fork_escrowWithFourCircuits() public {
        if (!enabled) vm.skip(true);
        address owner = makeAddr("owner");
        address saved = makeAddr("saved");
        address fresh = makeAddr("fresh");
        CircuitWillKey key = new CircuitWillKey();
        uint256 keyId = key.mint(owner);
        CircuitWillEscrow escrow =
            new CircuitWillEscrow(IERC20(USDT0), IERC721(address(key)), keyId, ITapeOutFactory(FACTORY));

        vm.startPrank(owner);
        escrow.setDailyCap(50e6); // parameters first: loosening is delayed once a circuit is attached
        escrow.setTrialLimit(5e6);
        escrow.setCoolingOffHours(24);
        escrow.setConfirmationThreshold(20e6);
        escrow.setPayee(saved, true);
        escrow.setPayee(owner, true);
        escrow.setPayee(fresh, false);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(circuits), dailyCapId);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.WHITELIST, address(circuits), whitelistId);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.CONFIRMATION, address(circuits), confirmationId);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.FREEZE, address(circuits), freezeId);
        vm.stopPrank();
        deal(USDT0, address(escrow), 200e6);

        vm.startPrank(owner);
        (, bool a) = escrow.proposePayment(fresh, 5e6, "fork: new payee, cooling-off");
        assertFalse(a, "new payee before cooling-off");
        (, a) = escrow.proposePayment(saved, 30e6, "fork: above threshold, unconfirmed");
        assertFalse(a, "needs confirmation");

        escrow.confirmPayment(escrow.currentPaymentHash(saved, 30e6));
        uint256 g = gasleft();
        (, a) = escrow.proposePayment(saved, 30e6, "fork: confirmed");
        emit log_named_uint("allowed proposePayment gas on fork (4 circuits, confirmation consumed)", g - gasleft());
        assertTrue(a, "confirmed payment");
        (, a) = escrow.proposePayment(saved, 30e6, "fork: reuse");
        assertFalse(a, "confirmation is single-use");

        escrow.setFrozen(true);
        g = gasleft();
        (, a) = escrow.withdraw(owner, 1e6);
        emit log_named_uint("blocked withdraw gas on fork (4 circuits)", g - gasleft());
        assertFalse(a, "freeze blocks withdrawals");
        // Unfreezing loosens the rules, so it waits ruleDelay (24 h) through the queue.
        uint256 unfreeze = escrow.queueChange(CircuitWillEscrow.ChangeKind.UNFREEZE, address(0), 0);
        vm.stopPrank();

        vm.warp(block.timestamp + 24 hours);
        vm.startPrank(owner);
        escrow.applyChange(unfreeze);
        (, a) = escrow.proposePayment(fresh, 5e6, "fork: after cooling-off");
        vm.stopPrank();
        assertTrue(a, "new payee after cooling-off, within trial limit");

        assertEq(IERC20(USDT0).balanceOf(saved), 30e6);
        assertEq(IERC20(USDT0).balanceOf(fresh), 5e6);
        assertEq(IERC20(USDT0).balanceOf(owner), 0);
    }

    function _eval(uint256 a, uint256 s, uint256 c) internal view returns (bytes memory) {
        (bool ok, bytes memory input) = DailyCapPacking.pack(a, s, c);
        assertTrue(ok);
        return circuits.eval(dailyCapId, input);
    }

    function test_fork_realTapeOutEvaluatesDailyCap() public {
        if (!enabled) vm.skip(true);
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) = circuits.circuitInfo(dailyCapId);
        assertEq(nIn, 96);
        assertEq(nOut, 1);
        assertEq(nState, 0);
        assertEq(gateCount, 447);
        assertEq(circuits.netlist(dailyCapId), nl);

        uint256[3][12] memory v = [
            [uint256(60), 0, 50],
            [uint256(30), 0, 50],
            [uint256(0), 0, 0],
            [uint256(1), 0, 0],
            [uint256(10), 40, 50],
            [uint256(10), 41, 50],
            [U32_MAX, 0, U32_MAX],
            [uint256(1), U32_MAX, U32_MAX],
            [U32_MAX, U32_MAX, U32_MAX],
            [uint256(0x80000000), 0x80000000, 0],
            [uint256(50_000_000), 0, 50_000_000],
            [uint256(50_000_001), 0, 50_000_000]
        ];
        for (uint256 i; i < v.length; ++i) {
            bytes memory out = _eval(v[i][0], v[i][1], v[i][2]);
            assertEq(out.length, 1, "one output byte");
            assertEq(uint8(out[0]), v[i][0] + v[i][1] <= v[i][2] ? 1 : 0);
        }
        uint256 g = gasleft();
        _eval(30, 0, 50);
        emit log_named_uint("real TapeOut eval gas (447 NAND, incl. call overhead)", g - gasleft());
    }

    function test_fork_escrowAgainstRealTapeOut() public {
        if (!enabled) vm.skip(true);
        address owner = makeAddr("owner");
        address payee = makeAddr("payee");
        CircuitWillKey key = new CircuitWillKey();
        uint256 keyId = key.mint(owner);
        CircuitWillEscrow escrow =
            new CircuitWillEscrow(IERC20(USDT0), IERC721(address(key)), keyId, ITapeOutFactory(FACTORY));

        vm.startPrank(owner);
        escrow.setDailyCap(50e6);
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(circuits), dailyCapId);
        vm.stopPrank();
        deal(USDT0, address(escrow), 100e6);

        vm.prank(owner);
        (, bool a) = escrow.proposePayment(payee, 60e6, "fork: 60 vs cap 50");
        assertFalse(a);
        assertEq(IERC20(USDT0).balanceOf(payee), 0);

        uint256 g = gasleft();
        vm.prank(owner);
        (, a) = escrow.proposePayment(payee, 30e6, "fork: 30 vs cap 50");
        emit log_named_uint("allowed proposePayment gas on fork", g - gasleft());
        assertTrue(a);
        assertEq(IERC20(USDT0).balanceOf(payee), 30e6);
        assertEq(escrow.spentToday(), 30e6);
    }
}
