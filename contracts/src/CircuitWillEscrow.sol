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
import {CustomFactsPacking} from "./libraries/CustomFactsPacking.sol";
import {SpendWindows} from "./libraries/SpendWindows.sol";

/// @title CircuitWillEscrow
/// @notice Holds one ERC-20 (USDT0 on X Layer) and releases it only when every attached TapeOut circuit
///         returns allow. Control follows a controller NFT that stays in its owner's wallet.
/// @dev Circuits: the four official kinds (Daily Cap, Payee Whitelist + Cooling-off, Confirmation Threshold, Freeze),
///      each attached at most once, plus up to `MAX_CUSTOM_RULES` custom rules. A custom rule is any NAND circuit with
///      the fixed 256-pin facts layout of `CustomFactsPacking`, pinned at attach time by its netlist hash and the hash
///      of the rule specification it was compiled from.
///
///      Parameter-change timing: every parameter is read when `proposePayment` / `withdraw` executes (no snapshot at
///      proposal time). Changes that can only let less money move apply at once. Changes that can let more money move
///      ("loosening": a higher cap or limit, a shorter cooling-off, saving a payee, unfreezing, detaching a circuit,
///      setting a beneficiary, shortening the delay) revert with `LooseningIsDelayed` and must go through
///      `queueChange` -> wait `ruleDelay` -> `applyChange`. While no circuit is attached every transfer is already
///      blocked (`NO_CIRCUITS`), so all setters apply at once ("setup"). Every change emits an event.
///
///      Invariants:
///      - Every outbound token transfer, including the owner's `withdraw`, goes through `_execute`.
///      - A payment is allowed only if every attached circuit returns allow (AND). Attaching a circuit can therefore
///        only block more, which is why attaching is never delayed.
///      - A blocked decision is recorded (storage + events) and the call returns normally. After the decision id has
///        been assigned, the only revert is `InsufficientGas`: the caller did not leave an eval its full
///        `evalGasLimit` budget and that eval ran out of gas. The whole call then reverts like any out-of-gas
///        transaction (nothing is recorded or moved), so `eth_estimateGas` finds a limit that is enough.
///      - Any evaluation problem (revert, a circuit using its whole gas budget, missing code, malformed output,
///        unpackable input, a circuit marked tampered, no circuits attached) blocks the transfer and is recorded.
contract CircuitWillEscrow is ReentrancyGuard {
    // ---------------------------------------------------------------- types

    /// @dev Values are part of the public event format. Append only, never reorder.
    enum CircuitKind {
        NONE,
        DAILY_CAP,
        WHITELIST,
        CONFIRMATION,
        FREEZE,
        CUSTOM
    }

    enum Action {
        PAYMENT,
        WITHDRAWAL
    }

    /// @dev Values are part of the public event format. Append only, never reorder.
    enum Reason {
        NONE, // allowed
        CIRCUIT_DENIED, // at least one circuit returned 0
        EVAL_FAILED, // at least one circuit reverted, ran out of gas, returned malformed output, or is tampered
        INPUT_OUT_OF_RANGE, // a value did not fit its pin width, so no circuit input could be built
        NO_CIRCUITS, // no circuits attached: nothing can authorize a transfer
        INSUFFICIENT_BALANCE, // circuits allowed, but the escrow does not hold enough tokens
        TRANSFER_FAILED, // circuits allowed, but the token transfer failed
        NO_CUSTOM_RULE // the beneficiary proposed, but no custom rule is attached to say what it may do
    }

    /// @dev Values are part of the public event format. Append only, never reorder.
    enum ChangeKind {
        DAILY_CAP,
        TRIAL_LIMIT,
        COOLING_OFF_HOURS,
        CONFIRMATION_THRESHOLD,
        SAVE_PAYEE,
        UNFREEZE,
        DETACH_CIRCUIT,
        RULE_DELAY,
        BENEFICIARY
    }

    struct AttachedCircuit {
        CircuitKind kind;
        address processor; // TapeOut circuits contract
        uint256 circuitId;
        bytes32 netlistHash; // keccak256(processor.netlist(circuitId)) at attach time
        uint64 uid; // stable id; indexes move when a circuit is detached
        bool tampered; // set by `checkCircuit` when the netlist no longer matches; the circuit then always fails
    }

    /// @notice A payee entry. `firstSeen` is set when the controller first adds the payee and is kept while the
    ///         entry exists; `saved` marks it as trusted (the whitelist circuit then allows it without limits).
    ///         `paidBefore` is set by the first allowed transfer to it and cleared with the entry.
    struct Payee {
        uint64 firstSeen;
        bool saved;
        bool paidBefore;
    }

    /// @notice A controller confirmation of one exact payment hash (see `hashPayment`).
    struct Confirmation {
        uint64 expiresAt; // valid while block.timestamp <= expiresAt
        address confirmedBy; // must still own the controller NFT when the payment executes
    }

    /// @notice A loosening change waiting for `ruleDelay`. `value` is the new value; for DETACH_CIRCUIT it is the
    ///         circuit uid, for RULE_DELAY the new delay in seconds. `target` is the payee (SAVE_PAYEE) or the new
    ///         beneficiary (BENEFICIARY), else zero.
    struct PendingChange {
        ChangeKind kind;
        uint64 eta; // earliest apply time; zero means no such change
        address target;
        address queuedBy; // must still be the controller when the change is applied
        uint256 value;
    }

    /// @dev Values read from on-chain state once per decision and packed into the circuit inputs.
    struct Context {
        address to;
        uint256 amount;
        uint256 spentBefore;
        bool confirmed;
        bytes32 confirmHash;
        bool customOk;
        bytes customInput;
    }

    struct EvalResult {
        TapeOutEval.Status status;
        bytes input;
        bytes output;
    }

    // ---------------------------------------------------------------- constants

    /// @notice Four official kinds (one each) plus `MAX_CUSTOM_RULES` custom rules.
    uint256 public constant MAX_CIRCUITS = 7;
    uint256 public constant MAX_CUSTOM_RULES = 3;
    /// @notice Largest custom rule. At ~95.6k + 2,250 gas per NAND (measured on a mainnet fork, 2026-11-23) a
    ///         1,000-gate rule uses ~2.35M gas, 78% of the default `evalGasLimit`.
    uint32 public constant MAX_CUSTOM_GATES = 1_000;
    /// @notice Longest English description stored with a custom rule (bytes of UTF-8).
    uint256 public constant MAX_RULE_TEXT_BYTES = 280;
    uint32 public constant CUSTOM_FACTS_VERSION = CustomFactsPacking.FACTS_VERSION;
    /// @notice Token base units per cent in the custom-rule facts (USDT0 has 6 decimals).
    uint256 public constant UNITS_PER_CENT = 10_000;

    uint256 public constant MAX_MEMO_BYTES = 256;
    uint256 public constant SECONDS_PER_DAY = 86_400;
    uint256 public constant SECONDS_PER_HOUR = 3_600;

    /// @notice How long a `confirmPayment` stays usable.
    uint256 public constant CONFIRMATION_TTL = 1 hours;

    /// @notice Delay before a loosening change can be applied, and how long it stays applicable after that.
    uint256 public constant DEFAULT_RULE_DELAY = 24 hours;
    uint256 public constant MIN_RULE_DELAY = 1 hours;
    uint256 public constant MAX_RULE_DELAY = 30 days;
    uint256 public constant APPLY_WINDOW = 7 days;

    /// @notice Domain tag of `hashPayment`.
    bytes32 public constant PAYMENT_TYPEHASH =
        keccak256("CircuitWill.Payment(uint256 chainId,address escrow,address to,uint256 amount,uint256 nonce)");

    /// @dev Gas kept back from every eval call so the decision can always be recorded and the transfer made.
    uint256 public constant GAS_RESERVE = 250_000;

    /// @notice Default and allowed range of `evalGasLimit`. The default is about 2.8x the measured cost of the
    ///         largest official circuit (Daily Cap, ~1.07M gas on TapeOut). X Layer's block gas limit was 210M on
    ///         2026-11-20, so seven circuits at the maximum budget still fit in a block.
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
    uint64 internal _lastUid;
    /// @notice Number of attached custom rules.
    uint256 public customRuleCount;
    /// @notice Hash of the canonical rule specification a custom rule was compiled from, by circuit uid.
    mapping(uint64 uid => bytes32) public customSpecHash;

    /// @notice Daily Cap parameter in token base units (<= type(uint32).max).
    uint256 public dailyCap;
    /// @notice Sum of allowed outbound transfers during `lastResetDay` (UTC).
    uint256 public spentToday;
    /// @notice UTC day number, `block.timestamp / 86400`, of the last reset.
    uint32 public lastResetDay;
    /// @notice Allowed outbound transfers during `lastResetDay`, saturating at 255.
    uint8 public paymentsToday;
    /// @notice Calendar month (`year * 12 + month - 1`, UTC) that `spentMonthCents` belongs to.
    uint32 public monthKey;
    /// @notice Allowed outbound transfers during `monthKey`, in cents (each transfer rounded up), saturating.
    uint32 public spentMonthCents;
    /// @notice Rolling 7-day spend ring, see `SpendWindows`.
    uint256 public spendRing;

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

    /// @notice Beneficiary that may call `proposePayment` (for example under an inheritance rule). Active only while
    ///         `beneficiarySetBy` still owns the controller NFT, and only allowed while a custom rule is attached.
    address public beneficiary;
    address public beneficiarySetBy;
    /// @notice Last `checkIn` by the controller (deployment time until the first one).
    uint64 public lastCheckIn;

    uint256 public ruleDelay = DEFAULT_RULE_DELAY;
    uint256 public changeCount;
    mapping(uint256 changeId => PendingChange) public pendingChanges;

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
    event BeneficiarySet(address indexed beneficiary, address indexed by);
    event CheckedIn(uint64 at, address indexed by);
    event RuleDelaySet(uint256 previousDelay, uint256 newDelay, address indexed by);
    event CircuitAttached(
        uint256 indexed index,
        CircuitKind kind,
        address indexed processor,
        uint256 indexed circuitId,
        bytes32 netlistHash,
        uint64 uid
    );
    /// @notice Emitted after `CircuitAttached` for a custom rule. `text` is the owner-facing English description the
    ///         rule was confirmed with; `specHash` commits to the canonical rule specification and compiler version.
    event CustomRuleAttached(
        uint64 indexed uid, bytes32 netlistHash, bytes32 specHash, uint32 factsVersion, string text
    );
    event CircuitDetached(
        uint256 indexed index, CircuitKind kind, address indexed processor, uint256 indexed circuitId, uint64 uid
    );
    event CircuitTampered(uint64 indexed uid, bytes32 expectedHash, bytes32 actualHash, address indexed by);
    event ChangeQueued(
        uint256 indexed changeId, ChangeKind kind, address target, uint256 value, uint64 eta, address indexed by
    );
    event ChangeApplied(uint256 indexed changeId, address indexed by);
    event ChangeCancelled(uint256 indexed changeId, address indexed by);

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error NotController();
    error NotProposer();
    error ZeroAmount();
    error MemoTooLong();
    error ValueOutOfRange(uint256 value, uint256 max);
    error TooManyCircuits();
    error TooManyCustomRules();
    error UnsupportedCircuitKind(CircuitKind kind);
    error DuplicateCircuitKind(CircuitKind kind);
    error NotAProcessor(address processor);
    error PinoutMismatch(uint32 nIn, uint32 nOut, uint32 nState);
    error TooManyGates(uint32 gateCount, uint32 max);
    error NetlistHashMismatch(bytes32 expected, bytes32 actual);
    error RuleTextTooLong();
    error IndexOutOfRange();
    error UnknownCircuit(uint64 uid);
    error ZeroHash();
    error FreezeCircuitNotAttached();
    error LooseningIsDelayed();
    error UnknownChange(uint256 changeId);
    error ChangeNotReady(uint64 eta);
    error ChangeExpired(uint64 eta);
    error QueuedByPreviousController();
    error ChangeTargetGone();
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
        lastCheckIn = uint64(block.timestamp);
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

    /// @notice True while `account` is the beneficiary set by the current controller.
    function isActiveBeneficiary(address account) public view returns (bool) {
        return account != address(0) && account == beneficiary && beneficiarySetBy == controller();
    }

    /// @notice Caller role as packed into custom-rule facts: 0 controller, 1 agent, 2 beneficiary, 3 none.
    ///         If one address holds several roles, the first in this order wins.
    function roleOf(address account) public view returns (uint8) {
        if (account == controller()) return 0;
        if (isActiveAgent(account)) return 1;
        if (isActiveBeneficiary(account)) return 2;
        return 3;
    }

    modifier onlyController() {
        if (msg.sender != controller()) revert NotController();
        _;
    }

    // ---------------------------------------------------------------- outbound transfers

    /// @notice Propose a payment. Callable by the controller, the active agent or the active beneficiary. Returns
    ///         normally whether the payment is allowed or blocked; inspect the return values or the `Decision` event.
    function proposePayment(address to, uint256 amount, string calldata memo)
        external
        nonReentrant
        returns (uint256 decisionId, bool allowed)
    {
        if (roleOf(msg.sender) == 3) revert NotProposer();
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
            paymentsToday = 0;
            emit DailySpendReset(day);
        }
        uint256 spentBefore = spentToday;
        Context memory ctx;
        ctx.to = to;
        ctx.amount = amount;
        ctx.spentBefore = spentBefore;
        if (_needsConfirmation()) (ctx.confirmHash, ctx.confirmed) = _confirmationFor(to, amount);
        if (customRuleCount != 0) {
            (ctx.customOk, ctx.customInput) = _customInput(action, msg.sender, to, amount, ctx.confirmed);
        }

        (EvalResult[] memory results, Reason reason) = _evaluateAll(decisionId, ctx);

        // A beneficiary has no default powers: some custom rule must be attached to say what it may do.
        if (reason == Reason.NONE && customRuleCount == 0 && roleOf(msg.sender) == 2) reason = Reason.NO_CUSTOM_RULE;
        if (reason == Reason.NONE && token.balanceOf(address(this)) < amount) reason = Reason.INSUFFICIENT_BALANCE;
        if (reason == Reason.NONE && !_tryTransfer(to, amount)) reason = Reason.TRANSFER_FAILED;

        allowed = reason == Reason.NONE;
        uint256 spentAfter = spentBefore;
        if (allowed) {
            // Only after the transfer succeeded. uint256 cannot realistically overflow (bounded by token supply),
            // and checked arithmetic reverts the whole transfer if it ever did.
            spentAfter = spentBefore + amount;
            spentToday = spentAfter;
            _recordSpend(day, to, amount);
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
            delete confirmations[ctx.confirmHash];
            paymentNonce[to] = nonce + 1;
            emit ConfirmationConsumed(decisionId, ctx.confirmHash, to, amount, nonce);
        }
    }

    /// @dev Evaluates every attached circuit (all of them, for a complete public record) and combines the statuses.
    function _evaluateAll(uint256 decisionId, Context memory ctx)
        internal
        returns (EvalResult[] memory results, Reason reason)
    {
        uint256 n = _circuits.length;
        results = new EvalResult[](n);
        reason = n == 0 ? Reason.NO_CIRCUITS : Reason.NONE;
        for (uint256 i; i < n; ++i) {
            AttachedCircuit memory c = _circuits[i];
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
    }

    /// @dev Updates the counters behind the custom-rule facts after an allowed transfer. The daily reset has already
    ///      run for `day`.
    function _recordSpend(uint32 day, address to, uint256 amount) internal {
        uint256 cents = _sat32(_ceilCents(amount));
        if (paymentsToday != type(uint8).max) paymentsToday += 1;
        uint32 mk = SpendWindows.monthKey(day);
        uint256 month = (mk == monthKey ? uint256(spentMonthCents) : 0) + cents;
        monthKey = mk;
        spentMonthCents = uint32(_sat32(month));
        spendRing = SpendWindows.add(SpendWindows.advance(spendRing, day), day, cents);
        Payee storage p = payees[to];
        if (!p.paidBefore) p.paidBefore = true;
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
        } else if (c.kind == CircuitKind.CUSTOM) {
            (ok, r.input) = (ctx.customOk, ctx.customInput);
        }
        if (!ok) {
            r.status = TapeOutEval.Status.NOT_EVALUATED;
            r.input = "";
            return r;
        }
        if (c.tampered) {
            // Never trust a circuit whose netlist changed after it was attached.
            r.status = TapeOutEval.Status.REVERTED;
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

    /// @dev The custom-rule facts for a transfer of `amount` to `to` proposed by `caller` right now, packed as
    ///      `CustomFactsPacking` describes. Pure read: day and month rollovers are applied virtually.
    function _customInput(Action action, address caller, address to, uint256 amount, bool confirmed)
        internal
        view
        returns (bool ok, bytes memory input)
    {
        CustomFactsPacking.Facts memory f;
        f.amountC = _ceilCents(amount);
        uint32 day = _today();
        bool sameDay = day == lastResetDay;
        f.spentDayAfterC = _ceilCents((sameDay ? spentToday : 0) + amount);
        uint256 amountC = _sat32(f.amountC);
        f.spent7dAfterC = SpendWindows.sum(SpendWindows.advance(spendRing, day)) + amountC;
        f.spentMonthAfterC = (SpendWindows.monthKey(day) == monthKey ? uint256(spentMonthCents) : 0) + amountC;
        uint256 bal = token.balanceOf(address(this));
        f.balanceAfterC = bal > amount ? (bal - amount) / UNITS_PER_CENT : 0;
        f.countDayAfter = (sameDay ? uint256(paymentsToday) : 0) + 1;
        f.slotOfWeek = SpendWindows.slotOfWeek(block.timestamp);
        Payee memory p = payees[to];
        f.payeeTrusted = p.saved;
        f.payeeKnown = p.firstSeen != 0;
        f.payeePaidBefore = p.paidBefore;
        f.payeeAgeHours = _ageHours(p);
        f.checkinAgeHours = (block.timestamp - lastCheckIn) / SECONDS_PER_HOUR;
        f.callerRole = roleOf(caller);
        f.confirmed = confirmed;
        f.isWithdrawal = action == Action.WITHDRAWAL;
        return CustomFactsPacking.pack(f);
    }

    /// @dev Whole hours since the payee was first added; 0 for an unknown payee (treated as first seen now).
    ///      Saturates at 65535 (about 7.5 years): circuits only check `age_hours >= K` with K <= 65535, so a
    ///      saturated age gives exactly the same result as the true age.
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

    /// @dev Confirmations are read only when a circuit uses them (Confirmation, or any custom rule).
    function _needsConfirmation() internal view returns (bool) {
        return customRuleCount != 0 || _hasKind(CircuitKind.CONFIRMATION);
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
    //
    // Each setter applies at once when the change can only let less money move (or during setup, while no circuit is
    // attached). A loosening change reverts with `LooseningIsDelayed`; queue it with `queueChange` instead.

    function setDailyCap(uint256 newCap) external onlyController {
        _setDailyCap(newCap, true);
    }

    /// @notice Largest payment to a payee that is not saved (token base units, <= 4294967295).
    function setTrialLimit(uint256 newLimit) external onlyController {
        _setTrialLimit(newLimit, true);
    }

    /// @notice Hours a payee that is not saved must have been known before it can be paid (<= 65535).
    function setCoolingOffHours(uint256 newHours) external onlyController {
        _setCoolingOffHours(newHours, true);
    }

    /// @notice Add a payee or change its saved flag. The first call records `firstSeen = block.timestamp`; later
    ///         calls keep it, so marking a payee saved or unsaved does not restart its cooling-off. Saving a payee
    ///         that is not saved yet is loosening. Adding a new payee unsaved is not: its cooling-off is the delay.
    function setPayee(address payee, bool saved) external onlyController {
        _setPayee(payee, saved, true);
    }

    /// @notice Forget a payee. Adding it again starts a new cooling-off period.
    function removePayee(address payee) external onlyController {
        delete payees[payee];
        emit PayeeRemoved(payee, msg.sender);
    }

    /// @notice Payments above this amount (token base units, <= 4294967295) need `confirmPayment`.
    function setConfirmationThreshold(uint256 newThreshold) external onlyController {
        _setConfirmationThreshold(newThreshold, true);
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
    ///         the flag has no effect without one (circuits are the only authority). Unfreezing is loosening.
    function setFrozen(bool newFrozen) external onlyController {
        _requireNotLoosening(!newFrozen && frozen);
        _setFrozen(newFrozen);
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

    /// @notice Set (or clear with address(0)) the agent key. The agent can only propose payments, which every
    ///         circuit still has to allow, so this is not delayed.
    function setAgent(address newAgent) external onlyController {
        agent = newAgent;
        agentSetBy = msg.sender;
        emit AgentSet(newAgent, msg.sender);
    }

    /// @notice Set the beneficiary, or clear it with address(0). Setting one gives a new party the power to propose
    ///         payments, so it is loosening; clearing applies at once.
    function setBeneficiary(address newBeneficiary) external onlyController {
        _requireNotLoosening(newBeneficiary != address(0));
        _setBeneficiary(newBeneficiary, msg.sender);
    }

    /// @notice Record that the controller is active. Inheritance-style custom rules read the hours since the last
    ///         check-in. Only the controller can check in (never the agent), so a compromised agent cannot keep such a
    ///         rule from ever unlocking.
    function checkIn() external onlyController {
        lastCheckIn = uint64(block.timestamp);
        emit CheckedIn(uint64(block.timestamp), msg.sender);
    }

    /// @notice Set the loosening delay (1 hour .. 30 days). Lengthening applies at once; shortening is loosening
    ///         and waits the current delay.
    function setRuleDelay(uint256 newDelay) external onlyController {
        _setRuleDelay(newDelay, true);
    }

    /// @notice Attach one of the four official circuits. Never delayed: one more circuit can only block more.
    function attachCircuit(CircuitKind kind, address processor, uint256 circuitId)
        external
        onlyController
        returns (uint256 index)
    {
        if (kind == CircuitKind.CUSTOM) revert UnsupportedCircuitKind(kind); // use attachCustomRule
        uint32 expectedNIn = _expectedNIn(kind);
        if (_hasKind(kind)) revert DuplicateCircuitKind(kind);
        (,, bytes32 netlistHash) = _checkProcessor(processor, circuitId, expectedNIn);
        index = _push(kind, processor, circuitId, netlistHash);
    }

    /// @notice Attach a custom rule: a circuit with the 256-pin facts layout (`CustomFactsPacking`) and at most
    ///         `MAX_CUSTOM_GATES` gates. `expectedNetlistHash` must equal keccak256 of the circuit's netlist, so the
    ///         circuit the owner previewed is exactly the one attached. `specHash` commits to the canonical rule
    ///         specification and compiler version it was built from; `text` is the English description shown to the
    ///         owner, stored in the event for every later viewer. Never delayed: it can only block more.
    function attachCustomRule(
        address processor,
        uint256 circuitId,
        bytes32 expectedNetlistHash,
        bytes32 specHash,
        string calldata text
    ) external onlyController returns (uint256 index, uint64 uid) {
        if (customRuleCount >= MAX_CUSTOM_RULES) revert TooManyCustomRules();
        if (specHash == bytes32(0)) revert ZeroHash();
        if (bytes(text).length > MAX_RULE_TEXT_BYTES) revert RuleTextTooLong();
        (uint32 gateCount,, bytes32 netlistHash) = _checkProcessor(processor, circuitId, CustomFactsPacking.N_IN);
        if (gateCount > MAX_CUSTOM_GATES) revert TooManyGates(gateCount, MAX_CUSTOM_GATES);
        if (netlistHash != expectedNetlistHash) revert NetlistHashMismatch(expectedNetlistHash, netlistHash);

        index = _push(CircuitKind.CUSTOM, processor, circuitId, netlistHash);
        uid = _lastUid;
        customRuleCount += 1;
        customSpecHash[uid] = specHash;
        emit CustomRuleAttached(uid, netlistHash, specHash, CustomFactsPacking.FACTS_VERSION, text);
    }

    // ---------------------------------------------------------------- delayed (loosening) changes

    /// @notice Queue a loosening change. It can be applied by the same controller from `block.timestamp + ruleDelay`
    ///         until `APPLY_WINDOW` after that. Values are range-checked now, so a bad change fails at once.
    function queueChange(ChangeKind kind, address target, uint256 value)
        external
        onlyController
        returns (uint256 changeId)
    {
        if (kind == ChangeKind.DAILY_CAP || kind == ChangeKind.TRIAL_LIMIT || kind == ChangeKind.CONFIRMATION_THRESHOLD)
        {
            if (value > type(uint32).max) revert ValueOutOfRange(value, type(uint32).max);
        } else if (kind == ChangeKind.COOLING_OFF_HOURS) {
            if (value > type(uint16).max) revert ValueOutOfRange(value, type(uint16).max);
        } else if (kind == ChangeKind.SAVE_PAYEE) {
            if (target == address(0)) revert ZeroAddress();
        } else if (kind == ChangeKind.DETACH_CIRCUIT) {
            if (value > type(uint64).max) revert UnknownCircuit(0);
            _indexOf(uint64(value)); // reverts UnknownCircuit
        } else if (kind == ChangeKind.RULE_DELAY) {
            _checkRuleDelay(value);
        }
        uint64 eta = uint64(block.timestamp + ruleDelay);
        changeId = ++changeCount;
        pendingChanges[changeId] = PendingChange(kind, eta, target, msg.sender, value);
        emit ChangeQueued(changeId, kind, target, value, eta, msg.sender);
    }

    /// @notice Apply a queued change once its delay has passed. Only the controller that queued it can apply it, so
    ///         every change queued by a previous owner of the NFT dies with the transfer.
    function applyChange(uint256 changeId) external onlyController {
        PendingChange memory pc = pendingChanges[changeId];
        if (pc.eta == 0) revert UnknownChange(changeId);
        if (pc.queuedBy != msg.sender) revert QueuedByPreviousController();
        if (block.timestamp < pc.eta) revert ChangeNotReady(pc.eta);
        if (block.timestamp > uint256(pc.eta) + APPLY_WINDOW) revert ChangeExpired(pc.eta);
        delete pendingChanges[changeId];

        if (pc.kind == ChangeKind.DAILY_CAP) _setDailyCap(pc.value, false);
        else if (pc.kind == ChangeKind.TRIAL_LIMIT) _setTrialLimit(pc.value, false);
        else if (pc.kind == ChangeKind.COOLING_OFF_HOURS) _setCoolingOffHours(pc.value, false);
        else if (pc.kind == ChangeKind.CONFIRMATION_THRESHOLD) _setConfirmationThreshold(pc.value, false);
        else if (pc.kind == ChangeKind.SAVE_PAYEE) _setPayee(pc.target, true, false);
        else if (pc.kind == ChangeKind.UNFREEZE) _setFrozen(false);
        else if (pc.kind == ChangeKind.DETACH_CIRCUIT) _detach(uint64(pc.value));
        else if (pc.kind == ChangeKind.RULE_DELAY) _setRuleDelay(pc.value, false);
        else _setBeneficiary(pc.target, msg.sender);
        emit ChangeApplied(changeId, msg.sender);
    }

    function cancelChange(uint256 changeId) external onlyController {
        if (pendingChanges[changeId].eta == 0) revert UnknownChange(changeId);
        delete pendingChanges[changeId];
        emit ChangeCancelled(changeId, msg.sender);
    }

    // ---------------------------------------------------------------- tamper check (anyone)

    /// @notice Re-hash the netlist of circuit `uid` on its processor. If it no longer matches the hash pinned at
    ///         attach time (for example after a TapeOut upgrade), the circuit is marked tampered and from then on
    ///         counts as failed, blocking every transfer until it is detached. Anyone may call this: it can only
    ///         block more. A netlist read that reverts reverts this call too and marks nothing.
    function checkCircuit(uint64 uid) external returns (bool matches) {
        uint256 i = _indexOf(uid);
        AttachedCircuit storage c = _circuits[i];
        bytes32 actual = keccak256(ITapeOutCircuits(c.processor).netlist(c.circuitId));
        matches = actual == c.netlistHash;
        if (!matches && !c.tampered) {
            c.tampered = true;
            emit CircuitTampered(uid, c.netlistHash, actual, msg.sender);
        }
    }

    // ---------------------------------------------------------------- internal setters

    function _requireNotLoosening(bool loosens) internal view {
        // During setup (no circuit attached) every transfer is blocked, so nothing needs a delay.
        if (loosens && _circuits.length != 0) revert LooseningIsDelayed();
    }

    // `live` = called by a setter (loosening reverts) rather than by applyChange. Ranges are checked first.

    function _setDailyCap(uint256 newCap, bool live) internal {
        if (newCap > type(uint32).max) revert ValueOutOfRange(newCap, type(uint32).max);
        if (live) _requireNotLoosening(newCap > dailyCap);
        emit DailyCapSet(dailyCap, newCap, msg.sender);
        dailyCap = newCap;
    }

    function _setTrialLimit(uint256 newLimit, bool live) internal {
        if (newLimit > type(uint32).max) revert ValueOutOfRange(newLimit, type(uint32).max);
        if (live) _requireNotLoosening(newLimit > trialLimit);
        emit TrialLimitSet(trialLimit, newLimit, msg.sender);
        trialLimit = newLimit;
    }

    function _setCoolingOffHours(uint256 newHours, bool live) internal {
        if (newHours > type(uint16).max) revert ValueOutOfRange(newHours, type(uint16).max);
        if (live) _requireNotLoosening(newHours < coolingOffHours);
        emit CoolingOffHoursSet(coolingOffHours, newHours, msg.sender);
        coolingOffHours = newHours;
    }

    function _setPayee(address payee, bool saved, bool live) internal {
        if (payee == address(0)) revert ZeroAddress();
        Payee storage p = payees[payee];
        if (live) _requireNotLoosening(saved && !p.saved);
        if (p.firstSeen == 0) p.firstSeen = uint64(block.timestamp);
        p.saved = saved;
        emit PayeeSet(payee, saved, p.firstSeen, msg.sender);
    }

    function _setConfirmationThreshold(uint256 newThreshold, bool live) internal {
        if (newThreshold > type(uint32).max) revert ValueOutOfRange(newThreshold, type(uint32).max);
        if (live) _requireNotLoosening(newThreshold > confirmationThreshold);
        emit ConfirmationThresholdSet(confirmationThreshold, newThreshold, msg.sender);
        confirmationThreshold = newThreshold;
    }

    function _setFrozen(bool newFrozen) internal {
        if (newFrozen && !_hasKind(CircuitKind.FREEZE)) revert FreezeCircuitNotAttached();
        frozen = newFrozen;
        emit FrozenSet(newFrozen, msg.sender);
    }

    function _setBeneficiary(address newBeneficiary, address by) internal {
        beneficiary = newBeneficiary;
        beneficiarySetBy = by;
        emit BeneficiarySet(newBeneficiary, by);
    }

    function _checkRuleDelay(uint256 d) internal pure {
        if (d < MIN_RULE_DELAY || d > MAX_RULE_DELAY) revert ValueOutOfRange(d, MAX_RULE_DELAY);
    }

    function _setRuleDelay(uint256 newDelay, bool live) internal {
        _checkRuleDelay(newDelay);
        if (live) _requireNotLoosening(newDelay < ruleDelay);
        emit RuleDelaySet(ruleDelay, newDelay, msg.sender);
        ruleDelay = newDelay;
    }

    /// @dev Common attach checks. Returns the gate count, nIn and netlist hash.
    function _checkProcessor(address processor, uint256 circuitId, uint32 expectedNIn)
        internal
        view
        returns (uint32 gateCount, uint32 nIn, bytes32 netlistHash)
    {
        if (_circuits.length >= MAX_CIRCUITS) revert TooManyCircuits();
        if (processor.code.length == 0) revert NotAProcessor(processor);
        if (address(tapeoutFactory) != address(0) && !tapeoutFactory.isCPU(processor)) revert NotAProcessor(processor);
        uint32 nOut;
        uint32 nState;
        (nIn, nOut, nState, gateCount) = ITapeOutCircuits(processor).circuitInfo(circuitId);
        if (nIn != expectedNIn || nOut != 1 || nState != 0) revert PinoutMismatch(nIn, nOut, nState);
        netlistHash = keccak256(ITapeOutCircuits(processor).netlist(circuitId));
    }

    function _push(CircuitKind kind, address processor, uint256 circuitId, bytes32 netlistHash)
        internal
        returns (uint256 index)
    {
        uint64 uid = ++_lastUid;
        index = _circuits.length;
        _circuits.push(AttachedCircuit(kind, processor, circuitId, netlistHash, uid, false));
        emit CircuitAttached(index, kind, processor, circuitId, netlistHash, uid);
    }

    /// @dev Detach by uid. The last circuit moves into the freed slot. Reverts `ChangeTargetGone` if it is gone.
    function _detach(uint64 uid) internal {
        uint256 n = _circuits.length;
        uint256 index = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            if (_circuits[i].uid == uid) {
                index = i;
                break;
            }
        }
        if (index == type(uint256).max) revert ChangeTargetGone();
        AttachedCircuit memory c = _circuits[index];
        if (index != n - 1) _circuits[index] = _circuits[n - 1];
        _circuits.pop();
        if (c.kind == CircuitKind.CUSTOM) {
            customRuleCount -= 1;
            delete customSpecHash[uid];
        }
        emit CircuitDetached(index, c.kind, c.processor, c.circuitId, uid);
    }

    function _indexOf(uint64 uid) internal view returns (uint256) {
        for (uint256 i; i < _circuits.length; ++i) {
            if (_circuits[i].uid == uid) return i;
        }
        revert UnknownCircuit(uid);
    }

    /// @dev Pinout (input count) per official kind, from the packing libraries. Every circuit has nOut = 1 and
    ///      nState = 0.
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

    function _ceilCents(uint256 amount) internal pure returns (uint256) {
        return amount / UNITS_PER_CENT + (amount % UNITS_PER_CENT == 0 ? 0 : 1);
    }

    function _sat32(uint256 v) internal pure returns (uint256) {
        return v > type(uint32).max ? type(uint32).max : v;
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

    /// @notice The exact custom-rule input bytes a transfer of `amount` to `to` by `caller` would get if it executed
    ///         now (`withdrawal` for `withdraw`). `ok` is false when the amount does not fit (the decision would then
    ///         be blocked with INPUT_OUT_OF_RANGE).
    function customFactsFor(address caller, address to, uint256 amount, bool withdrawal)
        external
        view
        returns (bool ok, bytes memory input)
    {
        (, bool confirmed) = _confirmationFor(to, amount);
        return _customInput(withdrawal ? Action.WITHDRAWAL : Action.PAYMENT, caller, to, amount, confirmed);
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

    /// @notice Current index of circuit `uid` (reverts `UnknownCircuit` if it is not attached).
    function indexOfCircuit(uint64 uid) external view returns (uint256) {
        return _indexOf(uid);
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
