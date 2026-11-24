# Rule suggestions: memory proposes, the owner approves, the escrow waits

**Status (2026-11-23): partly built on branch `feat/custom-rules`, not deployed.** The loosening delay is in
`CircuitWillEscrow` (`queueChange` / `applyChange` / `cancelChange`, `ruleDelay` 24 hours by default, 7-day apply
window) and the dashboard's "Waiting changes" card. Suggestions are built as **Suggest rules from my history** in the
custom rule builder (`frontend/lib/rule-suggest.js`): they come from the escrow's own decision history, stay in the
browser, only tighten, and never read memos. Suggestions drawn from Walrus Memory are not built. The rest of this
document is the original design, written 2026-11-21 against commit `4789d2a`.

## 1. Goal

Let CircuitWill's rules improve over time from the user's own history, without giving memory, the agent or anyone
other than the owner a way to change them.

Today the rules change only when the owner edits them by hand, and Walrus Memory only gives hints about the payee in
the "To" field. This design adds:

1. **Rule suggestions**: the dashboard notices patterns in past decisions and suggests a specific rule change, such
   as "save 0xABC… as a payee" or "lower your daily cap from 50 to 20".
2. **Owner approval**: a suggestion does nothing until the owner reviews it, saves it and signs the transaction from
   the wallet that holds the controller NFT.
3. **A delay on loosening**: any change that lets more money move waits `ruleDelay` (24 hours by default) before it
   takes effect. Any change that lets less money move applies at once.

## 2. What does not change

These rules from PRD section 7 and the README's Walrus Memory section stay as they are:

- Circuits make every payment decision. Nothing in this design is a circuit input.
- Memory is optional and off by default. With memory off the product works exactly as today. Rule suggestions that
  need no memory (section 4) still work.
- Memory never sends a transaction. Memory text never becomes a number or an address in a contract call (section 5
  explains how the suggested value is produced instead).
- The agent key still can only call `proposePayment`. It cannot queue, apply or cancel a rule change.

## 3. The trust problem this design has to solve

Memory is the easiest part of the system to tamper with. In the browser it is a `localStorage` stub that any script
or browser extension on the page origin can write to. On the agent side it is a relayer the user does not control. If
a poisoned memory says "you paid 0xEvil… twenty times", a naive engine would suggest saving 0xEvil… as a trusted
payee.

So the design follows one principle: **memory can point at evidence, but only the chain counts as evidence.** Every
suggestion cites decision ids. The dashboard re-reads each cited decision from the escrow's own `Decision` events
before showing the suggestion, and drops it if anything does not match. The delay on loosening is the second line of
defence: even a suggestion that gets through and is approved by mistake can be cancelled for 24 hours.

## 4. Where suggestions come from

A new module, `frontend/lib/rule-suggest.js`, holds one pure function:

```js
suggestRuleChanges({ decisions, rules, payees, notes, now }) // -> frozen array of suggestions
```

| Input | Source | Trusted? |
|---|---|---|
| `decisions` | `Decision`, `CircuitEvaluated` and `ConfirmationConsumed` events from the escrow, read over RPC | Yes, read from the chain |
| `rules`, `payees` | escrow views (`dailyCap`, `payees(addr)`, …) | Yes, read from the chain |
| `notes` | the user's own Walrus Memory notes about payees | No. Shown as text only, never used in a calculation |
| `now` | block timestamp of the latest block | Yes |

**What memory adds.** The dashboard reads decision events from only the last 10,000 blocks by default
(`DEFAULT_LOOKBACK` in `app.js`). Memory keeps a long history of decision summaries cheaply. When memory is on, the
dashboard recalls the decision ids memory knows about and fetches exactly those events from the chain
(`eth_getLogs` filtered on the indexed `decisionId` topic). That gives the engine months of history instead of hours.
Memory also carries the user's own notes, which appear beside a suggestion ("Your note: rent, monthly").

Memory therefore supplies **which decisions to look at, plus context**. It never supplies **what happened**. A
recalled id with no matching event on-chain, or with a different payee, amount or outcome, is dropped, and the panel
says "Memory returned 1 entry that does not match the chain; it was ignored."

