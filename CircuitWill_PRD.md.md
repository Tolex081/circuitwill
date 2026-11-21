# CircuitWill – Product Definition & PRD

**Product name:** CircuitWill

**One-sentence description:**  
CircuitWill is a personal money will made of TapeOut circuits on X Layer. Your rules decide whether money can move. An AI agent can suggest, but it cannot override the circuits.

## 1. Overview
A user-owned “money constitution” built from small TapeOut circuits on X Layer.  
AI agents (or the user) may only move money when the circuits explicitly allow it.  
Rules are public, immutable, and independently re-evaluable.  
Optional Walrus Memory side feature lets the agent recall past context to make better *suggestions* only. Memory never overrides a circuit.

## 2. Problem
Users want AI help with payments and personal finance but refuse to give agents unrestricted spending power. Soft limits and prompts are easy to socially engineer. Existing tools (e.g. Fusebox) focus mainly on scam protection for agents. There is no simple, ownable, shareable set of real-life money rules that apply to both agents and humans.

## 3. Target users
- Crypto-native individuals and small teams who use or plan to use AI agents for payments.
- People who want hard, inspectable rules (“never cancel insurance”, “auto-save 10%”, “new payee requires confirmation”).
- Circuit designers who want their rule circuits to earn small fees when used.

## 4. Goals
- TapeOut circuits are the final, non-bypassable authority for every payment.
- User can create, select, or attach rule circuits and transfer ownership via the circuit NFT.
- Agent can propose payments and (optionally) use memory to improve suggestions.
- Full product works even if Walrus Memory is disabled or unavailable.
- Clear, public decision log.

## 5. Non-goals (v1)
- Full bank account integration or fiat rails.
- Complex multi-party legal contracts.
- Memory that can change or relax circuit outcomes.
- Large circuits or heavy on-chain computation.

## 6. Core features (MVP)

### Must have
- User can attach 1–4 pre-built TapeOut rule circuits to a dedicated wallet/escrow on X Layer.
- Circuits cover: daily spending cap, whitelist + cooling-off for new payees, confirmation threshold, freeze/breaker switch.
- Agent or user proposes a payment → contracts build circuit inputs from on-chain state → circuits evaluate → payment proceeds only if all return “yes”.
- Public log of every decision with enough data for anyone to re-evaluate the circuits.
- Circuit NFT ownership = control of the rule set and associated container/wallet.
- DeWEB dashboard showing active rules, recent decisions, and simple proposal flow.
- Optional Walrus Memory toggle (off by default).

### Should have (if time)
- Simple rule template selector.
- Agent suggestion text that references recalled memory.
- Basic timeout and refund path on the escrow.

## 7. Walrus Memory boundaries (hard rules)
- Memory is strictly advisory.
- No memory result may be used as an input to a TapeOut circuit.
- No memory result may change, delay, or override a circuit decision.
- If memory is unavailable, the flow continues unchanged.
- Only short, non-sensitive summaries are stored unless the user explicitly opts in for more.
- Clear UI copy: “Suggestion based on past behaviour. Your circuits make the final decision.”

## 8. User journeys

### Journey 1: Create a CircuitWill
1. User connects X Layer wallet.
2. Chooses “Create CircuitWill”.
3. Selects which of the four circuits to attach and sets parameters (cap amount, cooling-off hours, confirmation threshold, etc.).
4. System deploys or configures an escrow that holds funds and stores the circuit NFT contract address and token ID.
5. The user keeps the circuit NFT in their wallet; the escrow reads its current owner to determine control.
6. User funds the wallet with USDT0 or OKB.
7. Optional: user enables Walrus Memory and completes simple delegate key setup.
8. Dashboard shows active rules and balance.

### Journey 2: Agent proposes a payment
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

### Journey 3: User initiates payment manually
Same as Journey 2, but the user fills the payment form themselves. Memory suggestions still appear if enabled.

### Journey 4: Transfer ownership
1. Current owner transfers the circuit NFT from their wallet to a new address.
2. Control of the rules and remaining funds moves with the NFT.
3. New owner can update parameters or add/remove circuits according to the contract rules.

## 9. Architecture outline

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

### MVP state rules

- Escrow tracks `spentToday` and `lastResetDay`. It calculates `uint32 day = uint32(block.timestamp / 86400)`; daily spending resets at 00:00 UTC when this day value changes. Before each outbound transfer, it packs the current total into the Daily Cap circuit. It adds the amount only after an allowed transfer.
- Every outbound transfer, including owner withdrawals, uses the same circuit evaluation path. A withdrawal denied by any circuit leaves funds in escrow and records the blocked decision; there is no owner withdrawal bypass.
- The current NFT owner confirms an exact payment using `confirmPayment(bytes32 paymentHash)`. The hash binds recipient, amount, nonce, and the chain/escrow domain. The confirmation is one-time and expires after a short period; it is consumed after use.
- A blocked proposal succeeds as a transaction, emits `PaymentBlocked` and a complete `Decision` record, and leaves the funds in escrow.

## 10. MVP circuits to implement first
1. Daily Cap  
2. Payee Whitelist + Cooling-off  
3. Confirmation Threshold (human must approve above X)  
4. Freeze / Breaker switch

## 11. Success criteria for MVP
- User can attach circuits and fund the wallet.
- A payment is blocked when a circuit says no (demonstrable on X Layer).
- A payment goes through when all circuits say yes.
- Decision can be re-evaluated by a third party.
- Product is fully usable with Walrus Memory turned off.
- Ownership transfer via circuit NFT works.

## 12. Risks and mitigations
- Memory influencing circuit → hard architectural separation + UI language.  
- Circuit size / gas → keep circuits small and tested.  
- Version freezing → submit hash snapshot before review; revoke operator rights or mediate writes via escrow.  
- Key management for Walrus → simple optional onboarding; product works without it.  
- User confusion → explicit “circuits decide” messaging everywhere.

---

**Document version:** CircuitWill PRD v1  
**Date:** 19 November 2026  
**Status:** Ready for implementation handoff
