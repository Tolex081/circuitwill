# CircuitWill

A personal money will made of TapeOut circuits on X Layer. Your rules decide whether money can move. An agent can
propose payments, but only the circuits can allow them.

**Status: Phase 5, mainnet deployment prepared, not executed.** The step-by-step X Layer mainnet runbook, with
cost estimate and a passing dry run on a fork of the latest block, is
[`docs/MAINNET_RUNBOOK.md`](docs/MAINNET_RUNBOOK.md); you broadcast it from your own keystore. It contains the escrow contract, all four MVP rule circuits (Daily Cap, Payee
Whitelist + Cooling-off, Confirmation Threshold, Freeze), tests (local, plus an optional run against a fork of
X Layer mainnet) and a static dashboard (`frontend/`, see [Frontend](#frontend-dashboard)) that has run only
against a local anvil fork. **Nothing has been deployed, verified on an explorer, or taped out on a live network,
The dashboard is hosted on Vercel at <https://circuitwill.vercel.app/> (static files only), but no
CircuitWill escrow exists on X Layer for it to open yet.** The optional [Walrus Memory](#walrus-memory-optional-off-by-default)
suggestions are off by default, outside the payment path, and in the browser run on a clearly labelled local stub:
**nothing is connected to Walrus.**

Specifications: `CircuitWill_PRD.md.md`, `CircuitWill_Claude_Handoff.md.md`, `CircuitWill_Circuit_Pinouts.md..md`,
`CircuitWill_Risk_Matrix.md.md`, `CircuitWill_UI_Wireframes.md.md`.
TapeOut interface evidence and gaps: [`docs/TAPEOUT_INTERFACE.md`](docs/TAPEOUT_INTERFACE.md).

## Layout

```
circuits/                         Node (no dependencies): netlist generators + reference simulator
  lib/tap02.mjs                   TAP-02 NAND encoding and LSB-first evaluator
  lib/gates.mjs                   shared comparator, LSB-first field packing, artifact writer
  daily-cap/build.mjs             Daily Cap (447 NAND)
  payee-whitelist/build.mjs       Payee Whitelist + Cooling-off (237 NAND)
  confirmation/build.mjs          Confirmation Threshold (160 NAND)
  freeze/build.mjs                Freeze (1 NAND)
  <name>/build/                   generated netlist (.hex) and metadata (.json), committed
  test/*.test.mjs                 edge values, bit sweeps, exhaustive small widths, 20k random vectors per circuit
contracts/                        Foundry
  src/CircuitWillEscrow.sol       escrow: circuit-gated payments and withdrawals, rule parameters, decision log
  src/CircuitWillKey.sol          non-burnable ERC-721 controller NFT, with on-chain SVG metadata
  src/interfaces/ITapeOut.sol     TapeOut functions used (eval, circuitInfo, netlist, isCPU)
  src/libraries/TapeOutEval.sol   fail-closed eval adapter (the only code that calls TapeOut eval)
  src/libraries/*Packing.sol      one input packer per circuit, with range checks (reject, never truncate)
  test/                           unit, per-circuit and multi-circuit tests; mocks (NAND-interpreting TapeOut double,
                                  hostile processors)
  test/fork/TapeOutFork.t.sol     optional: real TapeOut + real USDT0 on a local X Layer fork
  script/                         TapeOutCircuit.s.sol, TapeOutDailyCap.s.sol, Deploy.s.sol (not run on a live network),
                                  rehearse-anvil.ps1 (local anvil rehearsal of both),
                                  dryrun-anvil.ps1 (the mainnet runbook replayed on a local fork of the latest block)
frontend/                         static dashboard, no build step (see "Frontend dashboard")
  index.html, app.js, style.css   the page: welcome, create wizard, overview, send, rules, history, advanced
  lib/reeval.js                   read-only re-evaluation of a decision (shared by the page and the CLI)
  lib/units.js, lib/meta.js       USDT0 parsing with uint32/uint16 limits, input decoding, enum labels
  lib/xray.js                     Circuit X-ray: runs a netlist in the browser and draws every NAND gate
  lib/preview.js                  payment preview: escrow input packing and time rules, simulation, wording
  lib/memory-pref.js              Walrus Memory on/off flag per wallet (localStorage, default off)
  lib/memory.js                   optional advisory memory hints: stub + SDK adapters, panel (loaded only when on)
  artifacts.js                    ABI + bytecode of CircuitWillEscrow / CircuitWillKey, generated from contracts/out
  vendor/ethers-6.13.4.min.js     ethers v6 (MIT), vendored so the page has no CDN dependency
  serve.mjs                       local static server (127.0.0.1:5173)
  scripts/                        setup-anvil.ps1, build-artifacts.mjs, reevaluate.mjs (CLI), memory-suggest.mjs (agent side)
  test/units.test.mjs             parsing, limits, input decoding, reason priority
  test/memory.test.mjs            memory off by default, adapters, checks that memory cannot reach a contract call
docs/TAPEOUT_INTERFACE.md         what is verified about TapeOut/X Layer and what is not
docs/MAINNET_RUNBOOK.md           X Layer mainnet deployment: commands, cost estimate, dry run, verification, DeWEB
```

## Setup

Requirements: Node ≥ 20, [Foundry](https://getfoundry.sh) (tested with forge 1.9.0). Dependencies (forge-std
v1.9.4, OpenZeppelin Contracts v5.1.0) are vendored in `contracts/lib`.

```powershell
cd circuits; npm run build; npm test
```

```powershell
cd contracts; forge build; forge test; forge fmt --check
```

Optional fork run. It reads mainnet state, simulates locally, and broadcasts nothing:

```powershell
cd contracts; $env:XLAYER_FORK_RPC = "https://rpc.xlayer.tech"; forge test --match-path test/fork/TapeOutFork.t.sol -vv
```

Set `XLAYER_FORK_BLOCK` to pin a block. Without `XLAYER_FORK_RPC`, the fork tests are skipped.

The contract tests read `circuits/<name>/build/<name>.netlist.hex`, so the generators, the Solidity tests, the fork
test and the tapeout scripts all use the same artifacts. A circuit test fails if a committed artifact drifts from its
generator. The packing libraries are checked against shared byte vectors that the Node tests also assert, and fuzzed
against an independent bit-by-bit packer in `test/Base.t.sol`.

## How it works

```
proposePayment(to, amount, memo)  (controller NFT owner or active agent)
withdraw(to, amount)              (controller NFT owner only)
        │
        ▼
_execute: assign decisionId → reset spentToday if the UTC day changed
        → for every attached circuit: pack inputs from on-chain state → TapeOut eval (fail-closed)
        → all ALLOW and balance OK → transfer → spentToday += amount → consume the confirmation, if one was used
        → record decisionRecordHash, emit CircuitEvaluated×n, Decision, PaymentAllowed | PaymentBlocked
          (+ ConfirmationConsumed)
        → return (decisionId, allowed)   — the only revert after evaluation starts is InsufficientGas
```

- **Control follows the NFT.** The escrow stores `controllerNft` and `controllerTokenId` and never holds the NFT.
  Management and `withdraw` require `controllerNft.ownerOf(controllerTokenId) == msg.sender`. When the NFT moves to a
  new wallet, the new holder takes control and the old one loses it.
- **The key shows up in wallets.** `CircuitWillKey.tokenURI` returns fully on-chain metadata (a base64 JSON data
  URI with an SVG image, no IPFS or server). The card shows the gate mark, "CircuitWill Key #<id>", the four rule
  colours and the warning "Whoever holds this key controls a CircuitWill. Transfer it only to hand over control."
  The description says the same in full. The key is minted before its escrow exists, so the image does not show the
  will's address. The art cannot be changed after deployment.
- **Agent key.** `setAgent` records who appointed the agent (`agentSetBy`). The agent is active only while that
  address still owns the NFT, so an NFT transfer disables the previous owner's agent. The agent can only call
  `proposePayment`.
- **No bypass.** `withdraw` uses the same evaluation path as a payment: every attached circuit (whitelist,
  confirmation and freeze included) applies, it counts toward `spentToday`, and it is blocked like any payment. If no
  circuits are attached, everything is blocked (`NO_CIRCUITS`).
- **Fail closed.** Each of these becomes a recorded blocked decision: an eval revert, a circuit that uses up its
  whole per-eval gas budget (`evalGasLimit`, default 3M), missing code, malformed or oversized return data,
  out-of-range inputs, insufficient balance, or a failed token transfer. All attached circuits are evaluated and logged
  even after one denies.
- **Gas budget.** Each eval is forwarded `min(evalGasLimit, gasleft() - GAS_RESERVE)`; `GAS_RESERVE` = 250k is held
  back so recording still fits. If an eval fails after using (nearly) all of the gas it was given, and that was less
  than its budget because the caller sent too little gas, the whole call reverts with `InsufficientGas(index)` and
  nothing is recorded. "Nearly" means at least 15/16 of it: TapeOut circuits contracts are beacon proxies, and each
  proxy hop keeps back 1/64 of the gas when the call below it runs out (EIP-150). An underfunded call therefore
  never turns into a blocked decision, and `eth_estimateGas` (which looks for the lowest limit that does not revert)
  returns a limit at which every circuit gets the gas it needs.
- **Daily spend.** `day = uint32(block.timestamp / 86400)`. When `day != lastResetDay`, `spentToday` is reset to 0
  before inputs are packed. It increases only after a successful transfer.
- **Range.** Amounts, the cap, the trial limit and the threshold are `uint32` in token base units (with 6-decimal
  USDT0, at most 4,294.967295 USDT0). Hours are `uint16`. Setters above the width revert (`ValueOutOfRange`). A
  proposal amount above `2^32-1` makes every amount-reading circuit `NOT_EVALUATED` and the decision blocked
  (`INPUT_OUT_OF_RANGE`). Values are never truncated.
- **Reverts** (nothing is recorded): caller not authorized, `to == 0`, `amount == 0`, memo longer than 256 bytes,
  and `InsufficientGas` (see "Gas budget").

### Management functions (controller only)

| Function | Effect |
|---|---|
| `attachCircuit(kind, processor, circuitId)` / `detachCircuit(index)` | At most one circuit per kind, up to 4. `attachCircuit` checks `isCPU`, and that `circuitInfo` matches the kind's pinout (nIn 96 / 97 / 65 / 1, nOut 1, nState 0), and records `keccak256(netlist)` |
| `setDailyCap(uint256)` | Daily Cap parameter, ≤ `2^32-1` |
| `setPayee(address, bool saved)` / `removePayee(address)` | Payee list. The first `setPayee` records `firstSeen = block.timestamp`; later calls only change `saved`. Removing and re-adding restarts the cooling-off |
| `setTrialLimit(uint256)` | Largest payment to a payee that is not saved, ≤ `2^32-1` |
| `setCoolingOffHours(uint256)` | Hours a payee that is not saved must be known before it can be paid, ≤ 65535 |
| `setConfirmationThreshold(uint256)` | Payments above it need a confirmation, ≤ `2^32-1` |
| `confirmPayment(bytes32 paymentHash)` / `revokeConfirmation(bytes32)` | Confirm (or withdraw the confirmation of) one exact payment, see below |
| `setFrozen(bool)` | Freeze flag. Freezing requires an attached Freeze circuit (`FreezeCircuitNotAttached`), because the flag has no effect without one; unfreezing is always possible |
| `setAgent(address)` | Agent key (or `address(0)` to clear) |
| `setEvalGasLimit(uint256)` | Gas budget per eval, 100,000 to 30,000,000 (default 3,000,000). A circuit that uses it all is recorded as REVERTED |

Defaults after deployment are all zero: trial limit 0 (with the whitelist attached, only saved payees can be paid),
threshold 0 (with the confirmation circuit attached, every payment needs a confirmation), not frozen.

**Parameter-change timing.** Every parameter and the circuit list are read when `proposePayment` / `withdraw`
executes. There is no snapshot at proposal time and no timelock: a change applies to the very next decision,
including one later in the same block. Every change emits an event (`DailyCapSet`, `PayeeSet`, `PayeeRemoved`,
`TrialLimitSet`, `CoolingOffHoursSet`, `ConfirmationThresholdSet`, `PaymentConfirmed`, `ConfirmationRevoked`,
`FrozenSet`, `AgentSet`, `EvalGasLimitSet`, `CircuitAttached`, `CircuitDetached`). A decision's `CircuitEvaluated` inputs show exactly
which values were in force for it.

### Payment confirmations

```
paymentHash = keccak256(abi.encode(
    keccak256("CircuitWill.Payment(uint256 chainId,address escrow,address to,uint256 amount,uint256 nonce)"),
    block.chainid, escrow, to, amount, paymentNonce[to]))
```

- Get it with `currentPaymentHash(to, amount)` (or `hashPayment(to, amount, nonce)`), then call
  `confirmPayment(paymentHash)` as the current NFT owner.
- At execution, the escrow recomputes the hash from the proposal's `to`, `amount` and the recipient's current nonce.
  The circuit gets `confirmed = 1` only if that exact hash was confirmed, has not expired, and was confirmed by the
  wallet that owns the NFT now (a previous owner's confirmations stop counting after a transfer).
- **Expiry:** usable while `block.timestamp <= confirmedAt + CONFIRMATION_TTL` (1 hour). Confirming again refreshes it.
- **One-time:** when a transfer that was packed with `confirmed = 1` succeeds, the confirmation is deleted, the
  recipient's `paymentNonce` increases (so the same hash can never match again), and `ConfirmationConsumed` is
  emitted. A blocked attempt (another circuit denied, balance, transfer failure) does not consume it; the exact same
  payment can be retried until expiry and still executes at most once.
- A different recipient, amount, nonce, chain or escrow gives a different hash, so a confirmation cannot be used for
  any other payment. It applies to `withdraw` too (same recipient and amount).
- The confirmation is consumed whenever it is used, even if the amount was at or below the threshold.

### Daily Cap circuit

nIn = 96, nOut = 1, 447 NAND. Output bit 0 is `1` if `spent_today + amount <= daily_cap`.

| Bytes | Pins | Value (little-endian) |
|---|---|---|
| 0–3 | 0–31 | amount (uint32) |
| 4–7 | 32–63 | spent_today (uint32) |
| 8–11 | 64–95 | daily_cap (uint32) |

The netlist is a ripple-carry adder, an LSB→MSB comparator, and `AND NOT carry32`: the 33-bit sum is checked, so it
never wraps. The pinout document targets fewer than 150 gates, which is not achievable for a 32-bit add-and-compare
built from 2-input NANDs.

### Payee Whitelist + Cooling-off circuit

nIn = 97, nOut = 1, 237 NAND. Output bit 0 is `is_saved OR (amount <= trial_limit AND age_hours >= cooling_off_hours)`.

| Pins | Value |
|---|---|
| 0 | is_saved |
| 1–16 | age_hours (uint16) |
| 17–48 | amount (uint32) |
| 49–80 | trial_limit (uint32) |
| 81–96 | cooling_off_hours (uint16) |

The 13 input bytes are the little-endian encoding of the 97-bit word
`is_saved | age_hours<<1 | amount<<17 | trial_limit<<49 | cooling_off_hours<<81` (fields are not byte-aligned).
The escrow computes `age_hours = (block.timestamp - firstSeen) / 3600` for a payee added with `setPayee`, and 0 for an
unknown payee (treated as first seen now). Age saturates at 65535 hours (about 7.5 years); because
`cooling_off_hours <= 65535`, the comparison gives the same result as the true age. The netlist is two unsigned
comparators (2 + 5 per further bit) and 3 combining gates. The pinout document targets fewer than 200 gates; this
construction needs 237.

### Confirmation Threshold circuit

nIn = 65, nOut = 1, 160 NAND. Output bit 0 is `amount <= threshold OR confirmed`.

| Bytes | Pins | Value |
|---|---|---|
| 0–3 | 0–31 | amount (uint32, little-endian) |
| 4–7 | 32–63 | threshold (uint32, little-endian) |
| 8 | 64 | confirmed (`0x00` or `0x01`) |

One 32-bit comparator plus 3 gates. The pinout document targets fewer than 100 gates; this construction needs 160.

### Freeze circuit

nIn = 1, nOut = 1, 1 NAND: `allow = NAND(freeze_flag, freeze_flag)`. Input is one byte, `0x00` (allow) or `0x01`
(block). It is combinational: the escrow stores the flag, so no LATCH or `step` is used.

## Event and re-evaluation format

Each decision emits, in order: one `CircuitEvaluated` per attached circuit, then `Decision`, then `PaymentAllowed`
or `PaymentBlocked`, then `ConfirmationConsumed` if an allowed transfer used a confirmation. Enums are encoded as
`uint8` in the ABI.

```solidity
event CircuitEvaluated(uint256 indexed decisionId, uint256 indexed index, uint8 kind, address processor,
                       uint256 circuitId, bytes32 netlistHash, bytes input, uint8 status, bytes output);
event Decision(uint256 indexed decisionId, uint8 indexed action, bool indexed allowed, address proposer, address to,
               uint256 amount, uint32 day, uint256 spentTodayBefore, uint256 spentTodayAfter, uint8 reason,
               string memo, bytes32 recordHash);
event PaymentAllowed(uint256 indexed decisionId, uint8 indexed action, address indexed to, uint256 amount);
event PaymentBlocked(uint256 indexed decisionId, uint8 indexed action, address indexed to, uint256 amount, uint8 reason);
event ConfirmationConsumed(uint256 indexed decisionId, bytes32 indexed paymentHash, address indexed to, uint256 amount,
                           uint256 nonce);
```

The Phase 1 event signatures are unchanged. New `kind` values were appended; existing values were not renumbered.

| Enum | Values |
|---|---|
| `kind` | 0 NONE, 1 DAILY_CAP, 2 WHITELIST, 3 CONFIRMATION, 4 FREEZE |
| `action` | 0 PAYMENT, 1 WITHDRAWAL |
| `status` | 0 NOT_EVALUATED (inputs out of range), 1 ALLOW, 2 DENY, 3 REVERTED (incl. out of gas), 4 MALFORMED_OUTPUT |
| `reason` | 0 NONE (allowed), 1 CIRCUIT_DENIED, 2 EVAL_FAILED, 3 INPUT_OUT_OF_RANGE, 4 NO_CIRCUITS, 5 INSUFFICIENT_BALANCE, 6 TRANSFER_FAILED |

When several circuits fail, `reason` follows a fixed priority: INPUT_OUT_OF_RANGE > EVAL_FAILED > CIRCUIT_DENIED.

`input` is exactly the byte string passed to `processor.eval(circuitId, input)`. `netlistHash` is
`keccak256(processor.netlist(circuitId))`, taken when the circuit was attached.

**On-chain commitment.** `decisionRecordHash(decisionId)` stores:

```
circuitsHash = 0x00…00
for each CircuitEvaluated in index order:
  circuitsHash = keccak256(abi.encode(circuitsHash, kind, processor, circuitId, netlistHash,
                                      keccak256(input), status, keccak256(output)))
recordHash = keccak256(abi.encode(escrow, chainId, decisionId, action, proposer, to, amount, day,
                                  spentTodayBefore, allowed, reason, keccak256(bytes(memo)), circuitsHash))
```

**To re-evaluate a decision** (anyone, read-only):

1. Get the transaction's logs, for example with `cast receipt <txHash> --rpc-url https://rpc.xlayer.tech`.
2. Decode each `CircuitEvaluated` data:
   `cast abi-decode --input "f(uint8,address,uint256,bytes32,bytes,uint8,bytes)" <data>`.
3. Re-run each circuit on its recorded input:
   `cast call <processor> "eval(uint256,bytes)(bytes)" <circuitId> <input> --rpc-url https://rpc.xlayer.tech`.
   The result must equal `output`, and bit 0 decides allow or deny. The decision is allowed only if every circuit
   returned 1 (and then balance and transfer succeeded, see `reason`).
4. Check that each circuit is unchanged:
   `cast keccak $(cast call <processor> "netlist(uint256)(bytes)" <circuitId> --rpc-url …)` must equal `netlistHash`.
   You can also simulate the netlists offline with `circuits/lib/tap02.mjs`.
5. Check that the inputs match the summary (`Decision.amount`, `spentTodayBefore`):
   - Daily Cap: bytes 0–3 = `amount`, bytes 4–7 = `spentTodayBefore`, bytes 8–11 = the cap in force.
   - Payee Whitelist: read the 13 bytes as a little-endian integer `w`; `(w >> 17) & 0xffffffff` = `amount`.
     `w & 1` is is_saved, `(w >> 1) & 0xffff` age_hours, `(w >> 49) & 0xffffffff` trial_limit,
     `(w >> 81) & 0xffff` cooling_off_hours. `PayeeSet` events give the payee's `firstSeen`.
   - Confirmation: bytes 0–3 = `amount`, bytes 4–7 = the threshold in force, byte 8 = confirmed. A confirmed `1`
     is backed by a `PaymentConfirmed` event for `hashPayment(to, amount, nonce)` within the last hour, and by a
     `ConfirmationConsumed` event when the payment went through.
   - Freeze: `0x01` means frozen; it matches the last `FrozenSet` event before the decision.
6. Recompute `recordHash` from the event fields and compare it with `decisionRecordHash(decisionId)` on the escrow.

`test_thirdPartyCanReEvaluateFromEvents` (one circuit) and `test_thirdPartyReEvaluatesMultiCircuitDecisions` (four
circuits, five decisions, parameters changed afterwards) perform these steps from recorded logs. The dashboard's
**Re-evaluate** button and `node frontend/scripts/reevaluate.mjs <txHash> [rpc]` perform all six steps from a
transaction hash (see [Frontend](#frontend-dashboard)).

## Deployment configuration (not yet done)

**To deploy, follow [`docs/MAINNET_RUNBOOK.md`](docs/MAINNET_RUNBOOK.md).** It gives the exact PowerShell
commands with a Foundry keystore (`--account`), says where `--broadcast` and `--verify` go, and estimates the cost
from live fee reads: ≈ 0.0055 OKB (of which 0.0052 OKB is the four tapeout fees), 0.11 BEM, and 60 USDT0 for the
demo, none of which is a fee. It also records the dry run of 2026-11-20 on a fork of block 76,403,789, which passed
with no TapeOut drift, and what is known about DeWEB hosting. The table below summarizes the configuration.

Nothing below has been executed on a live network. You need:

| Item | Value / how to get it |
|---|---|
| Network | X Layer mainnet, chain 196, RPC `https://rpc.xlayer.tech` |
| Token | USDT0 `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` (6 decimals) |
| TapeOut factory | `0x1f09DAeFA827f02CBb40967cc91b259763760761` (for the `isCPU` check; `0x0` disables it) |
| TapeOut CPU (processor) | **Missing.** A circuits contract to tape out on. Your own CPU costs 0.1 BEM `deployFee` (observed); all four circuits need 845 NAND transistors (447 + 237 + 160 + 1) of that CPU |
| Circuit ids | **Missing.** One per circuit from `script/TapeOutCircuit.s.sol` (`CIRCUIT=daily-cap`, `payee-whitelist`, `confirmation`, `freeze`); each tapeout costs 0.0013 OKB `TAPEOUT_FEE` (observed on a fork) |
| Controller NFT | **Decided: `CircuitWillKey`** (non-burnable, non-upgradeable). `Deploy.s.sol` deploys one, or reuses `CIRCUITWILL_KEY`, and mints a fresh id per escrow. TapeOut circuit NFTs are not used as controllers: a circuit can be shared by many escrows, and its contract is owner-upgradeable |
| Daily cap | `DAILY_CAP`, base units, ≤ 4294967295 (for example `50000000` = 50 USDT0) |
| Whitelist | `WHITELIST_CIRCUIT_ID`, `TRIAL_LIMIT` (base units), `COOLING_OFF_HOURS`, `SAVED_PAYEES` (comma-separated). Save the controller's own wallet too, or withdrawals to it are treated as a new payee |
| Confirmation | `CONFIRMATION_CIRCUIT_ID`, `CONFIRMATION_THRESHOLD` (base units) |
| Freeze | `FREEZE_CIRCUIT_ID` |
| Agent key | `AGENT`, optional address |
| Deployer | A keystore account funded with OKB for gas (`--account`). Never put keys in files |

```powershell
cd contracts; $env:TAPEOUT_CIRCUITS = "<circuits address>"; $env:CIRCUIT = "payee-whitelist"; forge script script/TapeOutCircuit.s.sol --rpc-url xlayer --account <keystore>
```

```powershell
cd contracts; $env:TAPEOUT_CIRCUITS = "<circuits address>"; $env:DAILY_CAP_CIRCUIT_ID = "<id>"; $env:DAILY_CAP = "50000000"; $env:WHITELIST_CIRCUIT_ID = "<id>"; $env:TRIAL_LIMIT = "5000000"; $env:COOLING_OFF_HOURS = "24"; $env:SAVED_PAYEES = "<addr1>,<addr2>"; $env:CONFIRMATION_CIRCUIT_ID = "<id>"; $env:CONFIRMATION_THRESHOLD = "20000000"; $env:FREEZE_CIRCUIT_ID = "<id>"; forge script script/Deploy.s.sol --rpc-url xlayer --account <keystore>
```

Both commands only simulate. Add `--broadcast` (and `--verify` with explorer settings) only when you intend to spend
real funds. `Deploy.s.sol` sets each circuit's parameters before attaching it.

**Rehearsal on a local anvil fork.** `script/rehearse-anvil.ps1` runs the real scripts against a local anvil node:
it creates a CPU, mints NAND, runs `TapeOutCircuit.s.sol` for all four circuits, runs `Deploy.s.sol`, checks the
configuration, then makes an allowed payment, a blocked unconfirmed payment, a confirmed payment and a frozen
withdrawal with real USDT0 logic. It refuses any RPC other than `127.0.0.1`/`localhost`, impersonates accounts (no
keys), and writes to `broadcast-rehearsal/`, `cache-rehearsal/` and `out-rehearsal/` so nothing looks like a real
chain-196 deployment record.

```powershell
anvil --fork-url https://rpc.xlayer.tech --fork-block-number 76350000 --retries 20 --fork-retry-backoff 1500 --compute-units-per-second 50
```

```powershell
cd contracts; powershell -ExecutionPolicy Bypass -File script/rehearse-anvil.ps1
```

Status (2026-11-20, rerun after the gas-budget change): the full rehearsal passed on anvil forked at block
76,350,000, with every escrow call sent at the gas limit `cast` estimated (no explicit limit). Estimates were 2.44M to
2.46M for the four `proposePayment` / `withdraw` calls, each using 2.23M to 2.32M. All 25 checks passed:
CPU and 845 NAND, four tapeouts, `Deploy.s.sol` with all four circuits and their parameters, an allowed 10 USDT0
payment, a blocked unconfirmed 30, a confirmed 30 (confirmation consumed), a frozen withdrawal, and four recorded
decisions. Anvil fetches fork state lazily from the public RPC; earlier attempts failed on connection resets and DNS
errors, so expect retries on a flaky connection. The script retries read-only calls, and retries a transaction only
when the sender's nonce did not move and anvil's pool is empty.

**Gas** (fork measurements, real TapeOut, fork at block 76,350,000): eval ≈ 1.07M (Daily Cap), 0.59M (Whitelist),
0.41M (Confirmation), 0.03M (Freeze), including call overhead. With all four attached, an allowed `proposePayment`
that consumes a confirmation used ≈ 2.32M gas and a blocked `withdraw` ≈ 2.23M. Fund the escrow with a plain USDT0
`transfer` to its address.

**Gas estimation works.** Wallets, agents and `cast send` can rely on `eth_estimateGas` for `proposePayment` and
`withdraw`. A limit too low for any circuit reverts with `InsufficientGas` instead of being recorded as a blocked
decision, so the estimate is the lowest limit at which every circuit is evaluated in full: ≈ 2.43M for a 10 USDT0
payment with all four circuits on the fork (`test_fork_estimatedGasIsEnoughWithFourCircuits`; just below it the call
reverts with `InsufficientGas`). Before this change the escrow recorded a starved eval as a blocked decision: an
estimated 2.31M limit on the anvil rehearsal blocked a payment (Confirmation and Freeze REVERTED) that 4M gas allowed.

## Frontend dashboard

`frontend/` is a static page with no build step and no runtime dependencies (ethers 6.13.4 is vendored). It is hosted
on Vercel at <https://circuitwill.vercel.app/> (`vercel.json` redirects `/` to `/frontend/`; `.vercelignore` publishes
only `frontend/` and `circuits/lib/`, without `local-config.json`, `serve.mjs`, `scripts/` or `test/`). It has only
been exercised against a local anvil fork.

The page is built for first-time users: plain language first, contract details on request.

| Screen / tab | What it does |
|---|---|
| Welcome | What a CircuitWill is, an example will (labelled "Example"), how it works in three steps, and common questions (who can change rules, the key, the AI helper). **Connect wallet**, or **View a CircuitWill** without a wallet (`?escrow=<address>&from=<block>` also opens any will read-only). The network is chosen automatically and shown in the top bar; the network choice and developer mode sit under **Network settings** in the footer |
| Start | **Create a CircuitWill**, open one by address, or reopen one this browser opened before (kept in `localStorage`, a convenience only) |
| Create (3 steps) | 1. Rules as sentences with switches ("Up to [50] USDT0 can leave per day"). 2. Optional AI helper (agent). 3. Review, the number of wallet approvals, and a live checklist while it runs. It deploys `CircuitWillKey` (or reuses one), mints the key NFT to your wallet, deploys `CircuitWillEscrow`, sets each circuit's parameters, then attaches it (same order as `Deploy.s.sol`), then sets the agent. Processor and circuit ids come from the official set (`OFFICIAL` in `app.js`, empty until the mainnet tapeout) or `local-config.json`; otherwise they are entered under **Advanced: token and circuits** |
| Header | Will address, your role (**Owner**, **AI helper** or **View only**) with what that role can do, and a banner with **Unfreeze** while frozen |
| Overview | Balance and **Add money** (a plain USDT0 `transfer`), spent today against the daily limit with time to reset, the rules in force as sentences, recent payments |
| Send | `proposePayment(to, amount, memo)` for the owner or the active agent, with trusted recipients as one-click chips. While you type, a **Preview** card shows what each rule would answer, today's spending and the balance after the payment, and one verdict line (see [Payment preview](#frontend-dashboard) below). Above the approval amount it says the owner must approve this exact payment, and gives the owner an **Approve this payment** button (`confirmPayment`). **Withdraw** for the owner. The result says *Payment sent* or *Payment blocked* and, per rule, why, read from the recorded circuit inputs (for example "Today's spending would reach 60 USDT0, over the 50 USDT0 daily limit"). A blocked payment keeps its details so it can be approved and sent again |
| Rules | One card per rule: on/off, the setting as a sentence, change it, turn it on (`attachCircuit` from the official set) or off (`detachCircuit`). Trusted recipients (trust, stop trusting, remove, add), approvals for one exact `(to, amount)` (approve, cancel, check), freeze/unfreeze, AI helper (add, change, remove). Owner only; others see the rules read-only |
| History | Every `Decision` (from the `from` block, or the last 10,000 blocks) as *Sent* / *Blocked* with a one-line reason; expand for each rule's answer, **Verify this decision** (re-evaluation), **See the circuits work** (Circuit X-ray, below) and the technical record |
| Advanced | Contract addresses, attached circuits with processor, id and netlist hash, attach a custom circuit, `evalGasLimit`, and the transaction log with gas |
| Footer | "Circuits make the final decision", **Verify any decision** by transaction hash (any escrow), **Network settings** |

Rules the page follows:

- **It never decides.** Allowed/blocked comes only from the escrow's `Decision` event, and the page says the answer
  is final. There is no override, retry-until-allowed or memory input. The per-rule explanations of a decision are
  read from the inputs the escrow recorded for it. The payment preview on the Send tab is labelled **Preview** ("the
  blockchain makes the final decision when you send"), never disables **Send payment**, and is never shown as the
  result: after sending, the recorded decision is. The "needs approval" note on the Send tab only compares the
  typed amount with the approval amount and points to the approval step; the circuit still decides. Optional Walrus Memory
  hints are display-only text beside the form (see [Walrus Memory](#walrus-memory-optional-off-by-default)).
- **Gas from `eth_estimateGas`.** Every transaction is sent with the estimate + 10%. Because an underfunded eval
  reverts with `InsufficientGas` instead of being recorded, the estimate is enough for every circuit; extra gas
  cannot change an outcome (each eval is capped at `evalGasLimit`). A revert is shown in plain words (for example `NotController`: "Only the owner of this CircuitWill … can do this"); the transaction log in Advanced keeps the details.
- **Limits enforced before sending.** USDT0 amounts are parsed as exact 6-decimal values (no floating point) and
  rejected above 4,294.967295 USDT0 (`2^32-1` base units). Cooling-off ≤ 65535 h, `evalGasLimit` 100,000 to
  30,000,000, memo ≤ 256 UTF-8 bytes.
- **Re-evaluation is read-only.** From the transaction receipt it re-runs TapeOut `eval` on each recorded input and
  compares the output, checks `keccak256(netlist)` against `netlistHash`, simulates the fetched netlist offline with
  `circuits/lib/tap02.mjs`, checks the packed amount / `spentToday` against the `Decision`, checks that `reason`,
  `allowed` and `spentTodayAfter` follow from the circuit statuses, and recomputes `recordHash` (compared with the
  event and with `decisionRecordHash(decisionId)`). REVERTED or MALFORMED_OUTPUT circuits are reported as not
  replayable. A mismatch is reported; nothing is written.

**Circuit X-ray.** In an expanded History row, **See the circuits work** shows one picker entry per rule that was
evaluated (the blocking one first). For the chosen rule it reads `netlist(circuitId)` and `circuitInfo(circuitId)` from
the recorded processor (view calls), checks `keccak256(netlist)` against the recorded `netlistHash`, and re-runs the
netlist in the browser on the recorded `CircuitEvaluated` input bytes, with the same TAP-02 NAND semantics as
`circuits/lib/tap02.mjs`. It then draws every gate: input bits on the left (labelled amount, spent today, daily limit
and so on; the field boundaries are derived from `decodeCircuitInput`), one bit position per row, stages as lanes
(Daily Cap: *Add* 285 gates → *Compare* 161 → *Result*), and the output bit on the right. Lit wires and gates are 1,
dim ones are 0; the signal lights up left to right by gate depth (instant with `prefers-reduced-motion`). Tap a gate
or input dot to see its inputs and output; zoom with − / Fit / +. A plain-English caption explains the stages with
the recorded values. If the computed bit differs from the recorded output the panel says **Mismatch** in red; if the
netlist hash differs it warns that the circuit changed. It only explains: the recorded decision is final. The drawing
lives in `frontend/lib/xray.js` (`buildXray` from netlist + input bytes, `mountXray` to draw), so it can be reused on
other inputs; `test/xray.test.mjs` checks it against `tap02.mjs` on all four circuits.

**Payment preview.** On the Send tab, for the owner or the active AI helper, once the recipient and amount are valid
(400 ms after the last keystroke), the page works out what the will's circuits would answer, without a transaction or
a wallet prompt. It reads the escrow with view calls only (`circuits`, `spentToday`, `lastResetDay`, `dailyCap`,
`payees(to)`, `trialLimit`, `coolingOffHours`, `confirmationThreshold`, `currentPaymentHash` → `confirmations`,
`controller`, `frozen`, `balance`) and builds each circuit's input bytes the way `_execute` / `_evaluate` do
(`frontend/lib/preview.js`): spent today resets to 0 when the UTC day (`timestamp / 86400`) differs from
`lastResetDay`; payee age is whole hours `(now - firstSeen) / 3600`, 0 for an unknown payee, capped at 65535; a
confirmation counts while `now <= expiresAt` and only if given by the current controller; the packing is bit for bit
that of `contracts/src/libraries/*Packing.sol`, and a value that does not fit gives NOT_EVALUATED. `now` is the
pending block's timestamp when the node reports one (anvil does; its clock can differ from this computer's), otherwise
the latest block's. Each circuit's netlist is read from its processor (`netlist`, `circuitInfo`), checked against the
attached `netlistHash` (a mismatch makes that rule and the verdict "can't preview"), and run in the browser with the
X-ray evaluator. Statuses combine like `_worse`, then the balance check. The card shows:

- one line per rule: *Would pass* / *Would block* with the reason in the History wording ("Today's spending would
  reach 52 USDT0, over the 50 USDT0 daily limit (37 already spent).");
- today's spending after the payment against the daily limit ("37 of 50 USDT0 used today after this payment", or
  "Today stays at …" when it would be blocked) with a meter, and the money left in the will;
- one verdict line ("This payment would be blocked: above 20 USDT0 it needs your approval first."). When the Approval
  rule is the only blocker the owner gets the same **Approve this payment** button as before (the AI helper is told to
  ask the owner), and after approving the preview turns to *would go through*;
- notes when a new UTC day has started, or when midnight, the end of a recipient's waiting time or an approval's
  expiry is under 2 minutes away (the answer may change by the time you send);
- **See the circuits**: the Circuit X-ray on the simulated inputs, one picker entry per rule, worded "would be".

It refreshes on every edit, after each refresh of the will (for example after sending or approving), and every 30 s
while the Send tab is open. Viewers see no preview. `test/preview.test.mjs` checks the packing against the README
pinout tables pin by pin and against the circuit builders' `pack*Inputs`, the day rollover and hour rounding at
their boundaries, the confirmation rules, and the simulated answers on the real netlists against each circuit's
formula.

*Verified on 2026-11-22* on the local anvil fork, owner and AI helper, comparing the preview's verdict, each rule's
answer and each circuit's input bytes with the `CircuitEvaluated` logs of the decision recorded after pressing Send:

| Decision | Case | Preview | Recorded | Input bytes |
|---|---|---|---|---|
| #7 | frozen, 1 USDT0 to a trusted payee | blocked: frozen | blocked (Freeze DENY) | identical |
| #8 | 1 USDT0 to a trusted payee | would go through, 12 of 50 used, 88 left | allowed, spent 12 | identical |
| #9 | 25 USDT0, above the 20 USDT0 approval amount | blocked: needs your approval (Approve offered) | blocked (Confirmation DENY) | identical |
| #10 | same, after **Approve this payment** in the preview | would go through, 37 of 50 | allowed, spent 37 | identical |
| #11 | 15 USDT0 with 37 spent | blocked: today's spending to 52, over 50 | blocked (Daily Cap DENY) | identical |
| #13 | 3 USDT0 to an address not on the list | blocked: not on your list yet | blocked (Whitelist DENY) | identical |
| #14 | 3.5 USDT0 to a payee added exactly 24 h earlier, next UTC day | would go through, new day note, 3.5 of 50 | allowed, spent 3.5 | identical |
| #15 | 2 USDT0 to a payee added 23 h 58 min earlier | blocked: added 23 h ago, close-call note | blocked (Whitelist DENY) | identical |
| #16 | AI helper, 25 USDT0 | blocked: needs the owner's approval | blocked (Confirmation DENY) | identical |
| #17 | AI helper, 2 USDT0 | would go through | allowed | identical |

(#12 was a test-harness timing slip, not a preview error. #14 and #15 used `evm_increaseTime`.) Also checked at 375 px
and in both themes.

*Verified on 2026-11-22* in the in-app browser on the local anvil fork (block 76,350,000; all transactions local): a
new will (cap 50, trial limit 5 / 24 h, threshold 20, freeze) funded with 100 USDT0 recorded #1 10 USDT0 to a trusted
payee (allowed), #2 60 USDT0 to a new address (blocked by Daily Cap, Whitelist and Confirmation), #3 1 USDT0 (allowed)
and #4 1 USDT0 while frozen (blocked by Freeze). All 16 X-rays (4 decisions × 4 circuits: 447, 237, 160 and 1 NAND)
computed the recorded output bit, with no netlist-hash warning, on desktop and at 375 px, in dark and light themes.

**Run it against a local anvil fork** (three terminals, from the repository root):

```powershell
anvil --fork-url https://rpc.xlayer.tech --fork-block-number 76350000 --retries 20 --fork-retry-backoff 1500 --compute-units-per-second 50
```

```powershell
cd frontend; powershell -ExecutionPolicy Bypass -File scripts/setup-anvil.ps1
```

```powershell
node frontend/serve.mjs
```

`setup-anvil.ps1` refuses any RPC that is not `127.0.0.1`/`localhost` and a chain other than 196. It creates a TapeOut
CPU, mints 845 NAND, tapes out the four circuits with `script/TapeOutCircuit.s.sol`, gives two fresh addresses
(owner, agent) OKB for gas and the owner 500 USDT0 (storage writes, test only), and writes their addresses and the
circuit ids to `frontend/local-config.json` (git-ignored, no keys). It does not create a will. Open
`http://127.0.0.1:5173/frontend/`: the page picks the local test network by itself. Press **Use the test owner account** on the welcome screen (or
pick another account under **Network settings** in the footer), then **Create a CircuitWill**.

**Network.** Users never have to type a server address. The page reads from:

| Where the page runs | Default network | Badge |
|---|---|---|
| Anywhere public (for example circuitwill.vercel.app) | X Layer, through `https://rpc.xlayer.tech` | **X Layer** |
| `localhost` / `127.0.0.1` with `frontend/local-config.json` present | the local anvil fork from that file | **Test network · not real money** |
| Any, with `?rpc=<url>` or **Advanced → Custom X Layer server** | that server, if it reports chain 196 | **X Layer · custom server** |

The local test network option and developer mode (test accounts via `anvil_impersonateAccount`, no key) appear only
when the page itself runs on `localhost` / `127.0.0.1`. `local-config.json` is read only there. Problems are
explained in plain words: "Can't reach X Layer right now…", "That server is not X Layer (it reports chain …)", or
"Can't reach the local test network… Is anvil running?". The badge then shows **Can't reach network** or
**Not X Layer**. The page waits up to 20 s for the public RPC and retries once, because the public RPC sometimes
takes more than 10 s to answer. Wallet transactions always go through the wallet, whichever network is used for
reading.

After changing a contract, regenerate the page's ABI and bytecode: `cd contracts; forge build`, then
`node frontend/scripts/build-artifacts.mjs`. Unit tests: `cd frontend; npm test`.

**Command-line re-evaluation** (same code as the button):

```powershell
node frontend/scripts/reevaluate.mjs <txHash> https://rpc.xlayer.tech
```

It exits 0 only if every check passed.

**Verified on 2026-11-20** in the in-app browser against anvil forked at block 76,350,000 (all transactions local):
the page created a will (key, escrow, cap 50, whitelist with trial limit 5 and 24 h cooling-off, threshold 20,
freeze, agent; 14 transactions), funded it with 100 USDT0, then:

| Decision | Who | Request | Circuits | Outcome |
|---|---|---|---|---|
| #1 | owner | 10 USDT0 to a saved payee | all ALLOW | allowed; balance 100 → 90, spent today 0 → 10. Estimate 2,455,039 gas, used 2,310,560 |
| #2 | agent | 60 USDT0 to the same payee | Daily Cap DENY (10 + 60 > 50), Confirmation DENY (60 > 20) | blocked, `CIRCUIT_DENIED`; the transaction succeeded, no funds moved, spent today stayed 10. Estimate 2,445,024, used 2,236,118 |

Re-evaluating both (button, transaction-hash form and CLI) passed all 26 checks each, including the recomputed
`recordHash`. With a tampered memo and Daily Cap input, the same check reported five failures (eval output, offline
simulation, packed amount, and both `recordHash` comparisons). A 5,000 USDT0 proposal was rejected in the form
before any transaction.

## Walrus Memory (optional, off by default)

An optional side feature from handoff section 4 and PRD section 7: when you turn it on, the dashboard shows
**non-binding hints** next to the propose-payment form, such as how often a payee was allowed or blocked before, the
typical allowed amount, and your own notes about the payee. Circuits still make every decision. Memory never
supplies a circuit input, an escrow argument or any other value that reaches a contract, and it never fills in or
submits the form.

**SDK (checked against the official docs on 2026-11-20).** The official TypeScript SDK is
[`@mysten-incubation/memwal`](https://docs.wal.app/walrus-memory/sdk/quick-start) (Walrus Foundation docs; there are
unrelated third-party packages with similar names). Its default client is
`MemWal.create({ key, accountId, serverUrl?, namespace? })`, where `key` is an Ed25519 **delegate private key** and
`accountId` is a Walrus Memory account object on Sui, both generated at memory.walrus.xyz. The client offers
`remember(text)` (returns a job with `job_id`), `recall({ query, limit })` (returns `{ results: [{ text, distance }] }`,
where a smaller distance is a closer match) and `health()`. The managed relayers are `https://relayer.memory.walrus.xyz`
(Mainnet) and `https://relayer.dev.memwal.ai` (Testnet). Sources:
[Quick Start](https://docs.wal.app/walrus-memory/sdk/quick-start),
[Usage: Walrus Memory](https://docs.wal.app/walrus-memory/sdk/usage/memwal),
[Overview](https://docs.wal.app/walrus-memory/sdk/overview), and
[Production readiness](https://docs.wal.app/walrus-memory/sdk/production-readiness), which says to load these keys
"from a secret manager, never from source or logs".

**Why the browser uses a stub.** Every SDK call is signed with the delegate private key. This static page has no
backend, and shipping or typing that key into it would expose it, so the dashboard does not load the SDK. Instead,
`frontend/lib/memory.js` defines one adapter shape (the SDK's `remember` / `recall`) with two implementations:

| Adapter | Where | Status |
|---|---|---|
| `createStubAdapter` | browser dashboard | **STUB.** It stores memories in this browser's `localStorage`, scoped to the connected wallet and escrow. The page says "STUB … Not connected to Walrus" in the panel. |
| `createMemWalAdapter(MemWal, { key, accountId, serverUrl })` | agent side (Node), `frontend/scripts/memory-suggest.mjs <payee> [--note "…"]` | Written against the documented API and unit-tested with a fake `MemWal` class. **Not connected:** the package is not installed in this repository, there are no credentials, and it has never called a relayer. To use it, `npm install @mysten-incubation/memwal` and set `MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID` and optionally `MEMWAL_SERVER_URL` in the environment, never in a file. The script prints text hints only and has no wallet, RPC or contract access. |

**Using it.** Connect a wallet, open a will, and tick **Show suggestions from Walrus Memory** on the Send tab. The
setting is stored per wallet in this browser (`localStorage` key `circuitwill:walrus-memory:v1:<address>`) and is off
for any wallet that has not turned it on. A blue, dashed panel labelled "Suggestion · from memory · non-binding"
appears beside the form. It reads "Suggestion based on past behaviour. Your circuits make the final decision." and
updates as you type the **To** address. You still type and submit every field yourself.

**What memory stores.** After a decision is recorded on-chain, it stores a short summary in this form:
`CircuitWill payment of 10 USDT0 to 0x…: ALLOWED by circuits (decision #1).` It also stores any notes you type.
Payment memos are never stored.

**How the boundary is enforced** (`frontend/test/memory.test.mjs`, part of `npm test`):

- **Off means off.** `app.js` statically imports only `lib/memory-pref.js`, which reads one flag. `lib/memory.js` is
  loaded with a dynamic `import()` in a single function (`syncMemory`), after the flag is checked. With memory off,
  the browser never requests `lib/memory.js` and contacts no memory service.
- **No path to a contract.** `lib/memory.js` has no imports and no reference to ethers, contracts, `fetch`, `window`,
  `document`, `localStorage` (storage is injected) or any payment field id. It never queries the page, and it is
  given only the **To** input, which it reads. A fake-DOM test traps every write, `submit`, `click`, `focus` and
  `dispatchEvent` on that input and finds none. Hints are frozen `{ kind, text }` objects with no amount or address
  field.
- **Senders stay clean.** Every function in `app.js` that sends a transaction (`sendTx`, `deployContract`,
  `createWill`, `propose`, `withdraw`, `fund`, `saveRule`, `bind`) contains no memory reference. `propose()` takes its
  arguments from exactly the three form fields.
- **One-way learning.** Memory learns outcomes only after the fact, from a frozen `circuitwill:decision` event that
  `showDecisionResult` dispatches after the receipt. The event is dispatched only while memory is on.
- **The panel cannot submit the form.** It is an `<aside>` outside `<form id="propose-form">`, and its one button is
  `type="button"`. The toggle starts unchecked.
- **Failures change nothing.** A failing memory backend becomes an "unavailable" hint, and preference storage errors
  read as off.

### Success criterion: works with Walrus Memory turned off

- [x] **Works with Walrus Memory turned off** (handoff section 5, PRD section 11). With memory off, which is the
  default, the dashboard loads no memory module and makes no memory requests, and payments behave as in Phase 3. This
  was shown in the browser on the local anvil fork; see the record below. No contract or circuit changed in this
  phase.

**Verified on 2026-11-20** in the in-app browser against a fresh anvil fork of block 76,350,000 (all transactions
were local; `setup-anvil.ps1` taped out circuits 1 to 4). The dashboard created a new will with the same settings as
Phase 3 (14 transactions) and funded it with 100 USDT0.

| Step | Memory | Result |
|---|---|---|
| Fresh page, owner connected | off (default) | Toggle unchecked, note "Off (default)". Network log: `memory-pref.js` loaded, **no `lib/memory.js`**. `localStorage` empty |
| #1: owner, 10 USDT0 to the saved payee | off | **Allowed**, all circuits ALLOW. Balance 100 → 90, spent today 0 → 10. Estimate 2,454,362 gas, used 2,309,346 |
| #2: agent, 60 USDT0 to the same payee | off | **Blocked**, `CIRCUIT_DENIED` (Daily Cap DENY, Confirmation DENY). The transaction succeeded, no funds moved, spent today stayed 10. Estimate 2,444,530, used 2,235,355. Still no `lib/memory.js` request. The only hosts contacted were `127.0.0.1:5173` and `127.0.0.1:8545` |
| Re-evaluation of #1 and #2 (`reevaluate.mjs`) | n/a | Both report "Re-evaluation matches the record", including the recomputed `recordHash` |
| Agent turns memory on | on | `lib/memory.js` was requested only now. The panel shows the suggestion copy and "STUB … Not connected to Walrus". The pref key is stored for the agent's address only |
| Agent types the payee | on | Hint: "Memory has nothing about this payee yet …". Amount and memo stay empty, and nothing is sent |
| #3: agent, 5 USDT0 (typed by hand) | on | Allowed (balance 90 → 85). After the receipt, memory stored `CircuitWill payment of 5.000000 USDT0 to 0x3f40…: ALLOWED by circuits (decision #3).` with no memo |
| Agent types the payee again and adds a note | on | Hints: "1 earlier request(s) … allowed by circuits, 0 blocked", "Typical allowed amount … 5 USDT0", "Your note: …". The form fields other than **To** stay empty, there is no new activity entry, and decisions recorded stay at 3 |
| Reload, connect as owner, then as agent | per wallet | The owner is still off and `lib/memory.js` is not loaded. The agent is still on, and the hints come back from the stub |
| Agent turns memory off | off | Panel unmounted and hidden, flag removed, no console errors |

Decisions #1 and #2 match the Phase 3 record (same circuits, outcomes, balances and spent-today values; gas within
0.1%). No contract, circuit, ABI or artifact file was changed in this phase.

## Known limitations

- **Walrus Memory is a stub in the browser.** The dashboard's memory suggestions use a local `localStorage` stub,
  labelled as such on the page. The real SDK adapter (`createMemWalAdapter`, `scripts/memory-suggest.mjs`) is
  written against the documented API and tested with a fake client only: the package is not installed here and it
  has never talked to a Walrus relayer. See [Walrus Memory](#walrus-memory-optional-off-by-default).
- **Dashboard only exercised locally.** It has been exercised against a local anvil fork only. It is hosted on
  Vercel (<https://circuitwill.vercel.app/>), not on DeWEB, and needs a processor and circuit ids that exist on X Layer before it can create a real will.
- **One ERC-20 per escrow.** Native OKB is not supported.
- **TapeOut trust.** TapeOut is unaudited and owner-upgradeable. An upgrade could change `eval`. The escrow records
  the netlist hash and every input/output, but cannot prevent this. See `docs/TAPEOUT_INTERFACE.md`.
- **Fail closed can lock funds.** If the processor stops working, every transfer is blocked, withdrawals included,
  until the controller attaches a working circuit. With Daily Cap, at most `dailyCap` (≤ 4,294.967295 USDT0) can
  leave per UTC day.
- **The controller can change rules immediately.** For example, they can unfreeze, raise the cap, save a payee
  (skipping its cooling-off), confirm a payment, or detach circuits, and then withdraw. Per the PRD, the NFT owner
  controls the rule set. Freeze, cooling-off and confirmation therefore protect against the agent and against
  mistakes, not against a compromised controller wallet. There is no timelock, but every change is a public event.
- **Unknown payees.** A payee that was never added has age 0. With `coolingOffHours == 0` it can receive up to the
  trial limit.
- **One open confirmation per recipient.** Consuming a confirmation bumps that recipient's nonce, which invalidates any
  other confirmation for the same recipient (for example the same payee with a different amount). Re-confirm it.
- **Freeze without its circuit.** The freeze flag only acts through the Freeze circuit. `setFrozen(true)` reverts
  without one, but detaching the Freeze circuit while frozen lifts the freeze.
- **Circuit sizes.** Whitelist (237) and Confirmation (160) exceed the pinout document's targets (< 200, < 100); Daily
  Cap (447) exceeds < 150. Unsigned comparisons from 2-input NANDs cost about 5 gates per bit in these constructions.
- **Controller NFT hazards.** Do not transfer the controller NFT to the escrow's own address: no one could control
  it again. `safeTransferFrom` to the escrow reverts, but plain `transferFrom` does not. A burnable controller NFT
  would strand funds (`test_burnableControllerWouldStrandFunds`). Use `CircuitWillKey` or another non-burnable token.
- **Gas.** About 2.3M to 2.4M gas per call with four circuits on real TapeOut (fork). The starvation check is a
  heuristic: an eval counts as starved by the caller if it failed after using at least 15/16 of a limit below
  `evalGasLimit`. A circuit that reverts on purpose after burning that much would make an underfunded call revert
  instead of being recorded; with enough gas it gets its full budget and is recorded as REVERTED. A circuit that
  needs more than `evalGasLimit` (default 3M) is always recorded as REVERTED; raise it with `setEvalGasLimit`.
  The USDT0 transfer has no starvation check of its own: in the worst case it gets what is left of the 250k reserve
  (enough on the fork), and fails closed (`TRANSFER_FAILED`) if that is ever not enough.
- **Time.** The UTC day, payee age and confirmation expiry come from `block.timestamp` (the sequencer's clock).
- **Not recorded.** Requests that revert before a decision exists: unauthorized caller, zero amount, zero
  recipient, oversized memo.
- **Scripts only rehearsed locally.** `TapeOutCircuit.s.sol` and `Deploy.s.sol` ran successfully against a local
  anvil fork (full rehearsal passed, and the mainnet dry run on the latest block on 2026-11-20), never against
  X Layer itself; see "Rehearsal on a local anvil fork" and [`docs/MAINNET_RUNBOOK.md`](docs/MAINNET_RUNBOOK.md).
- **DeWEB hosting unconfirmed.** TapeOut's DeWEB (SiteRegistry) contracts exist on X Layer, but its spec covers BSC
  only, there is no publishing CLI, and the X Layer site URL form is undocumented. The TapeOut circuit explorer link
  format is also undocumented. See the runbook, step 10.
- **Lint.** `forge build` prints lint notes (reentrancy-events and reentrancy-no-eth, which `nonReentrant`
  covers; calls-loop for the single `controller()` lookup of the confirmation circuit; uninitialized-local for
  variables assigned in assembly; byte-extraction and `uint64(block.timestamp)` casts; block-timestamp). They were
  reviewed and left as is.