With memory off, the engine runs on the decisions in the normal lookback window. Suggestions are fewer but still
work.

### Suggestion shape

```js
Object.freeze({
  id: 'save-payee:0xabc…',                      // stable, so a dismissed suggestion stays dismissed
  rule: 'payee' | 'dailyCap' | 'confirmationThreshold' | 'trialLimit' | 'coolingOffHours' | 'freeze',
  direction: 'tighten' | 'loosen',
  current: '50',                                 // USDT0 or hours, as shown today
  proposed: '20',
  target: '0xabc…' | null,                       // payee address for payee rules
  evidence: [12, 15, 19],                        // decision ids, each verified on-chain
  text: 'Your highest daily spend in the last 60 days was 14 USDT0. A cap of 20 still covers it.',
  applies: 'now' | 'after 24 h',
});
```

## 5. The suggestion catalogue

The first version uses fixed, explainable rules, not a model. Each one cites the decisions it is based on.

### Tighten (applies as soon as the owner saves it)

| # | Trigger | Suggestion |
|---|---|---|
| T1 | The highest daily total in the last 60 days is under 40% of `dailyCap`, with at least 10 allowed payments in that window | Lower `dailyCap` to the highest daily total × 1.25, rounded up to a whole USDT0 |
| T2 | A saved payee has had no allowed payment for 90 days | Unsave that payee (`setPayee(p, false)`); it keeps its `firstSeen`, so the trial limit still applies |
| T3 | 3 or more blocked proposals from the agent key within 1 hour | Freeze now (`setFrozen(true)`), shown at the top of the panel, not just in the list |
| T4 | No payment above `confirmationThreshold` in 60 days, and the highest payment is under half the threshold | Lower `confirmationThreshold` to the highest payment, rounded up |

### Loosen (applies only after `ruleDelay`)

| # | Trigger | Suggestion |
|---|---|---|
| L1 | 3 or more allowed payments to an unsaved payee, on at least 2 different days, and no blocked proposal to it in 30 days | Save the payee (`setPayee(p, true)`) |
| L2 | The Daily Cap circuit denied a payment on 2 or more days in the last 30, and each of those payments was then allowed within 48 hours (next day, or after a manual change) | Raise `dailyCap` to the smallest cap that would have allowed them, at most +50% per suggestion |
| L3 | 3 or more payments above `confirmationThreshold` in 30 days were confirmed by hand and paid, all to saved payees | Raise `confirmationThreshold` to the largest of those payments, at most +50% per suggestion |

**Never suggested.** These stay manual only, and the engine has no code path that produces them: unfreeze, detaching
a circuit, attaching a circuit, changing the agent key, changing `evalGasLimit`, shortening `ruleDelay`, raising
`trialLimit` and shortening `coolingOffHours`. They are either the safety switches themselves or changes rare enough
that the owner should decide them unprompted.

**Limits.** At most one open loosening suggestion per rule. The +50% step limit stops a single approval from opening
a rule wide. A suggestion the owner dismisses stays dismissed (by `id`, in `localStorage`) until its evidence changes.

## 6. The approval flow in the dashboard

1. Suggestions appear in a new block at the top of the **Edit rules** section. It uses the dashed "memory" styling,
   is labelled "Suggestion · non-binding", and lists tightening suggestions before loosening ones.
2. Each suggestion shows the current and proposed values, when the change applies ("now" or "after 24 h"), the cited
   decisions (each one links to the "Re-evaluate any decision" tool) and any of the user's notes.
3. **Review** scrolls to the matching rule form and fills in the proposed value. It does not submit. The owner can
   edit the value, then clicks **Save** (tighten) or **Queue** (loosen) and signs in the wallet.
   - The filled value comes from `rule-suggest.js`, which computes it from verified chain data. Memory text is never
     parsed into it. A test checks that `rule-suggest.js` has no imports and never reads a note when computing
     `proposed`.
