# CircuitWill – Claude Implementation Handoff Brief

**Product:** CircuitWill  
**Version:** MVP v1  
**Date:** 19 November 2026  
**Goal:** Build a working MVP on X Layer where TapeOut circuits are the sole authority for payments.

---

## Your task

Implement the CircuitWill MVP exactly as specified below.  
Do not add features outside this brief unless they are required for the core flow to work.

## Core principle (non-negotiable)

**TapeOut circuits decide. Everything else is secondary.**  
No agent, no memory, no UI action may override or bypass a circuit result.

---

## 1. Contracts (X Layer)

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

## 2. Circuits

Tape out the four circuits defined in `CircuitWill_Circuit_Pinouts.md`.

- Daily Cap
- Payee Whitelist + Cooling-off
- Confirmation Threshold
- Freeze / Breaker

They must match the pinouts exactly. Test them thoroughly before integration.

## 3. Frontend / DeWEB

Build a simple DeWEB dashboard:

- Connect wallet
- Create / view CircuitWill
- Set circuit parameters
- Propose payment form
- Show recent decisions with re-evaluate button
- Clear labels: circuit decision is final

## 4. Walrus Memory (optional, do last)

If time remains:
- Add a toggle (default off).
- Agent can call Walrus Memory SDK for suggestions only.
- Never pass memory results into circuit inputs.
- Product must work 100% with memory disabled.

## 5. Success criteria you must meet

- [ ] Daily Cap of 50 blocks a payment of 60
- [ ] Same payment of 30 goes through
- [ ] Third party can re-evaluate a past decision from the event data
- [ ] Blocked proposals succeed as transactions, emit a complete decision event, and transfer no funds
- [ ] Daily spending resets on day change and increases only for allowed transfers
- [ ] Confirmation is bound to one exact payment and cannot be reused
- [ ] Circuit NFT transfer moves control
- [ ] Every outbound transfer, including owner withdrawals, is circuit-gated
- [ ] Works with Walrus Memory turned off

## 6. Deliverables

- Verified contracts on X Layer
- Circuit IDs and processor address
- DeWEB link
- Short demo video or test transactions
- README explaining how to re-evaluate a decision

## Hard constraints

- Do not let any off-chain component (agent, memory, frontend) change a circuit outcome.
- Keep circuits small.
- Fail closed: any error in circuit evaluation must block the payment.

Start with the escrow contract and one circuit (Daily Cap). Get a full allow/block cycle working before adding the others.

**End of handoff brief**
