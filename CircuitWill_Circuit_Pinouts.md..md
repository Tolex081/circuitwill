File 1 created: CircuitWill_Circuit_Pinouts.md

Copy the content below into CircuitWill_Circuit_Pinouts.md.

markdown
# CircuitWill – Exact Circuit Pinouts & Example Netlist Descriptions

**Product:** CircuitWill  
**Version:** MVP v1  
**Date:** 19 November 2026

All circuits are small pure functions (or with minimal LATCH where needed).  
They receive packed inputs from the escrow contract and return a single allow bit (1 = allow, 0 = block).

Amounts are handled in the smallest unit of the token (or a scaled integer).  
All circuits must be deterministic and re-evaluable.

Amount and cap values are `uint32`. With 6-decimal USDT0, the maximum is 4,294.967295 USDT0 per value. Higher values are out of scope for MVP.

---

## 1. Daily Cap

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

## 2. Payee Whitelist + Cooling-off

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

## 3. Confirmation Threshold

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

## 4. Freeze / Breaker

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

## Implementation notes for Claude

- Circuits are taped out on TapeOut (X Layer).
- Escrow contract calls `eval` or `step` on the processor for each attached circuit ID.
- Input packing must be identical between contract and circuit.
- All circuits must be tested with edge values (0, max uint, exact threshold, etc.).
- Designer fee mechanism can be added later; not required for MVP.

**End of pinouts document**
Next file: Full Claude handoff prompt / implementation brief.

Say “next” when you want me to generate it.

next

Thought for 29s
File 2 created: CircuitWill_Claude_Handoff.md

Copy the content below into CircuitWill_Claude_Handoff.md.

markdown
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