4. **Dismiss** hides the suggestion.
5. Queued changes appear under **Pending changes** with a countdown, an **Apply** button once the delay has passed,
   and **Cancel**. Anyone who opens the escrow in the dashboard sees a notice above the rules: "1 rule change that
   loosens a limit is pending: daily cap 50 → 70, applies 22 Nov 14:05 UTC."

The agent-side script (`frontend/scripts/memory-suggest.mjs`) can print the same suggestions as text. It has no
wallet and no RPC write access, and the contract would reject it anyway.

## 7. Contract change: a delay on loosening

The escrow's own NatSpec says "There is no snapshot at proposal time and no timelock". This changes that for
loosening only.

### Classification

| Setter | Applies at once (tighten) | Must be queued (loosen) |
|---|---|---|
| `setDailyCap(v)` | `v <= dailyCap` | `v > dailyCap` |
| `setTrialLimit(v)` | `v <= trialLimit` | `v > trialLimit` |
| `setCoolingOffHours(v)` | `v >= coolingOffHours` | `v < coolingOffHours` |
| `setConfirmationThreshold(v)` | `v <= confirmationThreshold` | `v > confirmationThreshold` |
| `setPayee(p, saved)` | `saved == false`, or a new payee added unsaved (its own cooling-off is already a delay) | `saved == true` on a payee that is not saved yet |
| `removePayee(p)` | always | — |
| `setFrozen(f)` | `f == true` | `f == false` |
| `attachCircuit(...)` | always (one more circuit can only block more) | — |
| `detachCircuit(...)` | — | always |
| `setRuleDelay(d)` (new) | `d >= ruleDelay` | `d < ruleDelay` (waits the *old* delay) |
| `setAgent(a)` | `a == 0`, or no custom rule limits the owner but not the agent | `a != 0` while some custom rule limits the owner but not the agent (added in the 2026-11-24 security review) |
| `setEvalGasLimit`, `confirmPayment`, `revokeConfirmation` | unchanged | — |

`setAgent` is usually immediate because the agent can only propose payments, and every payment still has to pass the
circuits. The exception: a custom rule that limits only the owner would not limit a new agent, so naming one then waits. `confirmPayment` stays immediate because it is the owner approving one exact payment, which is already the
purpose of the Confirmation circuit.

A loosening call to an existing setter reverts with `LooseningIsDelayed()`, so the existing dashboard cannot loosen by
accident.

**Setup is immediate.** While no circuit is attached, every transfer is already blocked (`NO_CIRCUITS`), so loosening
cannot move money and all setters apply at once. The create flow in `app.js` currently interleaves "set" and
"attach" steps. It must be reordered to set every parameter first and attach circuits last. Detaching the last
circuit (itself delayed) brings the escrow back into this setup state.

### New state and functions

```solidity
enum ChangeKind { DAILY_CAP, TRIAL_LIMIT, COOLING_OFF_HOURS, CONFIRMATION_THRESHOLD, SAVE_PAYEE, UNFREEZE, DETACH_CIRCUIT, RULE_DELAY }

struct PendingChange {
    ChangeKind kind;
    address target;     // payee for SAVE_PAYEE, else zero
    uint256 value;      // new value; the CircuitKind for DETACH_CIRCUIT (by kind, not by index: indexes move)
    uint64 eta;         // earliest apply time
    address queuedBy;   // must still own the controller NFT when applied
}

uint256 public constant DEFAULT_RULE_DELAY = 24 hours;
uint256 public constant MIN_RULE_DELAY = 1 hours;
uint256 public constant MAX_RULE_DELAY = 30 days;
uint256 public constant APPLY_WINDOW = 7 days; // a change not applied within 7 days after eta expires

uint256 public ruleDelay = DEFAULT_RULE_DELAY;
uint256 public changeCount;
mapping(uint256 changeId => PendingChange) public pendingChanges;

function queueChange(ChangeKind kind, address target, uint256 value) external onlyController returns (uint256 changeId);
function applyChange(uint256 changeId) external onlyController;   // eta <= now <= eta + APPLY_WINDOW
function cancelChange(uint256 changeId) external onlyController;

event ChangeQueued(uint256 indexed changeId, ChangeKind kind, address target, uint256 value, uint64 eta, address indexed by);
event ChangeApplied(uint256 indexed changeId, address indexed by);
event ChangeCancelled(uint256 indexed changeId, address indexed by);
```

