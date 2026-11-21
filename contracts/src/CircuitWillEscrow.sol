// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITapeOutCircuits, ITapeOutFactory} from "./interfaces/ITapeOut.sol";
import {TapeOutEval} from "./libraries/TapeOutEval.sol";
import {DailyCapPacking} from "./libraries/DailyCapPacking.sol";
import {PayeeWhitelistPacking} from "./libraries/PayeeWhitelistPacking.sol";
import {ConfirmationPacking} from "./libraries/ConfirmationPacking.sol";
import {FreezePacking} from "./libraries/FreezePacking.sol";

/// @title CircuitWillEscrow
/// @notice Holds one ERC-20 (USDT0 on X Layer) and releases it only when every attached TapeOut circuit
///         returns allow. Control follows a controller NFT that stays in its owner's wallet.
/// @dev Supports the four MVP circuits: Daily Cap, Payee Whitelist + Cooling-off, Confirmation Threshold and
///      Freeze. Each kind can be attached at most once (up to `MAX_CIRCUITS`).
///
///      Parameter-change timing: every parameter (daily cap, saved payees, trial limit, cooling-off hours,
///      confirmation threshold, freeze flag, attached circuits) is read when `proposePayment` / `withdraw` executes.
///      There is no snapshot at proposal time and no timelock: a change applies to the very next decision, including
///      one later in the same block. Every change emits an event.
///
///      Invariants:
///      - Every outbound token transfer, including the owner's `withdraw`, goes through `_execute`.
///      - A blocked decision is recorded (storage + events) and the call returns normally. After the decision id has
///        been assigned, the only revert is `InsufficientGas`: the caller did not leave an eval its full
///        `evalGasLimit` budget and that eval ran out of gas. The whole call then reverts like any out-of-gas
///        transaction (nothing is recorded or moved), so `eth_estimateGas` finds a limit that is enough.
///      - Any evaluation problem (revert, a circuit using its whole gas budget, missing code, malformed output,
///        unpackable input, no circuits attached) blocks the transfer and is recorded.
contract CircuitWillEscrow is ReentrancyGuard {
    // ---------------------------------------------------------------- types

    /// @dev Values are part of the public event format. Do not reorder.
    enum CircuitKind {
        NONE,
        DAILY_CAP,
        WHITELIST,
        CONFIRMATION,
        FREEZE
    }

    enum Action {
        PAYMENT,
        WITHDRAWAL
    }

    enum Reason {
        NONE, // allowed
        CIRCUIT_DENIED, // at least one circuit returned 0
        EVAL_FAILED, // at least one circuit reverted, ran out of gas, or returned malformed output
        INPUT_OUT_OF_RANGE, // a value did not fit its pin width, so no circuit input could be built
        NO_CIRCUITS, // no circuits attached: nothing can authorize a transfer
        INSUFFICIENT_BALANCE, // circuits allowed, but the escrow does not hold enough tokens
        TRANSFER_FAILED // circuits allowed, but the token transfer failed
    }

    struct AttachedCircuit {
        CircuitKind kind;
        address processor; // TapeOut circuits contract
        uint256 circuitId;
        bytes32 netlistHash; // keccak256(processor.netlist(circuitId)) at attach time
    }

    /// @notice A payee entry. `firstSeen` is set when the controller first adds the payee and is kept while the
    ///         entry exists; `saved` marks it as trusted (the whitelist circuit then allows it without limits).
    struct Payee {
        uint64 firstSeen;
        bool saved;
    }

    /// @notice A controller confirmation of one exact payment hash (see `hashPayment`).
    struct Confirmation {
        uint64 expiresAt; // valid while block.timestamp <= expiresAt
        address confirmedBy; // must still own the controller NFT when the payment executes
    }

    /// @dev Values read from on-chain state once per decision and packed into the circuit inputs.
    struct Context {
        address to;
        uint256 amount;
        uint256 spentBefore;
        bool confirmed;
    }

    struct EvalResult {
        TapeOutEval.Status status;
        bytes input;
        bytes output;
    }

    // ---------------------------------------------------------------- constants

    uint256 public constant MAX_CIRCUITS = 4;
    uint256 public constant MAX_MEMO_BYTES = 256;
    uint256 public constant SECONDS_PER_DAY = 86_400;
    uint256 public constant SECONDS_PER_HOUR = 3_600;

    /// @notice How long a `confirmPayment` stays usable.
    uint256 public constant CONFIRMATION_TTL = 1 hours;

    /// @notice Domain tag of `hashPayment`.
    bytes32 public constant PAYMENT_TYPEHASH =
        keccak256("CircuitWill.Payment(uint256 chainId,address escrow,address to,uint256 amount,uint256 nonce)");

    /// @dev Gas kept back from every eval call so the decision can always be recorded and the transfer made.
    uint256 public constant GAS_RESERVE = 250_000;

    /// @notice Default and allowed range of `evalGasLimit`. The default is about 2.8x the measured cost of the
    ///         largest circuit (Daily Cap, ~1.07M gas on TapeOut). X Layer's block gas limit was 210M on 2026-11-20,
    ///         so four circuits at the maximum budget still fit in a block.
    uint256 public constant DEFAULT_EVAL_GAS_LIMIT = 3_000_000;
    uint256 public constant MIN_EVAL_GAS_LIMIT = 100_000;
    uint256 public constant MAX_EVAL_GAS_LIMIT = 30_000_000;

    // ---------------------------------------------------------------- immutable configuration

    IERC20 public immutable token;
    IERC721 public immutable controllerNft;
    uint256 public immutable controllerTokenId;
    /// @notice Optional TapeOut factory. When non-zero, only processors with `isCPU == true` can be attached.
    ITapeOutFactory public immutable tapeoutFactory;

    // ---------------------------------------------------------------- state

    AttachedCircuit[] internal _circuits;

    /// @notice Daily Cap parameter in token base units (<= type(uint32).max).
    uint256 public dailyCap;
    /// @notice Sum of allowed outbound transfers during `lastResetDay` (UTC).
    uint256 public spentToday;
    /// @notice UTC day number, `block.timestamp / 86400`, of the last reset.
    uint32 public lastResetDay;

    /// @notice Payee Whitelist parameters. `trialLimit` is the largest payment (token base units, <= uint32 max) to a
    ///         payee that is not saved; `coolingOffHours` (<= uint16 max) is how long such a payee must have been
    ///         known before any payment to it is allowed.
    uint256 public trialLimit;
    uint256 public coolingOffHours;
    mapping(address payee => Payee) public payees;

    /// @notice Confirmation Threshold parameter (token base units, <= uint32 max). Payments above it need a
    ///         `confirmPayment` for their exact hash.
    uint256 public confirmationThreshold;
    mapping(bytes32 paymentHash => Confirmation) public confirmations;
    /// @notice Per-recipient nonce bound into `hashPayment`. It increases each time a confirmation is consumed.
    mapping(address to => uint256) public paymentNonce;

    /// @notice Freeze flag packed into the Freeze circuit.
    bool public frozen;

    /// @notice Gas budget given to each circuit eval. An eval that uses all of it is recorded as REVERTED (blocked).
    ///         An eval that runs out of gas while holding less than this budget, because the caller sent too little
    ///         gas, makes the call revert with `InsufficientGas` instead.
    uint256 public evalGasLimit = DEFAULT_EVAL_GAS_LIMIT;

    /// @notice Agent key that may call `proposePayment`. It is only active while `agentSetBy` still owns the
    ///         controller NFT, so a transfer of the NFT disables the previous owner's agent automatically.
    address public agent;
    address public agentSetBy;

    uint256 public decisionCount;
    /// @notice Commitment to each decision's full record; see `_recordHash` and the README for the format.
    mapping(uint256 decisionId => bytes32) public decisionRecordHash;

    // ---------------------------------------------------------------- events

    event Decision(
        uint256 indexed decisionId,
        Action indexed action,
        bool indexed allowed,
        address proposer,
        address to,
        uint256 amount,
        uint32 day,
        uint256 spentTodayBefore,
        uint256 spentTodayAfter,
        Reason reason,
        string memo,
        bytes32 recordHash
    );

    /// @notice One per attached circuit per decision, emitted before `Decision`. `input` is exactly the bytes
    ///         passed to `processor.eval(circuitId, input)` (empty if they could not be built).
    event CircuitEvaluated(
        uint256 indexed decisionId,
        uint256 indexed index,
        CircuitKind kind,
        address processor,
        uint256 circuitId,
        bytes32 netlistHash,
        bytes input,
        TapeOutEval.Status status,
        bytes output
    );

    event PaymentAllowed(uint256 indexed decisionId, Action indexed action, address indexed to, uint256 amount);
    event PaymentBlocked(
        uint256 indexed decisionId, Action indexed action, address indexed to, uint256 amount, Reason reason
    );

    event DailySpendReset(uint32 indexed day);
    event TrialLimitSet(uint256 previousLimit, uint256 newLimit, address indexed by);
    event CoolingOffHoursSet(uint256 previousHours, uint256 newHours, address indexed by);
    event PayeeSet(address indexed payee, bool saved, uint64 firstSeen, address indexed by);
    event PayeeRemoved(address indexed payee, address indexed by);
    event ConfirmationThresholdSet(uint256 previousThreshold, uint256 newThreshold, address indexed by);
    event PaymentConfirmed(bytes32 indexed paymentHash, uint64 expiresAt, address indexed by);
    event ConfirmationRevoked(bytes32 indexed paymentHash, address indexed by);
    /// @notice Emitted after `PaymentAllowed` when the transfer used a confirmation.
    event ConfirmationConsumed(
        uint256 indexed decisionId, bytes32 indexed paymentHash, address indexed to, uint256 amount, uint256 nonce
    );
    event FrozenSet(bool frozen, address indexed by);
    event EvalGasLimitSet(uint256 previousLimit, uint256 newLimit, address indexed by);
    event DailyCapSet(uint256 previousCap, uint256 newCap, address indexed by);
    event AgentSet(address indexed agent, address indexed by);
    event CircuitAttached(
        uint256 indexed index,
        CircuitKind kind,
        address indexed processor,
        uint256 indexed circuitId,
        bytes32 netlistHash
    );
    event CircuitDetached(
        uint256 indexed index, CircuitKind kind, address indexed processor, uint256 indexed circuitId
    );

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error NotController();
    error NotProposer();
    error ZeroAmount();
    error MemoTooLong();
    error ValueOutOfRange(uint256 value, uint256 max);
    error TooManyCircuits();
    error UnsupportedCircuitKind(CircuitKind kind);
    error DuplicateCircuitKind(CircuitKind kind);
    error NotAProcessor(address processor);
    error PinoutMismatch(uint32 nIn, uint32 nOut, uint32 nState);
    error IndexOutOfRange();
    error ZeroHash();
    error FreezeCircuitNotAttached();
    /// @notice Circuit `index` ran out of gas with less than `evalGasLimit` available. Retry with more gas.
    error InsufficientGas(uint256 index);

    // ---------------------------------------------------------------- construction

    constructor(IERC20 token_, IERC721 controllerNft_, uint256 controllerTokenId_, ITapeOutFactory tapeoutFactory_) {
        if (address(token_) == address(0) || address(controllerNft_) == address(0)) revert ZeroAddress();
        token = token_;
        controllerNft = controllerNft_;
        controllerTokenId = controllerTokenId_;
        tapeoutFactory = tapeoutFactory_;
        // The controller token must exist now; this reverts otherwise.
        controllerNft_.ownerOf(controllerTokenId_);
        lastResetDay = _today();
    }

    // ---------------------------------------------------------------- access

    /// @notice Current controller: the owner of the controller NFT.
    function controller() public view returns (address) {
        return controllerNft.ownerOf(controllerTokenId);
    }

    /// @notice True while `account` is the agent set by the current controller.
    function isActiveAgent(address account) public view returns (bool) {
        return account != address(0) && account == agent && agentSetBy == controller();
    }

    modifier onlyController() {
        if (msg.sender != controller()) revert NotController();
        _;
    }

    // ---------------------------------------------------------------- outbound transfers

    /// @notice Propose a payment. Callable by the controller or the active agent. Returns normally whether
    ///         the payment is allowed or blocked; inspect the return values or the `Decision` event.
    function proposePayment(address to, uint256 amount, string calldata memo)
        external
        nonReentrant
        returns (uint256 decisionId, bool allowed)
    {
        if (msg.sender != controller() && !isActiveAgent(msg.sender)) revert NotProposer();
        return _execute(Action.PAYMENT, to, amount, memo);
    }

    /// @notice Owner withdrawal. Not a bypass: it is evaluated by the same circuits and counts toward the
    ///         daily total when allowed.
    function withdraw(address to, uint256 amount)
        external
        nonReentrant
        onlyController
        returns (uint256 decisionId, bool allowed)
    {
        return _execute(Action.WITHDRAWAL, to, amount, "");
    }

    function _execute(Action action, address to, uint256 amount, string memory memo)
        internal
        returns (uint256 decisionId, bool allowed)
    {
        // Malformed requests are rejected before a decision exists; nothing is recorded or moved.
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (bytes(memo).length > MAX_MEMO_BYTES) revert MemoTooLong();

        decisionId = ++decisionCount;

        // Daily reset (UTC). Applies before inputs are built, whatever the outcome.
        uint32 day = _today();
        if (day != lastResetDay) {
            lastResetDay = day;
            spentToday = 0;
            emit DailySpendReset(day);
        }
        uint256 spentBefore = spentToday;
        Context memory ctx = Context(to, amount, spentBefore, false);
        bytes32 confirmHash;

        // Evaluate every attached circuit (all of them, for a complete public record).
        uint256 n = _circuits.length;
        EvalResult[] memory results = new EvalResult[](n);
        Reason reason = n == 0 ? Reason.NO_CIRCUITS : Reason.NONE;
        for (uint256 i; i < n; ++i) {
            AttachedCircuit memory c = _circuits[i];
            if (c.kind == CircuitKind.CONFIRMATION) (confirmHash, ctx.confirmed) = _confirmationFor(to, amount);
            results[i] = _evaluate(c, ctx, i);
            reason = _worse(reason, results[i].status);
            emit CircuitEvaluated(
                decisionId,
                i,
                c.kind,
                c.processor,
                c.circuitId,
                c.netlistHash,
                results[i].input,
                results[i].status,
                results[i].output
            );
        }

        if (reason == Reason.NONE && token.balanceOf(address(this)) < amount) reason = Reason.INSUFFICIENT_BALANCE;
        if (reason == Reason.NONE && !_tryTransfer(to, amount)) reason = Reason.TRANSFER_FAILED;

        allowed = reason == Reason.NONE;
        uint256 spentAfter = spentBefore;
        if (allowed) {
            // Only after the transfer succeeded. uint256 cannot realistically overflow (bounded by token supply),
            // and checked arithmetic reverts the whole transfer if it ever did.
            spentAfter = spentBefore + amount;
            spentToday = spentAfter;
        }

        bytes32 recordHash =
            _recordHash(decisionId, action, msg.sender, to, amount, day, spentBefore, allowed, reason, memo, results);
        decisionRecordHash[decisionId] = recordHash;

        emit Decision(
            decisionId, action, allowed, msg.sender, to, amount, day, spentBefore, spentAfter, reason, memo, recordHash
        );
        if (allowed) emit PaymentAllowed(decisionId, action, to, amount);
        else emit PaymentBlocked(decisionId, action, to, amount, reason);

        // A confirmation is consumed only by the transfer it enabled, after that transfer succeeded. A blocked
        // attempt leaves it in place until it expires, so the same exact payment can be retried; it can still
        // execute at most once, because consuming it bumps the recipient's nonce.
        if (allowed && ctx.confirmed) {
            uint256 nonce = paymentNonce[to];
            delete confirmations[confirmHash];
            paymentNonce[to] = nonce + 1;
            emit ConfirmationConsumed(decisionId, confirmHash, to, amount, nonce);
        }
    }

    /// @dev Builds the inputs for one circuit from current on-chain state and evaluates it. Reverts only with
    ///      `InsufficientGas` (see `evalGasLimit`); every other failure is returned as a status.
    function _evaluate(AttachedCircuit memory c, Context memory ctx, uint256 index)
        internal
        view
        returns (EvalResult memory r)
    {
        bool ok;
        if (c.kind == CircuitKind.DAILY_CAP) {
            (ok, r.input) = DailyCapPacking.pack(ctx.amount, ctx.spentBefore, dailyCap);
        } else if (c.kind == CircuitKind.WHITELIST) {
            Payee memory p = payees[ctx.to];
            (ok, r.input) = PayeeWhitelistPacking.pack(p.saved, _ageHours(p), ctx.amount, trialLimit, coolingOffHours);
        } else if (c.kind == CircuitKind.CONFIRMATION) {
            (ok, r.input) = ConfirmationPacking.pack(ctx.amount, confirmationThreshold, ctx.confirmed);
        } else if (c.kind == CircuitKind.FREEZE) {
            (ok, r.input) = FreezePacking.pack(frozen);
        }
        if (!ok) {
            r.status = TapeOutEval.Status.NOT_EVALUATED;
            return r;
        }
        // Forward the full budget when the caller left enough gas; otherwise everything except the reserve.
        // (Below ~16M gas, 63/64 of gasleft() is always more than gasleft() - GAS_RESERVE, so the callee really
        // receives `limit`; above that, `limit` is the budget, which is far below 63/64 of gasleft().)
        uint256 budget = evalGasLimit;
        uint256 g = gasleft();
        uint256 limit = g > GAS_RESERVE ? g - GAS_RESERVE : 0;
        bool callerLimited = limit < budget;
        if (!callerLimited) limit = budget;
        bool exhausted;
        (r.status, r.output, exhausted) = TapeOutEval.evalFirstBit(c.processor, c.circuitId, r.input, 1, limit);
        // Out of gas with less than the budget: the caller's fault, not the circuit's. Revert so nothing is recorded
        // and gas estimation keeps searching upward. A circuit that exhausts its full budget is recorded as REVERTED.
        if (exhausted && callerLimited) revert InsufficientGas(index);
    }

    /// @dev Whole hours since the payee was first added; 0 for an unknown payee (treated as first seen now).
    ///      Saturates at 65535 (about 7.5 years): the circuit only checks `age_hours >= cooling_off_hours` with
    ///      `cooling_off_hours <= 65535`, so a saturated age gives exactly the same result as the true age.
    function _ageHours(Payee memory p) internal view returns (uint256 age) {
        if (p.firstSeen == 0) return 0;
        age = (block.timestamp - p.firstSeen) / SECONDS_PER_HOUR;
        if (age > type(uint16).max) age = type(uint16).max;
    }

    /// @dev The confirmation for (to, amount, current nonce), if one exists, has not expired, and was given by the
    ///      current controller. A confirmation given by a previous NFT owner does not count.
    function _confirmationFor(address to, uint256 amount) internal view returns (bytes32 h, bool confirmed) {
        h = hashPayment(to, amount, paymentNonce[to]);
        Confirmation memory cf = confirmations[h];
        confirmed = cf.expiresAt != 0 && block.timestamp <= cf.expiresAt && cf.confirmedBy == controller();
    }

    /// @dev Keeps the first non-allow reason in a fixed priority so the summary is deterministic.
    function _worse(Reason current, TapeOutEval.Status s) internal pure returns (Reason) {
        Reason r;
        if (s == TapeOutEval.Status.ALLOW) return current;
        if (s == TapeOutEval.Status.DENY) r = Reason.CIRCUIT_DENIED;
        else if (s == TapeOutEval.Status.NOT_EVALUATED) r = Reason.INPUT_OUT_OF_RANGE;
        else r = Reason.EVAL_FAILED;
        // Priority: INPUT_OUT_OF_RANGE > EVAL_FAILED > CIRCUIT_DENIED (larger enum values are not used here).
        if (current == Reason.NONE) return r;
        if (current == Reason.INPUT_OUT_OF_RANGE || r == Reason.INPUT_OUT_OF_RANGE) return Reason.INPUT_OUT_OF_RANGE;
        if (current == Reason.EVAL_FAILED || r == Reason.EVAL_FAILED) return Reason.EVAL_FAILED;
        return Reason.CIRCUIT_DENIED;
    }

    /// @dev ERC-20 transfer that reports failure instead of reverting (supports tokens without a return value).
    function _tryTransfer(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return address(token).code.length > 0;
        return ret.length >= 32 && abi.decode(ret, (bool));
    }

    /// @notice recordHash = keccak256(abi.encode(
    ///           escrow, chainId, decisionId, action, proposer, to, amount, day, spentTodayBefore,
    ///           allowed, reason, keccak256(bytes(memo)), circuitsHash))
    ///         circuitsHash starts at bytes32(0) and, for each circuit in index order, becomes
    ///           keccak256(abi.encode(circuitsHash, kind, processor, circuitId, netlistHash,
    ///                                keccak256(input), status, keccak256(output)))
    function _recordHash(
        uint256 decisionId,
        Action action,
        address proposer,
        address to,
        uint256 amount,
        uint32 day,
        uint256 spentBefore,
        bool allowed,
        Reason reason,
        string memory memo,
        EvalResult[] memory results
    ) internal view returns (bytes32) {
        bytes32 circuitsHash;
        for (uint256 i; i < results.length; ++i) {
            AttachedCircuit storage c = _circuits[i];
            circuitsHash = keccak256(
                abi.encode(
                    circuitsHash,
                    c.kind,
                    c.processor,
                    c.circuitId,
                    c.netlistHash,
                    keccak256(results[i].input),
                    results[i].status,
                    keccak256(results[i].output)
                )
            );
        }
        return keccak256(
            abi.encode(
                address(this),
                block.chainid,
                decisionId,
                action,
                proposer,
                to,
                amount,
                day,
                spentBefore,
                allowed,
                reason,
                keccak256(bytes(memo)),
                circuitsHash
            )
        );
    }

    // ---------------------------------------------------------------- management (controller only)

    function setDailyCap(uint256 newCap) external onlyController {
        if (newCap > type(uint32).max) revert ValueOutOfRange(newCap, type(uint32).max);
        emit DailyCapSet(dailyCap, newCap, msg.sender);
        dailyCap = newCap;
    }

    /// @notice Largest payment to a payee that is not saved (token base units, <= 4294967295).
    function setTrialLimit(uint256 newLimit) external onlyController {
        if (newLimit > type(uint32).max) revert ValueOutOfRange(newLimit, type(uint32).max);
        emit TrialLimitSet(trialLimit, newLimit, msg.sender);
        trialLimit = newLimit;
    }

    /// @notice Hours a payee that is not saved must have been known before it can be paid (<= 65535).
    function setCoolingOffHours(uint256 newHours) external onlyController {
        if (newHours > type(uint16).max) revert ValueOutOfRange(newHours, type(uint16).max);
        emit CoolingOffHoursSet(coolingOffHours, newHours, msg.sender);
        coolingOffHours = newHours;
    }

    /// @notice Add a payee or change its saved flag. The first call records `firstSeen = block.timestamp`; later
    ///         calls keep it, so marking a payee saved or unsaved does not restart its cooling-off.
    function setPayee(address payee, bool saved) external onlyController {
        if (payee == address(0)) revert ZeroAddress();
        Payee storage p = payees[payee];
        if (p.firstSeen == 0) p.firstSeen = uint64(block.timestamp);
        p.saved = saved;
        emit PayeeSet(payee, saved, p.firstSeen, msg.sender);
    }

    /// @notice Forget a payee. Adding it again starts a new cooling-off period.
    function removePayee(address payee) external onlyController {
        delete payees[payee];
        emit PayeeRemoved(payee, msg.sender);
    }

    /// @notice Payments above this amount (token base units, <= 4294967295) need `confirmPayment`.
    function setConfirmationThreshold(uint256 newThreshold) external onlyController {
        if (newThreshold > type(uint32).max) revert ValueOutOfRange(newThreshold, type(uint32).max);
        emit ConfirmationThresholdSet(confirmationThreshold, newThreshold, msg.sender);
        confirmationThreshold = newThreshold;
    }

    /// @notice Confirm one exact payment: `paymentHash` must equal `hashPayment(to, amount, paymentNonce(to))`
    ///         (see `currentPaymentHash`). The confirmation is usable until `block.timestamp + CONFIRMATION_TTL`,
    ///         only while the caller still owns the controller NFT, and is consumed by the transfer it enables.
    ///         Confirming the same hash again refreshes the expiry.
    function confirmPayment(bytes32 paymentHash) external onlyController {
        if (paymentHash == bytes32(0)) revert ZeroHash();
        uint64 expiresAt = uint64(block.timestamp + CONFIRMATION_TTL);
        confirmations[paymentHash] = Confirmation(expiresAt, msg.sender);
        emit PaymentConfirmed(paymentHash, expiresAt, msg.sender);
    }

    function revokeConfirmation(bytes32 paymentHash) external onlyController {
        delete confirmations[paymentHash];
        emit ConfirmationRevoked(paymentHash, msg.sender);
    }

    /// @notice Set the freeze flag read by the Freeze circuit. Freezing requires an attached Freeze circuit, because
    ///         the flag has no effect without one (circuits are the only authority).
    function setFrozen(bool newFrozen) external onlyController {
        if (newFrozen && !_hasKind(CircuitKind.FREEZE)) revert FreezeCircuitNotAttached();
        frozen = newFrozen;
        emit FrozenSet(newFrozen, msg.sender);
    }

    /// @notice Gas budget per circuit eval (100k..30M). Raise it if a TapeOut upgrade makes evals more expensive and
    ///         circuits start being recorded as REVERTED with plenty of gas supplied.
    function setEvalGasLimit(uint256 newLimit) external onlyController {
        if (newLimit < MIN_EVAL_GAS_LIMIT || newLimit > MAX_EVAL_GAS_LIMIT) {
            revert ValueOutOfRange(newLimit, MAX_EVAL_GAS_LIMIT);
        }
        emit EvalGasLimitSet(evalGasLimit, newLimit, msg.sender);
        evalGasLimit = newLimit;
    }

    /// @notice Set (or clear with address(0)) the agent key. The agent can only propose payments.
    function setAgent(address newAgent) external onlyController {
        agent = newAgent;
        agentSetBy = msg.sender;
        emit AgentSet(newAgent, msg.sender);
    }

    function attachCircuit(CircuitKind kind, address processor, uint256 circuitId)
        external
        onlyController
        returns (uint256 index)
    {
        uint32 expectedNIn = _expectedNIn(kind);
        if (_circuits.length >= MAX_CIRCUITS) revert TooManyCircuits();
        if (_hasKind(kind)) revert DuplicateCircuitKind(kind);
        if (processor.code.length == 0) revert NotAProcessor(processor);
        if (address(tapeoutFactory) != address(0) && !tapeoutFactory.isCPU(processor)) revert NotAProcessor(processor);

        (uint32 nIn, uint32 nOut, uint32 nState,) = ITapeOutCircuits(processor).circuitInfo(circuitId);
        if (nIn != expectedNIn || nOut != 1 || nState != 0) {
            revert PinoutMismatch(nIn, nOut, nState);
        }
        bytes32 netlistHash = keccak256(ITapeOutCircuits(processor).netlist(circuitId));

        index = _circuits.length;
        _circuits.push(AttachedCircuit(kind, processor, circuitId, netlistHash));
        emit CircuitAttached(index, kind, processor, circuitId, netlistHash);
    }

    /// @notice Detach the circuit at `index`. The last circuit moves into its slot.
    function detachCircuit(uint256 index) external onlyController {
        uint256 n = _circuits.length;
        if (index >= n) revert IndexOutOfRange();
        AttachedCircuit memory c = _circuits[index];
        if (index != n - 1) _circuits[index] = _circuits[n - 1];
        _circuits.pop();
        emit CircuitDetached(index, c.kind, c.processor, c.circuitId);
    }

    /// @dev Pinout (input count) per kind, from the packing libraries. Every circuit has nOut = 1 and nState = 0.
    function _expectedNIn(CircuitKind kind) internal pure returns (uint32) {
        if (kind == CircuitKind.DAILY_CAP) return DailyCapPacking.N_IN;
        if (kind == CircuitKind.WHITELIST) return PayeeWhitelistPacking.N_IN;
        if (kind == CircuitKind.CONFIRMATION) return ConfirmationPacking.N_IN;
        if (kind == CircuitKind.FREEZE) return FreezePacking.N_IN;
        revert UnsupportedCircuitKind(kind);
    }

    function _hasKind(CircuitKind kind) internal view returns (bool) {
        for (uint256 i; i < _circuits.length; ++i) {
            if (_circuits[i].kind == kind) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- views

    /// @notice keccak256(abi.encode(PAYMENT_TYPEHASH, chainid, escrow, to, amount, nonce)).
    function hashPayment(address to, uint256 amount, uint256 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(PAYMENT_TYPEHASH, block.chainid, address(this), to, amount, nonce));
    }

    /// @notice The hash the controller must confirm for the next payment of `amount` to `to`.
    function currentPaymentHash(address to, uint256 amount) external view returns (bytes32) {
        return hashPayment(to, amount, paymentNonce[to]);
    }

    /// @notice Whether the next payment of `amount` to `to` would be packed with confirmed = 1.
    function isPaymentConfirmed(address to, uint256 amount) external view returns (bool confirmed) {
        (, confirmed) = _confirmationFor(to, amount);
    }

    /// @notice The age_hours value the Payee Whitelist circuit would receive for `payee` now.
    function payeeAgeHours(address payee) external view returns (uint256) {
        return _ageHours(payees[payee]);
    }

    function circuitCount() external view returns (uint256) {
        return _circuits.length;
    }

    function circuitAt(uint256 index) external view returns (AttachedCircuit memory) {
        if (index >= _circuits.length) revert IndexOutOfRange();
        return _circuits[index];
    }

    function circuits() external view returns (AttachedCircuit[] memory) {
        return _circuits;
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Daily spending as it would be seen by the next proposal (zero after a UTC day change).
    function currentSpentToday() external view returns (uint256) {
        return _today() == lastResetDay ? spentToday : 0;
    }

    function today() external view returns (uint32) {
        return _today();
    }

    function _today() internal view returns (uint32) {
        // uint32 day numbers last until the year 11,700,000+; the cast cannot truncate in practice.
        return uint32(block.timestamp / SECONDS_PER_DAY);
    }
}
