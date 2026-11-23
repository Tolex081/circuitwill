// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {CircuitWillEscrow} from "../src/CircuitWillEscrow.sol";
import {CircuitWillKey} from "../src/CircuitWillKey.sol";
import {ITapeOutFactory} from "../src/interfaces/ITapeOut.sol";
import {TapeOutEval} from "../src/libraries/TapeOutEval.sol";
import {MockTapeOutCircuits, MockTapeOutFactory} from "./mocks/MockTapeOut.sol";
import {MockUSDT0} from "./mocks/MockTokens.sol";

abstract contract Base is Test {
    uint256 internal constant USDT = 1e6; // 6 decimals
    uint256 internal constant U32_MAX = type(uint32).max;
    // 2026-11-19 12:00:00 UTC
    uint256 internal constant T0 = 1_795_089_600; // UTC day 20776

    MockTapeOutCircuits internal processor;
    MockTapeOutFactory internal factory;
    MockUSDT0 internal usdt;
    CircuitWillKey internal key;
    CircuitWillEscrow internal escrow;
    uint256 internal keyId;
    uint256 internal dailyCapId;
    // Taped out on the mock processor in setUp, but not attached (Phase 1 tests run with Daily Cap only).
    uint256 internal whitelistId;
    uint256 internal confirmationId;
    uint256 internal freezeId;

    address internal owner = makeAddr("owner");
    address internal agentKey = makeAddr("agent");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");
    address internal newOwner = makeAddr("newOwner");

    struct DecisionLog {
        uint256 decisionId;
        uint8 action;
        bool allowed;
        address proposer;
        address to;
        uint256 amount;
        uint32 day;
        uint256 spentBefore;
        uint256 spentAfter;
        uint8 reason;
        string memo;
        bytes32 recordHash;
    }

    struct CircuitLog {
        uint256 decisionId;
        uint256 index;
        uint8 kind;
        address processor;
        uint256 circuitId;
        bytes32 netlistHash;
        bytes input;
        uint8 status;
        bytes output;
    }

    function readNetlist(string memory slug) internal view returns (bytes memory) {
        string memory path = string.concat("../circuits/", slug, "/build/", slug, ".netlist.hex");
        return vm.parseBytes(vm.trim(vm.readFile(path)));
    }

    function dailyCapNetlist() internal view returns (bytes memory) {
        return readNetlist("daily-cap");
    }

    function whitelistNetlist() internal view returns (bytes memory) {
        return readNetlist("payee-whitelist");
    }

    function confirmationNetlist() internal view returns (bytes memory) {
        return readNetlist("confirmation");
    }

    function freezeNetlist() internal view returns (bytes memory) {
        return readNetlist("freeze");
    }

    function setUp() public virtual {
        vm.warp(T0);
        processor = new MockTapeOutCircuits();
        factory = new MockTapeOutFactory();
        factory.register(address(processor));
        dailyCapId = processor.tapeout(dailyCapNetlist(), 96, 1);
        whitelistId = processor.tapeout(whitelistNetlist(), 97, 1);
        confirmationId = processor.tapeout(confirmationNetlist(), 65, 1);
        freezeId = processor.tapeout(freezeNetlist(), 1, 1);

        usdt = new MockUSDT0();
        key = new CircuitWillKey();
        keyId = key.mint(owner);

        escrow = new CircuitWillEscrow(
            IERC20(address(usdt)), IERC721(address(key)), keyId, ITapeOutFactory(address(factory))
        );

        vm.startPrank(owner);
        // Parameters first, circuits last: once a circuit is attached, raising a limit is delayed.
        escrow.setDailyCap(50 * USDT);
        escrow.setAgent(agentKey);
        configureBeforeAttach();
        escrow.attachCircuit(CircuitWillEscrow.CircuitKind.DAILY_CAP, address(processor), dailyCapId);
        vm.stopPrank();

        usdt.mint(address(escrow), 1_000 * USDT);
    }

    /// @dev Runs as the owner during setUp, before the first circuit is attached (setup: every setter applies at once).
    function configureBeforeAttach() internal virtual {}

    // ------------------------------------------------------------ delayed changes

    /// @dev Runs a loosening change through queue -> wait -> apply as the controller, then puts the clock back, so a
    ///      test can loosen a rule without the delay changing anything else it checks.
    function loosenNow(CircuitWillEscrow.ChangeKind kind, address target, uint256 value) internal {
        (VmSafe.CallerMode mode, address sender,) = vm.readCallers();
        bool recurrent = mode == VmSafe.CallerMode.RecurrentPrank;
        if (recurrent) vm.stopPrank();
        address c = escrow.controller();
        uint256 t = vm.getBlockTimestamp(); // not block.timestamp: via-IR may re-read it after the warp
        vm.prank(c);
        uint256 id = escrow.queueChange(kind, target, value);
        vm.warp(t + escrow.ruleDelay());
        vm.prank(c);
        escrow.applyChange(id);
        vm.warp(t);
        if (recurrent) vm.startPrank(sender);
    }

    /// @dev Detaches the circuit currently at `index` through the delay (see `loosenNow`).
    function detachNow(uint256 index) internal {
        (VmSafe.CallerMode mode, address sender,) = vm.readCallers();
        bool recurrent = mode == VmSafe.CallerMode.RecurrentPrank;
        if (recurrent) vm.stopPrank();
        uint64 uid = escrow.circuitAt(index).uid;
        loosenNow(CircuitWillEscrow.ChangeKind.DETACH_CIRCUIT, address(0), uid);
        if (recurrent) vm.startPrank(sender);
    }

    // ------------------------------------------------------------ log helpers

    function decisionLogs(Vm.Log[] memory logs) internal view returns (DecisionLog[] memory out) {
        bytes32 sig = CircuitWillEscrow.Decision.selector;
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(escrow) && logs[i].topics[0] == sig) ++n;
        }
        out = new DecisionLog[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(escrow) || logs[i].topics[0] != sig) continue;
            DecisionLog memory d;
            d.decisionId = uint256(logs[i].topics[1]);
            d.action = uint8(uint256(logs[i].topics[2]));
            d.allowed = uint256(logs[i].topics[3]) == 1;
            (d.proposer, d.to, d.amount, d.day, d.spentBefore, d.spentAfter, d.reason, d.memo, d.recordHash) =
                abi.decode(logs[i].data, (address, address, uint256, uint32, uint256, uint256, uint8, string, bytes32));
            out[n++] = d;
        }
    }

    function circuitLogs(Vm.Log[] memory logs) internal view returns (CircuitLog[] memory out) {
        bytes32 sig = CircuitWillEscrow.CircuitEvaluated.selector;
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(escrow) && logs[i].topics[0] == sig) ++n;
        }
        out = new CircuitLog[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(escrow) || logs[i].topics[0] != sig) continue;
            CircuitLog memory c;
            c.decisionId = uint256(logs[i].topics[1]);
            c.index = uint256(logs[i].topics[2]);
            (c.kind, c.processor, c.circuitId, c.netlistHash, c.input, c.status, c.output) =
                abi.decode(logs[i].data, (uint8, address, uint256, bytes32, bytes, uint8, bytes));
            out[n++] = c;
        }
    }

    function countTopic(Vm.Log[] memory logs, bytes32 sig) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(escrow) && logs[i].topics[0] == sig) ++n;
        }
    }

    /// @dev Independent re-implementation of the documented recordHash format, built only from event data.
    function recomputeRecordHash(DecisionLog memory d, CircuitLog[] memory cs) internal view returns (bytes32) {
        bytes32 h;
        for (uint256 i; i < cs.length; ++i) {
            h = keccak256(
                abi.encode(
                    h,
                    cs[i].kind,
                    cs[i].processor,
                    cs[i].circuitId,
                    cs[i].netlistHash,
                    keccak256(cs[i].input),
                    cs[i].status,
                    keccak256(cs[i].output)
                )
            );
        }
        return keccak256(
            abi.encode(
                address(escrow),
                block.chainid,
                d.decisionId,
                d.action,
                d.proposer,
                d.to,
                d.amount,
                d.day,
                d.spentBefore,
                d.allowed,
                d.reason,
                keccak256(bytes(d.memo)),
                h
            )
        );
    }

    function packDailyCap(uint256 amount, uint256 spent, uint256 cap) internal pure returns (bytes memory b) {
        b = new bytes(12);
        for (uint256 j; j < 4; ++j) {
            b[j] = bytes1(uint8(amount >> (8 * j)));
            b[4 + j] = bytes1(uint8(spent >> (8 * j)));
            b[8 + j] = bytes1(uint8(cap >> (8 * j)));
        }
    }

    /// @dev Independent re-implementation of the Payee Whitelist pinout, bit by bit (not via a uint256 word).
    function packWhitelist(bool saved, uint256 age, uint256 amount, uint256 trial, uint256 cooling)
        internal
        pure
        returns (bytes memory b)
    {
        b = new bytes(13);
        _setBits(b, 0, saved ? 1 : 0, 1);
        _setBits(b, 1, age, 16);
        _setBits(b, 17, amount, 32);
        _setBits(b, 49, trial, 32);
        _setBits(b, 81, cooling, 16);
    }

    function packConfirmation(uint256 amount, uint256 threshold, bool confirmed)
        internal
        pure
        returns (bytes memory b)
    {
        b = new bytes(9);
        _setBits(b, 0, amount, 32);
        _setBits(b, 32, threshold, 32);
        _setBits(b, 64, confirmed ? 1 : 0, 1);
    }

    function _setBits(bytes memory b, uint256 first, uint256 value, uint256 width) private pure {
        for (uint256 i; i < width; ++i) {
            if ((value >> i) & 1 == 1) {
                uint256 bit = first + i;
                b[bit >> 3] = bytes1(uint8(b[bit >> 3]) | uint8(1 << (bit & 7)));
            }
        }
    }

    function reason(CircuitWillEscrow.Reason r) internal pure returns (uint8) {
        return uint8(r);
    }

    function status(TapeOutEval.Status s) internal pure returns (uint8) {
        return uint8(s);
    }
}