`queueChange` checks ranges with the same rules as the setters (for example `value <= type(uint32).max`), so a bad
change fails when it is queued, not 24 hours later. `applyChange` writes the value and emits the existing event
(`DailyCapSet`, `PayeeSet`, …), so the dashboard and indexers keep working.

**Who can apply.** Only the controller, and only if `queuedBy` still owns the controller NFT. That is the same rule
already used for `agentSetBy`. If the NFT moves to a new wallet, every change the old owner queued dies with it.

**What the delay protects against, and what it does not.**

- *Protects:* a manipulated agent, a poisoned memory or a social-engineering message persuading the owner to loosen
  a rule in a hurry. The owner has 24 hours to notice and cancel, and the public notice on the dashboard lets anyone
  else watching the escrow see the change coming.
- *Does not protect:* a thief who controls the wallet holding the NFT. They can also cancel the owner's cancellations,
  or move the NFT. They still have to wait `ruleDelay` before any loosening applies, which is time for monitoring to
  raise an alarm. A guardian or recovery key is a separate design, out of scope here.

### Contract tests to add

- Each setter: tightening applies at once; loosening reverts with `LooseningIsDelayed`; equal values apply at once.
- Before the first `attachCircuit`, every setter applies at once.
- `queueChange` → `applyChange` before `eta` reverts; at `eta` it applies and emits the original setter's event.
- After `eta + APPLY_WINDOW`, `applyChange` reverts with `ChangeExpired`.
- `cancelChange` removes the change; applying it then reverts.
- After the NFT is transferred, applying a change queued by the old owner reverts.
- `DETACH_CIRCUIT` detaches by kind, including when other detaches have moved indexes since it was queued.
- Shortening `ruleDelay` waits the old delay; lengthening it applies at once.
- The agent key cannot call `queueChange`, `applyChange` or `cancelChange`.
- A payment proposed while a loosening is pending is decided under the old rule.

## 8. Frontend tests to add

- `rule-suggest.js` has no imports and no reference to ethers, `fetch`, the DOM or storage (same style as the existing
  checks in `memory.test.mjs`).
- Every trigger in section 5, at its boundary values, with fixed decision lists.
- Notes never change `proposed`: the same decisions with and without notes give the same values.
- A recalled decision id that is missing on-chain, or whose payee, amount or outcome differs, is dropped and counted.
- No code path produces a "never suggested" change.
- **Review** fills exactly one rule input and triggers no submit, click or transaction (fake-DOM trap, as in the
  existing memory tests).
- With memory off, `lib/memory.js` is still never requested, and suggestions still come from the lookback window.

## 9. Delivery

Each step is usable without the next one.

1. **Contract delay** (`CircuitWillEscrow.sol`, tests, `artifacts.js`, create-flow reorder, Pending changes UI).
   This must land **before the mainnet deployment**, because the escrow is not upgradeable. Re-run the fork dry run
   and update the gas figures in `docs/MAINNET_RUNBOOK.md`.
2. **Suggestions without memory** (`lib/rule-suggest.js`, suggestions block, Review and Dismiss). Uses chain data
   from the normal lookback window only.
3. **Memory as an index** (`lib/memory.js` recalls decision ids, the dashboard verifies them on-chain, notes appear
   beside suggestions, the agent-side script prints suggestions).

## 10. Open decisions

- **Default delay.** 24 hours is proposed. A shorter delay is easier to live with; a longer one gives more time to
  catch a mistake.
- **Who can apply.** This design allows only the controller. Allowing anyone to apply after the delay would let a
  keeper bot finish changes for the owner, but would remove the owner's last chance to change their mind at apply
  time.
- **Unfreeze delay.** Treating unfreeze as loosening means an owner who freezes by mistake waits 24 hours. That is
  the point of a breaker, but it should be stated in the dashboard next to the Freeze button.
