# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who hold some money on X Layer and want hard rules on how it can leave, including first-time users who
have never used a smart-contract app. The owner sets the rules, funds the will, sends payments and changes rules.
An optional AI agent (a separate wallet) can only propose payments. Anyone can open a will read-only to check
its rules and decisions.

The dashboard must be usable by a novice on first visit: the owner's tester found the earlier developer-console
layout (2026-11-21) too hard to navigate and understand.

## Product Purpose

CircuitWill is a personal money will: an escrow on X Layer whose payments are allowed or blocked by TapeOut rule
circuits. Success is a person who can create a will, add money, send a payment, and understand why a payment was
allowed or blocked, without reading the README.

## Positioning

The rules are on-chain circuits, not soft limits or prompts: no agent, memory, button or page can override a
circuit result, and anyone can re-run a recorded decision to check it.

## Capabilities and Constraints

- Four rules: daily spending cap, payee whitelist with trial limit and cooling-off, confirmation (approval) above a
  threshold, freeze.
- Control follows the CircuitWillKey NFT. Only its holder can change rules, approve payments, freeze, or withdraw.
  The rule logic (netlists) is fixed; the rule settings change instantly, from the next payment, with no delay.
- Amounts are USDT0 (6 decimals), at most 4,294.967295 per value.
- Mainnet uses one official set of taped-out circuits, so creating a will asks only for rules and amounts. Custom
  processors and circuit ids stay available as an advanced option. The official ids are filled in after the
  mainnet tapeout; until then the page says so.
- Static page, no build step, vendored libraries, hosted on Vercel. Front-end changes only for the 2026-11-21
  redesign; the contracts stay as they are.
- The page never decides: allowed or blocked comes only from the recorded Decision event. It can explain a recorded
  decision from its recorded inputs.
- Walrus Memory suggestions are optional, off by default, and can never reach a transaction.

## Brand Commitments

Name CircuitWill, the NAND-gate mark, dark (default) and light themes, and one colour per rule circuit.
Copy rule from the wireframes: always show that circuits make the final decision; green = allowed, red = blocked,
blue = suggestion; no "agent approved" language.

## Evidence on Hand

No live deployment, users, testimonials or metrics exist. Nothing on the page may imply a live mainnet deployment.

## Product Principles

1. Plain language first, technical detail on request.
2. Show who you are to this will (owner, agent, viewer) and what you can do.
3. Every blocked payment says which rule blocked it and why, in words.
4. Circuits decide; the page only asks and explains.
5. Never fabricate state: anything not on chain is labelled.

## Accessibility & Inclusion

WCAG AA contrast in both themes, 44px touch targets, keyboard-operable tabs and dialogs, works at phone width.
