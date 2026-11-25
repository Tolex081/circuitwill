# CircuitWill: original specification

The design documents CircuitWill was built from (19 November 2026), kept together in one file. The README and
[`TECHNICAL.md`](TECHNICAL.md) describe what was actually built, including where it differs from these plans (for
example, circuit gate counts above the pinout targets).

1. [Product definition (PRD)](#part-1-product-definition-prd)
2. [Circuit pinouts](#part-2-circuit-pinouts): code comments that cite `CircuitWill_Circuit_Pinouts.md, section N` mean this part
3. [Risk and edge-case matrix](#part-3-risk-and-edge-case-matrix)
4. [UI wireframes](#part-4-ui-wireframes)
5. [Implementation brief](#part-5-implementation-brief): other documents' "handoff section N" means this part


## Part 1: Product definition (PRD)


**Product name:** CircuitWill

**One-sentence description:**  
CircuitWill is a personal money will made of TapeOut circuits on X Layer. Your rules decide whether money can move. An AI agent can suggest, but it cannot override the circuits.

### 1. Overview
A user-owned “money constitution” built from small TapeOut circuits on X Layer.  
AI agents (or the user) may only move money when the circuits explicitly allow it.  
Rules are public, immutable, and independently re-evaluable.  
Optional Walrus Memory side feature lets the agent recall past context to make better *suggestions* only. Memory never overrides a circuit.

### 2. Problem
Users want AI help with payments and personal finance but refuse to give agents unrestricted spending power. Soft limits and prompts are easy to socially engineer. Existing tools (e.g. Fusebox) focus mainly on scam protection for agents. There is no simple, ownable, shareable set of real-life money rules that apply to both agents and humans.

### 3. Target users
- Crypto-native individuals and small teams who use or plan to use AI agents for payments.
- People who want hard, inspectable rules (“never cancel insurance”, “auto-save 10%”, “new payee requires confirmation”).
- Circuit designers who want their rule circuits to earn small fees when used.

### 4. Goals
- TapeOut circuits are the final, non-bypassable authority for every payment.
- User can create, select, or attach rule circuits and transfer ownership via the circuit NFT.
- Agent can propose payments and (optionally) use memory to improve suggestions.
- Full product works even if Walrus Memory is disabled or unavailable.
- Clear, public decision log.

### 5. Non-goals (v1)
- Full bank account integration or fiat rails.
- Complex multi-party legal contracts.
- Memory that can change or relax circuit outcomes.
- Large circuits or heavy on-chain computation.

### 6. Core features (MVP)

#### Must have
- User can attach 1–4 pre-built TapeOut rule circuits to a dedicated wallet/escrow on X Layer.
- Circuits cover: daily spending cap, whitelist + cooling-off for new payees, confirmation threshold, freeze/breaker switch.
- Agent or user proposes a payment → contracts build circuit inputs from on-chain state → circuits evaluate → payment proceeds only if all return “yes”.
- Public log of every decision with enough data for anyone to re-evaluate the circuits.
- Circuit NFT ownership = control of the rule set and associated container/wallet.
- DeWEB dashboard showing active rules, recent decisions, and simple proposal flow.
- Optional Walrus Memory toggle (off by default).

#### Should have (if time)
- Simple rule template selector.
- Agent suggestion text that references recalled memory.
- Basic timeout and refund path on the escrow.

### 7. Walrus Memory boundaries (hard rules)
- Memory is strictly advisory.
- No memory result may be used as an input to a TapeOut circuit.
- No memory result may change, delay, or override a circuit decision.
- If memory is unavailable, the flow continues unchanged.
- Only short, non-sensitive summaries are stored unless the user explicitly opts in for more.
- Clear UI copy: “Suggestion based on past behaviour. Your circuits make the final decision.”

### 8. User journeys

#### Journey 1: Create a CircuitWill
1. User connects X Layer wallet.
2. Chooses “Create CircuitWill”.
3. Selects which of the four circuits to attach and sets parameters (cap amount, cooling-off hours, confirmation threshold, etc.).
4. System deploys or configures an escrow that holds funds and stores the circuit NFT contract address and token ID.
5. The user keeps the circuit NFT in their wallet; the escrow reads its current owner to determine control.
6. User funds the wallet with USDT0 or OKB.
7. Optional: user enables Walrus Memory and completes simple delegate key setup.
8. Dashboard shows active rules and balance.

#### Journey 2: Agent proposes a payment
1. Agent receives a payment request (or user describes it).
2. If Walrus Memory is enabled, agent recalls relevant past summaries and shows a suggestion:  
   “You’ve rejected similar new payees recently. Want me to ask you first?”
3. User reviews the suggestion and the proposed payment details.
4. User clicks “Submit to CircuitWill”.
5. Transaction is sent to the X Layer escrow.
6. Escrow builds circuit inputs from current on-chain state and calls the TapeOut circuits.
7. If all circuits return yes → payment is sent, daily spending is updated, and any one-time payment confirmation is consumed.  
   If any circuit returns no → the transaction succeeds without transferring funds, and the blocked decision is written to the public log. The contract must not revert, because that would erase the event.
8. The decision is written to the public log with all inputs and circuit results.
9. Optional: agent stores a short non-sensitive summary in Walrus Memory.

#### Journey 3: User initiates payment manually
Same as Journey 2, but the user fills the payment form themselves. Memory suggestions still appear if enabled.

#### Journey 4: Transfer ownership
1. Current owner transfers the circuit NFT from their wallet to a new address.
2. Control of the rules and remaining funds moves with the NFT.
3. New owner can update parameters or add/remove circuits according to the contract rules.

### 9. Architecture outline

- **X Layer contracts**  
  - `CircuitWillEscrow`: holds funds and stores the circuit NFT contract address and token ID. The NFT stays in its owner's wallet.  
    Agent key can only call `proposePayment`.  
    On propose: validate → reset daily spending if the day changed → build inputs → evaluate each circuit → transfer and update spending if all allow, or record and return without transfer if any blocks. Blocked proposals do not revert, so their event data remains on-chain.  
    Records the complete decision and all inputs.
  - Management and withdrawal calls require `circuitNFT.ownerOf(tokenId) == msg.sender`. Because the NFT remains outside escrow custody, transferring it in the wallet transfers rule-management and withdrawal authority immediately. The previous owner loses that authority.

- **TapeOut**  
  - Small circuits (tens to low hundreds of gates).  
  - Inputs: amount, spent today, payee saved status/age, confirmation bits, freeze flag, etc.  
  - Output: single bit (allow/block).

- **DeWEB**  
  - Dashboard for rules, balance, proposal form, decision history, re-evaluation links.
  - Clear visual separation: “Suggestion (from memory)” vs “Circuit decision”.

- **Walrus Memory (optional side path)**  
  - Agent uses TypeScript SDK with delegate key.  
  - Separate from payment path.  
  - Used only for suggestions and context.

- **Ownership**  
- The escrow stores the NFT contract address and token ID but does not custody the NFT. Its current owner controls rule management and may request withdrawals.

#### MVP state rules

- Escrow tracks `spentToday` and `lastResetDay`. It calculates `uint32 day = uint32(block.timestamp / 86400)`; daily spending resets at 00:00 UTC when this day value changes. Before each outbound transfer, it packs the current total into the Daily Cap circuit. It adds the amount only after an allowed transfer.
- Every outbound transfer, including owner withdrawals, uses the same circuit evaluation path. A withdrawal denied by any circuit leaves funds in escrow and records the blocked decision; there is no owner withdrawal bypass.
- The current NFT owner confirms an exact payment using `confirmPayment(bytes32 paymentHash)`. The hash binds recipient, amount, nonce, and the chain/escrow domain. The confirmation is one-time and expires after a short period; it is consumed after use.
- A blocked proposal succeeds as a transaction, emits `PaymentBlocked` and a complete `Decision` record, and leaves the funds in escrow.

### 10. MVP circuits to implement first
1. Daily Cap  
2. Payee Whitelist + Cooling-off  
3. Confirmation Threshold (human must approve above X)  
4. Freeze / Breaker switch

### 11. Success criteria for MVP
- User can attach circuits and fund the wallet.
- A payment is blocked when a circuit says no (demonstrable on X Layer).
- A payment goes through when all circuits say yes.
- Decision can be re-evaluated by a third party.
- Product is fully usable with Walrus Memory turned off.
- Ownership transfer via circuit NFT works.

### 12. Risks and mitigations
- Memory influencing circuit → hard architectural separation + UI language.  
- Circuit size / gas → keep circuits small and tested.  
- Version freezing → submit hash snapshot before review; revoke operator rights or mediate writes via escrow.  
- Key management for Walrus → simple optional onboarding; product works without it.  
- User confusion → explicit “circuits decide” messaging everywhere.

---

**Document version:** CircuitWill PRD v1  
**Date:** 19 November 2026  
**Status:** Ready for implementation handoff

## Part 2: Circuit pinouts


**Product:** CircuitWill  
**Version:** MVP v1  
**Date:** 19 November 2026

All circuits are small pure functions (or with minimal LATCH where needed).  
They receive packed inputs from the escrow contract and return a single allow bit (1 = allow, 0 = block).

Amounts are handled in the smallest unit of the token (or a scaled integer).  
All circuits must be deterministic and re-evaluable.

Amount and cap values are `uint32`. With 6-decimal USDT0, the maximum is 4,294.967295 USDT0 per value. Higher values are out of scope for MVP.

---

### 1. Daily Cap

**Purpose:** Block if (spent_today + amount) > daily_cap.

**Inputs (suggested packing):**
- bits 0-31: amount (uint32)
- bits 32-63: spent_today (uint32)
- bits 64-95: daily_cap (uint32)

**Output:**
- bit 0: 1 if (spent_today + amount) <= daily_cap, else 0

**Example logic (pseudocode):**
sum = spent_today + amount allow = (sum <= daily_cap) ? 1 : 0


**Notes:**
- Use saturating addition or explicit overflow check if needed.
- Target size: < 150 gates.

---

### 2. Payee Whitelist + Cooling-off

**Purpose:** Allow if payee is already saved, or if new payee and (amount <= trial_limit AND age >= cooling_off).

**Inputs:**
- bit 0: is_saved (1 = yes)
- bits 1-16: age_hours (uint16)
- bits 17-48: amount (uint32)
- bits 49-80: trial_limit (uint32)
- bits 81-96: cooling_off_hours (uint16)

**Output:**
- bit 0: 1 = allow, 0 = block

**Example logic:**
if is_saved == 1: allow = 1 else: allow = (amount <= trial_limit) AND (age_hours >= cooling_off_hours)


**Notes:**
- Age is calculated by the escrow (current block timestamp - first seen).
- Target size: < 200 gates.

---

### 3. Confirmation Threshold

**Purpose:** If amount > threshold, require a confirmation bit; otherwise allow.

**Inputs:**
- bits 0-31: amount (uint32)
- bits 32-63: threshold (uint32)
- bit 64: confirmed (1 = human confirmed this exact payment)

**Output:**
- bit 0: 1 = allow, 0 = block

**Example logic:**
if amount <= threshold: allow = 1 else: allow = confirmed


**Notes:**
- Confirmation is a one-time bit set by the owner for this specific payment hash.
- Target size: < 100 gates.

---

### 4. Freeze / Breaker

**Purpose:** Hard stop. If freeze flag is set, block everything.

**Inputs:**
- bit 0: freeze_flag (1 = frozen)

**Output:**
- bit 0: 0 if freeze_flag == 1, else 1

**Example logic:**
allow = (freeze_flag == 0) ? 1 : 0


**Notes:**
- Can be implemented with a LATCH if the freeze state needs to persist across calls, or as a pure function if the escrow stores the flag.
- Target size: < 20 gates.

---

### Implementation notes for Claude

- Circuits are taped out on TapeOut (X Layer).
- Escrow contract calls `eval` or `step` on the processor for each attached circuit ID.
- Input packing must be identical between contract and circuit.
- All circuits must be tested with edge values (0, max uint, exact threshold, etc.).
- Designer fee mechanism can be added later; not required for MVP.

**End of pinouts document**

## Part 3: Risk and edge-case matrix


**Product:** CircuitWill  
**Version:** MVP v1  
**Date:** 19 November 2026

| Risk / Edge Case | Impact | Likelihood | Mitigation | Owner |
|------------------|--------|------------|------------|-------|
| Memory result influences or overrides a circuit decision | Critical – breaks core promise | Low (if architecture followed) | Hard separation: memory never passed as circuit input. UI always states “circuits decide”. Code review checklist. | Contract + Frontend |
| Circuit evaluation fails or reverts unexpectedly | High – payments stuck or wrongly blocked | Medium | Fail closed: any evaluation error blocks payment. Record the blocked decision and inputs without reverting so the event persists. Emit a clear error/result and test edge inputs. | Contract |
| Input packing mismatch between escrow and circuit | High – wrong allow/block | Medium | Shared constants / library for packing. Automated tests that pack in contract and unpack in circuit test. | Contract + Circuit |
| Daily cap overflow or precision issues | Medium | Low | Use checked math or saturating add. Test max values. Document unit scaling. | Circuit |
| Payee age calculation wrong (timestamp issues) | Medium | Medium | Escrow calculates age and passes clean integer. Test with block timestamps. | Contract |
| Confirmation bit can be reused or forged | High | Low | Current NFT owner confirms a hash bound to recipient, amount, nonce, and chain/escrow domain. Enforce one-time use and short expiry; consume after use. | Contract |
| Freeze flag not respected | Critical | Low | Simplest circuit. Test independently. | Circuit |
| Circuit NFT transfer does not move control | High | Medium | Escrow stores the NFT contract and token ID but does not custody the NFT. Check `ownerOf(tokenId) == msg.sender` on management and withdrawal calls so control follows wallet transfers immediately. | Contract |
| Circuit NFT is burned or stops reporting an owner | Critical | Low | Require a non-burnable NFT or prevent burning while the escrow has funds; otherwise owner checks can fail and strand funds. | Contract + NFT |
| Owner withdrawal bypasses circuit rules | Critical | Medium | Route every outbound transfer, including withdrawals, through the same circuit evaluation path. A denied withdrawal records the decision and moves no funds. | Contract |
| User confuses suggestion with decision | Medium | High | Strong UI language and visual separation. “Suggestion” badge vs “Circuit Decision” badge. | Frontend |
| Walrus Memory down or key issues | Low | Medium | Feature is optional and default off. Flow continues normally if call fails. | Agent / Frontend |
| Gas limits on multi-circuit evaluation | Medium | Medium | Limit to 4 circuits. Measure gas. Optimise packing. | Contract |
| Front-running or proposal manipulation | Medium | Low | Decisions based only on on-chain state at execution time. No off-chain trust. | Contract |
| Parameter update after proposal but before execution | Medium | Low | Parameters read at execution time, or snapshot parameters with proposal. Document behaviour. | Contract |
| Empty or zero-amount payments | Low | Medium | Explicit reject of amount == 0. | Contract |
| Re-evaluation data incomplete | Medium | Low | Both allowed and blocked decisions must persist with all inputs and circuit results. Blocked proposals return without reverting; a revert would erase their event. Document re-evaluation steps in README. | Contract |
| Daily spending reset or accounting is wrong | High | Medium | Escrow computes the UTC day as `uint32(block.timestamp / 86400)`, resets at 00:00 UTC when it changes, and increments only after an allowed outbound transfer. | Contract |
| Packed values exceed pinout widths | High | Medium | Reject out-of-range amounts and parameters before packing; never truncate. Check arithmetic overflow explicitly. | Contract + Circuit |

### Critical non-negotiables

1. Circuits are the only authority.
2. Fail closed on any uncertainty.
3. All decisions must be publicly re-evaluable from on-chain data.
4. Walrus Memory is strictly advisory and optional.

**End of risk matrix**

## Part 4: UI wireframes


**Product:** CircuitWill  
**Version:** MVP v1  
**Date:** 19 November 2026

Simple, clear DeWEB dashboard. Focus on trust and clarity: circuits decide.

---

### Screen 1: Home / Connect

- Large title: **CircuitWill**
- Subtitle: “Your rules decide. Circuits cannot be talked around.”
- [Connect Wallet] button
- Short explanation: “Create a personal money will on X Layer using TapeOut circuits.”

---

### Screen 2: Dashboard (main)

**Header**
- CircuitWill ID / short address
- Connected wallet
- [Disconnect]

**Balance card**
- Current balance (USDT0)
- [Fund] button

**Active Rules card**
- List of attached circuits with current parameters:
  - Daily Cap: 50 USDT0
  - Payee Cooling-off: 24 hours
  - Confirmation above: 20 USDT0
  - Freeze: Off
- [Edit Rules] button

**Propose Payment card**
- To: [address input]
- Amount: [number input]
- Memo: [text input]
- Optional suggestion box (only if Walrus Memory enabled):  
  “Suggestion: You’ve rejected similar new payees recently.”
- Big [Submit to CircuitWill] button
- Small text under button: “Final decision is made by your circuits.”

**Recent Decisions**
- Table or list:
  - Time
  - To
  - Amount
  - Result (Allowed / Blocked)
  - Which circuit blocked (if any)
  - [Re-evaluate] button
- Each row expandable to show full inputs used.

---

### Screen 3: Edit Rules

- Toggle each of the four circuits on/off
- Input fields for parameters
- [Save Rules] button
- Warning: “Changing rules takes effect on the next payment.”

---

### Screen 4: Decision Detail / Re-evaluate

- Full payment details
- All inputs that were packed
- Circuit results (one by one)
- [Re-run Evaluation] button that calls the processor again
- Link to TapeOut circuit explorer

---

### Visual rules

- Green = Allowed by circuits
- Red = Blocked by circuits
- Blue / neutral = Suggestion (memory)
- Always show the sentence: “Circuits make the final decision.”
- No dark patterns. No “agent approved” language.

---

### Mobile notes

- Stack cards vertically
- Large tap targets for Submit and Re-evaluate
- Decision result must be visible without scrolling on mobile

**End of UI wireframes**

## Part 5: Implementation brief


**Product:** CircuitWill  
**Version:** MVP v1  
**Date:** 19 November 2026  
**Goal:** Build a working MVP on X Layer where TapeOut circuits are the sole authority for payments.

---

### Your task

Implement the CircuitWill MVP exactly as specified below.  
Do not add features outside this brief unless they are required for the core flow to work.

### Core principle (non-negotiable)

**TapeOut circuits decide. Everything else is secondary.**  
No agent, no memory, no UI action may override or bypass a circuit result.

---

### 1. Contracts (X Layer)

Create `CircuitWillEscrow.sol`:

- Holds funds and stores the configured circuit NFT contract address and token ID. The circuit NFT remains in its owner's wallet; the escrow must not take custody of it.
- Owner can set/update the list of attached circuit IDs (max 4).
- Owner can set parameters that the escrow will pack into circuit inputs.
- Agent key (or current circuit NFT owner) can call `proposePayment(address to, uint256 amount, string memo)`.
- On propose:
  1. Build packed inputs for each attached circuit from current on-chain state.
  2. Call TapeOut processor `eval` or `step` for every circuit.
  3. If any circuit returns 0, record the blocked decision, emit `PaymentBlocked` with the payment details, circuit results, and all inputs used, then return without transferring funds. Do not revert: a revert would erase the event and decision record.
  4. If all return 1 → transfer tokens, update daily spending, consume any applicable one-time confirmation, and emit `PaymentAllowed`.
- Emit a detailed `Decision` event containing all inputs and results used so anyone can re-evaluate. A circuit denial (including a caught evaluation error) must record the blocked decision and return without transferring funds; do not revert, because a revert erases the event.
- Store the configured NFT contract address and token ID. On every management call and withdrawal, require `circuitNFT.ownerOf(tokenId) == msg.sender`. The NFT remains outside escrow custody. A normal NFT transfer immediately transfers rule-management and fund-withdrawal authority to its new owner; the old owner loses that authority.
- The configured NFT must remain existent and queryable while the escrow has funds. Use a non-burnable token or prevent burning until the escrow is empty; otherwise `ownerOf` can fail and strand funds without an authorized controller.
- Every outbound transfer, including `withdraw(address to, uint256 amount)`, must use the same circuit evaluation path as a proposed payment. A withdrawal is not an escape hatch: if any circuit denies it, record the denial and move no funds. Only the current NFT owner may request a withdrawal, and successful withdrawals count toward `spentToday`.
- Before packing, reject any amount, cap, threshold, or trial limit that exceeds its pinout width; never silently truncate a `uint256` to `uint32`. Check arithmetic overflow explicitly. With 6-decimal USDT0, each `uint32` amount/cap value tops out at 4,294.967295 USDT0.
- Track `spentToday` and `lastResetDay` in the escrow. Calculate `uint32 day = uint32(block.timestamp / 86400)`. At the start of each outbound transfer, if `day != lastResetDay`, set `spentToday = 0` and `lastResetDay = day`; pack the current `spentToday` into the circuit inputs. Increase it only after an allowed transfer succeeds.
- The current NFT owner confirms an exact payment with `confirmPayment(bytes32 paymentHash)`. The escrow makes the confirmation available to the Confirmation Threshold circuit only for that payment, and consumes it after use or expiry. Bind the hash to the recipient, amount, and a nonce (and chain/escrow domain) so it cannot be reused for a different payment.

Use OpenZeppelin where helpful. Target X Layer (chain ID 196).

### 2. Circuits

Tape out the four circuits defined in Part 2 (circuit pinouts).

- Daily Cap
- Payee Whitelist + Cooling-off
- Confirmation Threshold
- Freeze / Breaker

They must match the pinouts exactly. Test them thoroughly before integration.

### 3. Frontend / DeWEB

Build a simple DeWEB dashboard:

- Connect wallet
- Create / view CircuitWill
- Set circuit parameters
- Propose payment form
- Show recent decisions with re-evaluate button
- Clear labels: circuit decision is final

### 4. Walrus Memory (optional, do last)

If time remains:
- Add a toggle (default off).
- Agent can call Walrus Memory SDK for suggestions only.
- Never pass memory results into circuit inputs.
- Product must work 100% with memory disabled.

### 5. Success criteria you must meet

- [ ] Daily Cap of 50 blocks a payment of 60
- [ ] Same payment of 30 goes through
- [ ] Third party can re-evaluate a past decision from the event data
- [ ] Blocked proposals succeed as transactions, emit a complete decision event, and transfer no funds
- [ ] Daily spending resets on day change and increases only for allowed transfers
- [ ] Confirmation is bound to one exact payment and cannot be reused
- [ ] Circuit NFT transfer moves control
- [ ] Every outbound transfer, including owner withdrawals, is circuit-gated
- [ ] Works with Walrus Memory turned off

### 6. Deliverables

- Verified contracts on X Layer
- Circuit IDs and processor address
- DeWEB link
- Short demo video or test transactions
- README explaining how to re-evaluate a decision

### Hard constraints

- Do not let any off-chain component (agent, memory, frontend) change a circuit outcome.
- Keep circuits small.
- Fail closed: any error in circuit evaluation must block the payment.

Start with the escrow contract and one circuit (Daily Cap). Get a full allow/block cycle working before adding the others.

**End of handoff brief**
