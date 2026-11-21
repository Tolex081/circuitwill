# CircuitWill – UI Wireframe Descriptions

**Product:** CircuitWill  
**Version:** MVP v1  
**Date:** 19 November 2026

Simple, clear DeWEB dashboard. Focus on trust and clarity: circuits decide.

---

## Screen 1: Home / Connect

- Large title: **CircuitWill**
- Subtitle: “Your rules decide. Circuits cannot be talked around.”
- [Connect Wallet] button
- Short explanation: “Create a personal money will on X Layer using TapeOut circuits.”

---

## Screen 2: Dashboard (main)

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

## Screen 3: Edit Rules

- Toggle each of the four circuits on/off
- Input fields for parameters
- [Save Rules] button
- Warning: “Changing rules takes effect on the next payment.”

---

## Screen 4: Decision Detail / Re-evaluate

- Full payment details
- All inputs that were packed
- Circuit results (one by one)
- [Re-run Evaluation] button that calls the processor again
- Link to TapeOut circuit explorer

---

## Visual rules

- Green = Allowed by circuits
- Red = Blocked by circuits
- Blue / neutral = Suggestion (memory)
- Always show the sentence: “Circuits make the final decision.”
- No dark patterns. No “agent approved” language.

---

## Mobile notes

- Stack cards vertically
- Large tap targets for Submit and Re-evaluate
- Decision result must be visible without scrolling on mobile

**End of UI wireframes**