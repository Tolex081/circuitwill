---
version: 1
slug: "frontend-index-html"
primary_target: "frontend/index.html"
related_targets: ["frontend/app.js","frontend/style.css"]
---

# Dashboard (frontend/index.html)

Mode: Operate (welcome screen leans Persuade). Audience: first-time owners of a CircuitWill, their AI agent, and read-only viewers. Job: create a will, add money, send a payment, understand every decision, change rules. Constraints: static page, vendored libs, existing brand (name, NAND mark, dark/light, four rule colours), front-end only, page never decides.

## Direction contract

THESIS: A money app, not a contract console. Every screen answers "who am I here, what can I do, what happened". Refuses the old ledger of eight equal developer panels with raw function names.
OWN-WORLD: Existing CircuitWill world kept: dark slate paper / light stone, slate-blue accent, Schibsted Grotesk UI, Newsreader only for balance and page titles, one colour per rule (violet cap, teal recipients, magenta approval, ice freeze) as a rule's identity everywhere. Surfaces become soft-bordered sheets with 10px radius on a darker field; status uses green/red/ochre only for meaning.
STORY: Visitor learns what a CircuitWill is in one screen, connects, picks "Create" or a saved will, sets four rules as plain sentences, approves the wallet steps with a visible checklist, then lands on Overview with balance, today's spending against the limit, their role and their rules. Sending shows the result in words: which rule blocked it and why.
FIRST VIEWPORT: Welcome: left, headline and one-sentence explainer with Connect wallet (primary) and View a CircuitWill (secondary); right, a live-looking rule card stack showing the four rules as sentences. Dashboard: will header (name, short address, role badge), tab bar Overview / Send / Rules / History / Advanced, Overview grid with balance + Add money as the primary action.
FORM: guided app shell with tabs and a three-step create wizard; seed: none (pinned) "New structure, keep brand", "think like a real product designer ... easy for novice" (user, 2026-11-21).
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
