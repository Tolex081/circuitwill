# Build the rule builder; let AI only draft

**Short answer: yes, build it, but in the right order.** The AI should only fill in a form. Fixed, tested code turns that form into a circuit. The owner confirms the result using examples. The chain then enforces it. Nobody has shipped an "English to enforced on-chain rule" product, and the failures in nearby products show where the danger is. Money was lost when AI output was allowed to act directly. It was not lost when a hard, fixed limit sat between the AI and the money. The cost is tiny: about **$0.11 to publish a rule** and well under **one cent of network fee per payment** (measured on a copy of X Layer mainnet on 2026-11-23). The real blockers sit in the contract and the deploy plan, not in cost. The escrow cannot be upgraded after launch. So the "custom rule" slot and the 24-hour delay on loosening a rule must ship together, in one contract change, **before mainnet**. Before that launch, the TapeOut circuit processor also has to be created with a much larger NAND supply.

This is a research and design document. **Update 2026-11-23:** Steps A to E are built on branch `feat/custom-rules` (contract custom slot and loosening delay, compiler, form builder, AI drafting, history suggestions), not deployed. See the README section "Custom rules and the loosening delay". The gas and cost figures below were measured on a prototype before that contract change. Figures for the built contract are in `docs/MAINNET_RUNBOOK.md` ("Dry run (2026-11-24)") and the README's known limitations: about 0.8M to 1.1M gas to publish a rule (plus the 0.0013 OKB tapeout fee, about $0.11 in total, as before) and 2.6M to 2.9M gas per payment with four official circuits and one custom rule (about $0.005 at 0.02 gwei and OKB $85.12).

---

## Plain-English summary

CircuitWill holds USDT0 for its owner. Every payment is checked by small logic circuits that are published on TapeOut and cannot be changed. (A **circuit** here is a list of simple yes/no switches called **NAND gates**. **Taping out** means publishing that list on TapeOut so it is fixed forever.) Today there are four fixed kinds of rule: a daily limit, a trusted-recipients list, approval for large payments, and an emergency freeze.

The idea is to let an owner type a rule in everyday words. For example: *"My son can spend up to 10 a day, only on weekdays, never after 9 pm."* The app would then turn it into a real circuit that the escrow enforces.

What we found:

- **It is new.** No wallet or policy product we reviewed lets people write enforceable spending rules in plain English. They all use forms or fixed rule types.
- **The safe way is known.** The AI must never write the circuit or touch money. It only picks items from a short, fixed menu ("amount", "spent today", "time of week", "trusted recipient"...). Fixed code builds the circuit. The screen shows what the rule will do with real example payments. The owner confirms.
- **Some wishes cannot be enforced.** The chain sees addresses, amounts and times. It cannot see "groceries" or "school". The app must say so plainly and offer something it *can* enforce, such as "only these shops' addresses".
- **A custom rule can only add limits, never remove them.** Every rule must say yes for a payment to go through. So a custom rule cannot say "allow rent even above the daily limit".
- **It is cheap.** Example rules need 84 to 176 gates, smaller than today's daily limit (447). Publishing one costs about $0.11. Each payment costs a fraction of a cent more.
- **Five things in the current plan must change before mainnet.** They are listed under "Five findings the owner should act on" below.

---

## Recommendation: go, under seven conditions

**Go**, if all of the following hold. If condition 1 cannot be met, do not ship custom rules on the first mainnet escrow. They would then need a second escrow deployment later.

| # | Condition | Why |
|---|---|---|
| 1 | The custom-rule slot and the 24 h loosening delay land in **one contract change before mainnet** | The escrow is not upgradeable (`docs/RULE_SUGGESTIONS.md:247`). The slot changes how detach, slot counts and deploy order work under the delay. |
| 2 | The production TapeOut CPU is created with a **NAND supply cap far above 10,000** | Only about 9,155 NAND would be left after the four official circuits. Every rule edit uses more. |
| 3 | The AI only fills a **fixed, typed rule form**. A **deterministic compiler** builds the netlist from tested blocks. | Free AI-generated contracts and policies keep showing serious flaws ([18](https://arxiv.org/abs/2602.04039v1), [12](https://arxiv.org/html/2503.11573v1)). |
| 4 | The read-back the owner confirms is **generated from the compiled rule**, never from the AI's own words | Confirmation screens fail when they show a pre-filled, wrong value ([14](https://blog.ai.princeton.edu/2025/09/09/when-your-ai-assistant-gets-gaslithow-real-ai-agents-with-fake-memories-shows-that-smart-assistants-can-go-dangerously-off-script/)) |
| 5 | Example payments, especially **boundary cases**, are produced by running the real circuit, not by the AI | That way the check does not depend on the translator |
| 6 | The drafting AI **never sees wallet history, token names, memos or other untrusted text**, and has no tools | This breaks the "lethal trifecta" ([2](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)) |
| 7 | Wishes the system cannot enforce get a visible **"we can't enforce this part"** step, never a silent guess | Policy generators tend to be silently too permissive ([12](https://arxiv.org/html/2503.11573v1)) |

**Best order of work.** The only part on the mainnet critical path is the contract change (Step A in the build plan). The compiler, a form-based builder, the AI layer and history suggestions are all front-end work. They can ship after launch, because the contract will already accept custom rules. A plain form-based builder with no AI is safe and useful by itself, so build it first.

---

## Five findings the owner should act on

These came out of this research. They matter whether or not the AI part is built.

| Finding | What it means | Evidence |
|---|---|---|
| **The NAND supply is capped for life at 10,000** | The runbook creates the circuit processor with `createCPU(…, 10000, 0)` and says this number is "not documented". On a fork, minting 6,000 and then 4,000 worked, but the next `mint(0, 1)` failed with `"supply cap"`. The cap counts every NAND ever minted, even after they are used up. The four official circuits use 845, leaving **about 9,155**. That is about 52 tapeouts of the son rule, for the processor's whole life. **Raise it before mainnet** (a cap of 1,000,000 worked on the fork). Also: with a mint price of 0, *anyone* can mint NAND on the processor (`docs/MAINNET_RUNBOOK.md:105-107`). So a stranger could probably use up a small cap. This is an inference; it was not tested. | Measured on fork ([R1]); `docs/MAINNET_RUNBOOK.md:89, 105-108` |
| **Deploy.s.sol would fail under the loosening delay** | `_configure` says "Parameters first, then circuits", but it actually alternates. It runs `setDailyCap` → `attachCircuit(DAILY_CAP)` → `setTrialLimit` → `setCoolingOffHours` → `setPayee(…, true)` → `attachCircuit(WHITELIST)` → … Once the first circuit is attached, raising the trial limit from 0 or trusting a payee counts as *loosening*. Those calls would revert with `LooseningIsDelayed`. RULE_SUGGESTIONS only mentions reordering the dashboard. **Both** need fixing. | `contracts/script/Deploy.s.sol:99-117`; `frontend/app.js:734-753`; `docs/RULE_SUGGESTIONS.md:165-168, 220` |
| **Detach-by-kind breaks with several custom rules** | The planned delay queues removals by kind ("by kind, not by index: indexes move"). With two custom rules, "remove the CUSTOM one" is ambiguous. Each attached circuit needs a stable ID (`uid`). The dashboard's `detachKind` has the same problem. | `docs/RULE_SUGGESTIONS.md:178, 225`; `frontend/app.js:1881-1885`; `CircuitWillEscrow.sol:621-628` |
| **The netlist hash is recorded but never re-checked** | At attach, the escrow stores `keccak256(netlist)`. At payment time it just calls TapeOut's `eval`. TapeOut is upgradeable, so a changed implementation would not be noticed on chain. Re-hashing on every payment costs too much: an estimated ~0.45M+ gas for a 1,000-gate rule. Instead, add a cheap public "tripwire" that anyone can call to mark a changed circuit as failed. | `CircuitWillEscrow.sol:384-417`; `docs/TAPEOUT_INTERFACE.md:65-67`; `frontend/lib/reeval.js:143-150` |
| **Custom rules can only add limits, never grant exceptions** | A payment goes through only if *every* attached circuit says yes (`CircuitWillEscrow.sol:327-352, 436-448`). This makes adding a rule safe at once, even a broken one. But "allow rent above the daily cap" is impossible while the official Daily Cap is attached. To get an exception, the owner must remove the official rule (delayed 24 h) and put both behaviours into one custom rule. The builder must explain this. | `CircuitWillEscrow.sol:327-352`; `docs/RULE_SUGGESTIONS.md:153-154` |

One more contract gap belongs here. **An inheritance ("will") rule needs a new beneficiary role.** Today only the key holder or the active agent may propose a payment (`CircuitWillEscrow.sol:290`). A rule like "if I haven't checked in for 180 days, my daughter may withdraw up to 500 a month" needs three things: a beneficiary who can call the escrow, a stored "last check-in" time, and a `checkIn()` that only the key holder can call. Naming a beneficiary gives a new party the power to propose payments. That is a loosening, so it should go through the 24 h delay. If inheritance is ever wanted, this entry point has to be in the pre-mainnet contract.

---

## What others built, and where it went wrong

The industry pattern for "chat to transact" is the same everywhere. An AI pulls parameters out of the user's words into a fixed set of actions. Deterministic code simulates and checks the result. The user's wallet signs. OKX's Agentic Wallet says it simulates every transaction and shows a plain-language description before approval ([54](https://web3.okx.com/learn/agentic-wallet), search summary only). Coinbase's Agentic Wallets enforce session and per-transaction caps, with keys "never exposed to the agent's prompt or the LLM" ([22](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets)).

The products that enforce *standing* rules all use fixed rule types set through forms. None accepts free English. Examples include Brahma sub-account policies ([21](https://help.brahma.fi/en/articles/8955208-creating-a-policy)), MetaMask ERC-7715 periodic permissions ([26](https://eips.ethereum.org/EIPS/eip-7715)), Zodiac Roles, Privy ([24](https://docs.privy.io/controls/policies/overview)), Turnkey and Circle ([25](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/custom-policies)). OpenZeppelin takes the same approach for AI-written contracts, limiting generation to its audited Wizard templates ([53](https://www.openzeppelin.com/news/introducing-contracts-mcp)). MetaMask's own example, "spend up to 10 USDC per day", is the closest live match to CircuitWill's son rule ([19](https://docs.metamask.io/delegation-toolkit/guides/erc7715/use-permissions/erc20-token)). **Time-of-day and weekday limits exist in none of the on-chain standards reviewed.** Only Turnkey offers them, off chain, through `CronSpan` ([23](https://docs.turnkey.com/concepts/policies/language)). Zodiac Roles' condition list has no time operators beyond allowance refill periods ([20](https://docs.roles.gnosisguild.org/general/conditions)). So CircuitWill's time-window rules would go beyond what incumbents offer.

The closest working analogue to "English in, enforced policy out" is AWS Bedrock AgentCore's NL-to-Cedar. The user writes requirements in English. An AI converts them to Cedar, and a checker validates the result. The docs warn against vague principals, subjective conditions ("when the amount is reasonable") and unclear "A or B and C" grouping ([10](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-natural-language.html)). AutoCedar (2026) was built because a generated policy can compile and look right while granting access "no one approved" ([11](https://arxiv.org/abs/2607.03656)).

The documented losses teach four lessons:

- **A system prompt is not a lock.** Freysa's only rule was "never transfer funds". It sent its whole 13.19 ETH pool after 482 persuasion attempts ([13](https://www.theblock.co/post/328747/human-player-outwits-freysa-ai-agent-in-47000-crypto-challenge)).
- **Poisoned memory beats prompt filters, and confirmation alone does not save you.** In Princeton's study of ElizaOS agents, even strong models followed planted memories more than half the time. **The bot still asked permission, but it pre-filled the attacker's address as the default** ([14](https://blog.ai.princeton.edu/2025/09/09/when-your-ai-assistant-gets-gaslithow-real-ai-agents-with-fake-memories-shows-that-smart-assistants-can-go-dangerously-off-script/), [15](https://arxiv.org/abs/2503.16248v3)).
- **AI output must never be a payment order.** In May 2026, a hidden instruction got Grok to echo a command. Bankr's automation treated that output as an order and sent about $150K–$200K of DRB. Cointelegraph's diagnosis was "authorization, not interpretation". A safeguard against chains of one AI injecting another had been dropped in a rewrite ([16](https://cointelegraph.com/news/grok-bankr-wallet-free-nft-prompt-injection)).
- **Amounts and decimals must be handled by fixed code.** The Lobstar Wilde agent meant to tip about $300 and sent roughly 5% of a token's supply instead ([17](https://www.theblock.co/post/390722/ai-agent-created-by-openai-dev-accidentally-sends-entire-memecoin-holdings-to-reply-guy)).

In none of these cases did a hard, deterministic cap stop the loss. CircuitWill's on-chain circuits are exactly that cap. That is the product's real advantage. Most AI wallets stop protecting the user at the confirmation pop-up.

---

## Proposed architecture: AI drafts, code compiles, owner confirms, chain enforces

### The pipeline

| Stage | Who does it | Input | Output | May it touch money or keys? |
|---|---|---|---|---|
| 1. Draft | AI, with strict JSON-schema output and no tools | The owner's sentence plus the static fact menu | A **rule object**: conditions over menu facts, constants in human units, time zone, `unsupported_clauses[]` | No |
| 2. Check and clarify | Deterministic validator; the AI is sampled 3–5 times | The rule object(s) | Rejects anything off-menu. If the samples disagree, it asks **one** targeted question ("Is 9 pm itself allowed?") | No |
| 3. Compile | Deterministic, browser-safe compiler | A validated rule object | A NAND netlist built from tested blocks, its hash, and a `specHash` over the canonical JSON | No |
| 4. Show | Read-back renderer + simulator (`preview.js`) + X-ray (`xray.js`) | The netlist and rule object | A plain sentence, example payments from the real circuit, and an optional gate view | No |
| 5. Confirm and publish | The owner, in their own wallet | The previous stages | Tapeout (0.0013 OKB fee), then `attachCustomRule(…, expectedNetlistHash, specHash, text)` | Yes, but only the owner signs |
| 6. Enforce | The escrow, on every payment | A fixed 256-bit facts word | Allow or deny, combined with AND, failing closed | Yes: this is the lock |

This is the "plan-then-execute" / action-selector pattern from the prompt-injection design-patterns paper. The AI's role is fixed before it sees any data, and it has no tools ([4](https://arxiv.org/html/2506.08837v3)). OWASP says there is no known fool-proof prevention of prompt injection. It recommends constraining the model's role, enforcing output formats with deterministic code, and requiring human approval for risky actions ([1](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)). This pipeline does all three.

### Why a closed menu raises accuracy

How accurate AI translation is depends mostly on how closed the target is. Open targets do poorly. nl2spec translated hard expert sentences into temporal logic correctly only **44–58%** of the time unaided ([5](https://ar5iv.labs.arxiv.org/html/2303.04864)). An o1-preview agent solved **21%** of enterprise SQL tasks on Spider 2.0 ([56](https://arxiv.org/abs/2411.07763)). Closed targets with a fixed back end do much better. AI-to-JSON-to-XACML for smart-home rules reached **91%** on noisy input and **98%** agreement with experts. That pipeline has almost the same shape as CircuitWill's plan ([6](https://scitepress.org/publishedPapers/2025/133572/pdf/index.html)). Reparo reports **98–99.6%** for the simple OpenFGA language, against 76–80% for Rego ([7](https://arxiv.org/pdf/2610.41800), search summary only).

The measured techniques that help are:

| Technique | Measured effect |
|---|---|
| Strict schema decoding | 100% schema compliance in OpenAI's internal test ([9](https://openai.com/index/introducing-structured-outputs-in-the-api/), vendor figure) |
| Showing which phrase produced which part of the rule, and letting the user fix pieces | nl2spec went from **58% to 86%** ([5](https://ar5iv.labs.arxiv.org/html/2303.04864)) |
| Detecting disagreement and asking one clarifying question | ClarifyGPT gained about **10 points** ([8](https://arxiv.org/abs/2310.10996v1)) |

A realistic expectation is single-shot accuracy in the 90s on everyday phrasing. The misses will cluster on inclusive versus exclusive bounds, time zones and negation. Those are exactly the cases the boundary examples (below) are built to catch. CircuitWill should measure its own accuracy on a labelled set of real rule sentences rather than trust public benchmarks.

### Defending against prompt injection

The drafting AI gets only two things: the owner's sentence and the static fact menu. Its only output is the rule object. Recipients enter the rule in one of two ways: as an index into the owner's own saved-payee list, or as an address the owner typed. They never come from text the AI produced. Several things never reach the drafting AI: token names, transfer memos, ENS-style names, payee labels from other people, and wallet history. All of these can be written by an attacker, and token names are already used to carry URLs and instructions ([48](https://help.phantom.com/hc/en-us/articles/37418827844755-Common-token-scams)).

The AI cannot render links or images and cannot make calls. So the private-data / untrusted-content / outbound-channel trifecta never comes together ([2](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)). If names ever need resolving ("my son's wallet"), deterministic code resolves them against the owner's address book. This is the CaMeL idea of a quarantined component whose output is only an ID ([3](https://arxiv.org/abs/2503.18813)).

One risk remains. Text pasted from a scam page could still change *values*, for example turning 10 into 1,000. The defence is that stage 4 shows the final numbers and full addresses from the compiled rule, and only the owner's signature publishes anything. The same rule holds throughout: **if anything fails, stop.** A schema that cannot be filled, samples that disagree, or a clause that cannot be compiled ends in a question or a refusal. It never falls back to something more permissive.

### Wishes the chain cannot enforce

The escrow sees an address, an amount, a time, and its own stored counters. It cannot see what is being bought. The rule object therefore carries an `unsupported_clauses` array, and the AI must copy into it any phrase it cannot map. Typical examples:

| Wish | Why it can't be enforced | Enforceable alternative the owner can choose |
|---|---|---|
| "only groceries", "only for school", "no junk food" | The chain has no merchant category | "Only to these shops' addresses" (trusted list or a custom payee condition). It is shown in the simulator: "a payment to an unlisted shop would be blocked". |
| "not on public holidays" | There is no holiday calendar fact | Blocking specific dates is not in v1. Suggest a weekday window instead. |
| "10 dollars" or "10 euros" | There is no price feed; the rule counts USDT0 | "10.00 USDT0" read back in human units |
| "allow rent even above the daily limit" | Rules combine with AND, so no exceptions are possible | Remove the official limit (24 h delay) and build one combined custom rule |
| "unless it's an emergency" | This is subjective | "Unless I approved this exact payment" (the confirmation fact) |

The app shows each unsupported phrase in its own "We can't enforce this part" box. It may *offer* a proxy, but never applies one automatically. It allows a partial rule only after the owner explicitly accepts that the rest will not be enforced. This is the main flow, not an edge case. In Ur et al.'s smart-home study, trigger-action rules covered most behaviours users wanted but not all ([33](https://blog.cs.brown.edu/2014/04/29/michael-littman-chi2014-programming-smart-home/)). Silently dropping a clause is the known failure of AI policy generators ([12](https://arxiv.org/html/2503.11573v1)).

---

## Fact menu and fixed input pinout

### What the escrow can supply

The circuit-cost research prototyped and measured one fixed layout. It is exactly one 256-bit word (32 bytes) with one output bit. The **limits are baked into the netlist as constants**, and the escrow supplies only facts. Two choices cut the son-style rules from about 361 to 84 NAND (measured). First, money is counted in **cents**, rounded up for spending and down for balance. Second, the escrow passes running totals **including this payment**, so the circuit needs no adder. Cents also widen the range from 4,294.97 USDT0 (the 32-bit base-unit limit today) to about 42.9 million USDT0.

Proposed pinout v1. Bits are LSB-first, and bit *i* = `(byte[i>>3] >> (i&7)) & 1`, the same as today's circuits.

| Bits | Fact | Width | Meaning | Source | Extra gas per payment |
|---|---|---|---|---|---|
| 0–31 | amount_c | 32 | Payment amount in cents, rounded up | Call argument | ~0 |
| 32–63 | spent_day_after_c | 32 | UTC-day total including this payment; saturates at max | Existing `spentToday` (`CircuitWillEscrow.sol:131-136, 316-323`) | ~0 |
| 64–95 | spent_7d_after_c | 32 | Rolling 7 UTC days including this payment | **New**: 7 day-buckets in one slot | ~5k (estimate) |
| 96–127 | spent_month_after_c | 32 | Calendar UTC month including this payment | **New**: one slot | ~5k (estimate) |
| 128–159 | balance_after_c | 32 | Balance after payment, rounded down | `balanceOf`, moved before eval (`:349`) | ~2.6k (estimate) |
| 160–167 | count_day_after | 8 | Payments today including this one; saturates at 255 | **New**: can share the daily slot | ~0–3k (estimate) |
| 168–177 | slot_of_week_utc | 10 | 15-minute slot since Monday 00:00 UTC (0–671) | `block.timestamp` | <100 (estimate) |
| 178 | payee_trusted | 1 | Recipient is on the trusted list | `payees[to].saved` (`:70-73`) | ~0–2.1k |
| 179 | payee_known | 1 | Recipient has been seen before | `firstSeen != 0` | ~0 |
| 180 | payee_paid_before | 1 | Recipient has been paid before | **New** bool in the `Payee` slot | 2.9k–20k on first payment (estimate) |
| 181–196 | payee_age_hours | 16 | Hours since recipient was added; saturates at 65,535 | `_ageHours` (`:419-426`) | ~0 |
| 197–212 | checkin_age_hours | 16 | Hours since the owner last checked in; saturates | **New** `lastCheckIn` + `checkIn()` | ~2.1k read (estimate) |
| 213–214 | caller_role | 2 | 0 key holder, 1 agent, 2 beneficiary, 3 reserved | `controller()`, `isActiveAgent` (`:271-274, 285-291`) | ~0; **beneficiary needs a new role** |
| 215 | confirmed | 1 | Owner pre-approved this exact payment | `_confirmationFor` (`:430-434`) | ~5k if no Confirmation circuit is attached |
| 216–255 | reserved | 40 | Always 0 | — | — |

All new storage together is **an estimated 15–35k gas per payment**, about 1% of today's four-circuit payment. This figure was not measured; it comes from standard storage opcode prices ([52](https://eips.ethereum.org/EIPS/eip-2929)). One candidate for the reserved bits is an `is_withdrawal` flag, because owner withdrawals also pass through the circuits (`CircuitWillEscrow.sol:296-303`). It was not in the measured prototype.

### Design rules that keep the menu safe

- **The input count is the version number.** The escrow can only check a circuit's input count, output count and state count on chain (`CircuitWillEscrow.sol:609-612`). So any future fact layout must use a different input count. Otherwise an old circuit would silently receive new meanings.
- **Saturation must be on the safe side.** A saturated value is only safe when "at most K" tests use K below the maximum and "at least K" tests use K at or below it. The compiler must refuse other comparisons. This follows the existing `_ageHours` rule.
- **The amount is rejected, never truncated.** An amount too large for 32-bit cents should give `NOT_EVALUATED` and block, like today's packers (`DailyCapPacking.sol:21-23`).
- **Time is reliable to about 15 minutes.** X Layer makes a block every second. Sampled timestamps were within 1 s of wall-clock time ([R2](https://rpc.xlayer.tech), [50](https://web3.okx.com/learn/flashblocks-on-x-layer), search summary for the OKX page). OP Stack rules bound sequencer drift to at most 1,800 s ([49](https://specs.optimism.io/protocol/derivation.html)). An agent cannot change the clock, but it *can* choose when to submit. So time windows limit *when* money moves, not whether an agent waits.
- **Time zones are baked in by the compiler.** It shifts local windows to UTC, so nothing extra is stored. A stored time-zone setting would itself be a loosening control. Fixed offsets ignore daylight saving. A safe option is to allow only times permitted under *both* offsets, which costs at most an hour of window. This option was not prototyped.

---

## Cost: cents to publish, fractions of a cent per payment

All rows below were **measured** on a local fork of X Layer mainnet on 2026-11-23 ([R1]). Each rule was taped out with 256 inputs, and its output was checked against a reference on 8 vectors. The compiled netlists also matched a JavaScript reference on 20,672 vectors.

Prices: gas price 20,000,001 wei (0.02 gwei) from `eth_gasPrice` on `rpc.xlayer.tech` ([R2](https://rpc.xlayer.tech)). OKB = **$85.12** from CoinGecko, last updated 2026-11-23 at about 16:20 UTC ([51](https://api.coingecko.com/api/v3/simple/price?ids=okb&vs_currencies=usd&include_last_updated_at=true)). Tapeout fee 0.0013 OKB = $0.1107 (`docs/TAPEOUT_INTERFACE.md:61`).

| Rule | In plain English | NAND | Bytes | Tapeout gas | Tapeout cost | Eval gas | Share of 3M budget | Payment gas (4 official + this) | Payment cost |
|---|---|---|---|---|---|---|---|---|---|
| a | up to 10 a day | 84 | 588 | 492,817 | $0.1115 | 300,523 | 10.0% | 2,616,424 | $0.0045 |
| b (UTC) | up to 10/day, weekdays, never after 9 pm | 157 | 1,099 | 666,875 | $0.1118 | 462,568 | 15.4% | 2,778,469 | $0.0047 |
| b (UTC+2) | same, owner in UTC+2 | 176 | 1,232 | 721,180 | $0.1119 | 506,211 | 16.9% | 2,822,112 | $0.0048 |
| c | max 50 per payment, max 5 payments/day, trusted payees only | 103 | 721 | 512,846 | $0.1115 | 340,782 | 11.4% | 2,656,683 | $0.0045 |
| d | up to 200/week, payee known ≥ 48 h | 115 | 805 | 547,218 | $0.1116 | 370,386 | 12.3% | 2,686,287 | $0.0046 |
| e | inheritance: owner free, OR beneficiary after 180 days without check-in, ≤ 500/month | 112 | 784 | 538,581 | $0.1116 | 362,576 | 12.1% | 2,678,477 | $0.0046 |
| f | three alternative groups, 6 conditions | 382 | 2,674 | 1,309,032 | $0.1129 | 969,423 | 32.3% | 3,285,324 | $0.0056 |
| f2 | f plus 6 more conditions | 715 | 5,005 | 2,260,898 | $0.1145 | 1,717,510 | 57.3% | 4,033,411 | $0.0069 |
| g | deliberately bad stress rule | 1,065 | 7,455 | 3,264,100 | $0.1162 | 2,509,012 | 83.6% | 4,824,913 | $0.0082 |
| *today* | Daily Cap / Whitelist / Confirmation / Freeze | 447 / 237 / 160 / 1 | 3,129 / 1,659 / 1,120 / 7 | 1,511,368 / 878,655 / 659,569 / 204,815 | — | ~1.07M / 0.59M / 0.41M / 0.03M | — | 2,315,901 (all four) | $0.0039 |

Notes on the table:

- Tapeout gas was measured inside the test. It excludes the 21,000 base cost and calldata (e.g. 6,404 gas for rule a). A re-tapeout of Daily Cap came within 1% of its real receipt (1,524,998 vs 1,511,368).
- "Payment gas" leaves out the estimated 15–35k for the new facts.
- The rows for today's circuits are from the repo (`docs/TAPEOUT_INTERFACE.md:43-45`, `docs/MAINNET_RUNBOOK.md:417, 422`).

Five conclusions follow from these numbers:

1. **Publishing cost is almost all the fixed fee.** Gas is under 5% of the cost even for the stress rule. Each NAND minted also costs 0.01 BEM per `mint` call. BEM's USD price was not looked up.
2. **Per-payment cost grows with gate count.** It is about **2,250 gas, or $0.0000038, per NAND per payment** (measured).
3. **Fitted from measured chains of 1 to 20,000 gates:**
   - tapeout ≈ 154,681 + 2,896 × gates
   - eval ≈ 95,624 + 2,250 × gates

   So any rule up to **about 1,290 NAND** fits the default 3M per-circuit budget (`CircuitWillEscrow.sol:112-117`).
4. **The per-circuit budget is not shared.** Several rules each get their own 3M. A worst case of three custom rules at 1,000 NAND would cost about 2.32M + 3 × 2.35M ≈ **9.35M gas per payment (≈ $0.016)**. That is about 4.5% of X Layer's 210M block gas limit.
5. **The NAND supply cap is what really limits us.** Every limit edit needs a fresh tapeout, because the constants are baked in.

---

## Contract change outline: one change, before mainnet

The changes below combine the custom slot with the delay design already written in `docs/RULE_SUGGESTIONS.md`.

**1. A new kind with several instances.** Append `CUSTOM = 5` to `CircuitKind`. The enum is part of the event format, so it must be append-only (`CircuitWillEscrow.sol:37-44`). Extend `test_enumValuesAreStable`. Exempt CUSTOM from `DuplicateCircuitKind` (`:605`). Keep that check for kinds 1–4.

**2. Slot limits.** Recommendation: use a separate counter, `MAX_CUSTOM_RULES = 3`. The four official kinds keep their own four places, so `MAX_CIRCUITS` effectively becomes 7. The dashboard allows only **2 active custom rules**. That keeps one slot free, because a replacement briefly needs both the old and the new rule (see point 6). The builder should encourage putting conditions into *one* rule. Rule f2 holds 12 conditions in 715 NAND.

**3. Fixed packing.** Add a `CustomFactsPacking` library with `N_IN = 256` and the pinout above. It gets its own branch in `_evaluate`, exactly like the four existing kinds (`:390-403`). `confirmed` must be computed before the first CUSTOM eval even when no Confirmation circuit is attached. Today it is computed only on that branch (`:333`).

**4. Pin the rule at attach time.** Add `attachCustomRule(processor, circuitId, expectedNetlistHash, specHash, englishText)`. It runs the existing checks with `N_IN = 256` and requires three more things:

- `gateCount ≤ MAX_CUSTOM_GATES`, using the value currently thrown away at `:609`;
- `keccak256(netlist) == expectedNetlistHash`, so a different circuit ID cannot be swapped in between preview and signature;
- a factory-registered processor.

Store `specHash` and a stable `uid` per circuit. Emit `CustomRuleAttached(uid, processor, circuitId, netlistHash, specHash, factsVersion, englishText)`. The text costs an estimated 5–6k gas for 200 bytes. Any viewer, including a future key buyer, can then read the rule's own words on chain. Leave `_recordHash` unchanged so `reeval.js` keeps working. Recommended `MAX_CUSTOM_GATES = 1,000`: the measured fit gives about 2.35M gas, 78% of the 3M budget. The dashboard warns above about 450 NAND.

**5. Combine with the delay rules.** Adding a custom rule is **instant**, because AND composition means it can only block more (`docs/RULE_SUGGESTIONS.md:153`). Removing one is **delayed**, using `DETACH_CIRCUIT`, now **targeted by `uid`**, not by kind. Do not try to decide whether one arbitrary circuit is "looser" than another. That is a satisfiability problem, which is impractical to check on chain. Rely only on the fact that adding a rule can only tighten. `applyChange` must handle a target that has already gone (revert `ChangeTargetGone` or treat it as a no-op).

**6. Replacing a rule** means adding the new rule now and queueing removal of the old one. No new change type is needed. For 24 hours both apply, and the stricter combination is always safe. The dashboard shows the pair as one "pending replacement".

**7. New state and calls.**

- Add the 7-day ring, month total, daily count, `paidBefore` bit and `lastCheckIn`.
- `checkIn()` is key-holder-only and **not delayed**, because it tightens a dead-man rule. The agent must never be able to call it, or a compromised agent could keep a will "alive" forever. Keep it on the never-suggested list.
- Add the beneficiary role and its entry point. Setting a beneficiary is a delayed loosening.
- Re-run the `GAS_RESERVE` and gas-estimate tests (`contracts/test/MultiCircuit.t.sol:715-781`). More work after the evals eats into the 250,000 reserve (`:109-110`).

**8. Tripwire.** Add a public `checkCircuit(uid)`. It sets a `tampered` flag if `keccak256(netlist)` no longer matches, and that circuit then counts as failed. It can only tighten, so anyone can call it: a watcher bot, or the dashboard when its existing "Circuit changed" banner fires (`frontend/lib/xray.js:533-537`).

**9. Deploy order.** Reorder `Deploy.s.sol:100-117` and `frontend/app.js:734-753` to set **every** parameter first and attach circuits last. Then regenerate ABIs and bytecode, re-run the fork dry run, and update `MAINNET_RUNBOOK.md`. That update should include the `createCPU` supply cap and, optionally, a demo custom rule added to the single NAND mint.

What is left unchanged on purpose: the fail-closed adapter `TapeOutEval.evalFirstBit` (`TapeOutEval.sol:37-71`), `nOut == 1`, `nState == 0`, the status and reason codes, and the `CircuitEvaluated` event.

---

## Confirming a rule: what a beginner should see

Evidence on how well non-experts understand permissions is grim. Only **3%** of 308 Android users answered all permission questions correctly in Felt et al. ([57](https://research.google/pubs/android-permissions-user-attention-comprehension-and-behavior/), search summary only). In a 2026 wallet study, **40%** signed unlimited-approval and phishing prompts. That same study then tested a "Signature Semantic Decoder" with three parts:

- one plain sentence saying what the signature *does*;
- the key fields highlighted;
- a green/amber/red risk label with a stated reason.

It raised correct decisions from **67.9% to 84.2%**, cut false approval of unlimited approvals from **36.5% to 9.8%**, and cut mental workload by about a third ([31](https://arxiv.org/html/2601.16751v1), preprint). Users also find it much harder to predict what a rule will do when it contains timing or control-flow bugs ([32](https://par.nsf.gov/biblio/10106413)).

Studies comparing example-based and rule-based explanations are mixed. Both help, and both can over-persuade ([37](https://publications.tno.nl/publication/34637580/cB7b5O/waa-2021-evaluating.pdf)). So the confirmation screen should use both, in layers. Each layer is drawn from the **compiled rule**, not from the AI's wording.

| Layer | What it shows | Built from |
|---|---|---|
| 1. One-sentence effect | "Payments by your agent are blocked on Saturdays and Sundays, from 21:00 to 23:59 Lagos time, and once today's total would pass 10.00 USDT0." The time zone is spelled out ("the day restarts at 00:00 UTC, which is 01:00 in Lagos"). Each clause is tied to the phrase of the owner's sentence it came from. | Deterministic renderer from the rule JSON |
| 2. Key fields and risk label | Amount in human units with token name; time window in local time; payee set as full addresses in 4-character chunks; a reasoned warning (e.g. "This blocks every payment on weekends, including your own withdrawals") | Rule JSON + checks |
| 3. Example payments | 3–6 examples, one clearly allowed and one clearly blocked, plus **boundary pairs**: 10.00 allowed / 10.01 blocked; 20:59 allowed / 21:00 blocked; Friday allowed / Saturday blocked. Each is shown alone *and* combined with the attached official rules, because the combination is what the owner actually gets. | `preview.js` `simulate` running the draft netlist (`frontend/lib/preview.js:148-171`) |
| 4. Self-check (optional) | "Would 25 USDT0 to Bob at 22:00 go through?" before Confirm | Simulator |
| 5. Block diagram on tap | "amount check AND time check → allow" | Compiler stage labels |
| 6. Circuit X-ray (for the curious) | The gate-level view, with unused input pins hidden | `xray.js` `buildXray({kind: 5, preview: true})` |

Write for a reading age of about 9. GOV.UK and the Home Office use that target even for specialists ([34](https://design.homeoffice.gov.uk/accessibility/written-content/readability)), though the DfE dropped the metric in 2025 as of doubtful value ([35](https://dfedigital.blog.gov.uk/2025/03/19/introducing-the-dfe-plain-language-standard/)). A confirmation should restate exactly what will happen ([36](https://www.nngroup.com/articles/confirmation-dialog/)).

Friction should depend on direction. **Adding** a rule takes one confirmation. **Removing or replacing** one takes a consequence statement, a typed confirmation and the on-chain delay. That mirrors Monzo's gambling block, which users cannot switch off faster than the cooldown they chose ([29](https://monzo.com/ie/help/managing-money/help-gambling-block)), and Argent's 36-hour delay on adding a guardian, which "cannot be skipped" ([28](https://support.argent.xyz/hc/en-us/articles/360008013258-How-to-add-a-guardian-)). Showing users examples that differ at the edges is also how the Clarify network-config system confirms intent before it verifies a configuration ([55](https://arxiv.org/pdf/2507.12443)).

For edits, show a "before / after" view listing the example payments whose answer changes. The X-ray already supports most of this: `decodeNetlist`, `evaluate`, `buildXray`, `mountXray` and `simulate` work for any NAND netlist. What is missing is a kind-5 decoder in `units.js`, `FIELD_INFO` labels for the new facts, and a way to pass the rule's own text as captions (`frontend/lib/xray.js:78-89, 351-414`).

The Bybit hack is the warning here. Signers saw a correct-looking transaction while signing different data, because the front end had been compromised ([30](https://www.nccgroup.com/research/in-depth-technical-analysis-of-the-bybit-hack/)). CircuitWill's English text and X-ray are drawn by the same front end that builds the transaction. The `specHash` and `netlistHash` let an independent viewer re-run the pinned compiler on the published JSON and check that the bytes match. The dashboard should make that "reproduce this rule" check one click.

---

## Wallet-history suggestions: useful, but attacker-writable

A suggestion such as "you usually send at most 20 a day to these 3 people; set that as your limit?" seems to be new. Banks offer budgets (Revolut works out a daily allowance from a budget the user enters) but not limits drawn from payment history. The research found no crypto wallet that does this either.

History "from before CircuitWill" means the owner's earlier outgoing USDT0 transfers on X Layer. It is useful for a sensible starting limit, but it carries two real risks.

### Privacy

A public address's history exposes who the owner pays, how much and when, and it can be linked to other addresses. The EDPB's blockchain guidelines (v2.0, adopted July 2026) say wallet addresses and transaction identifiers "may constitute personal data", and the EDPB declined to exclude them ([42](https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_en.pdf)). Sending history to a hosted AI makes CircuitWill responsible for that data, with minimisation duties ([43](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/guidance-on-ai-and-data-protection/how-should-we-assess-security-and-data-minimisation-in-ai)).

The data sources have trade-offs:

- **Etherscan's V2 API does not cover chain 196** ([45](https://api.etherscan.io/v2/chainlist)).
- OKLink ([47](https://oklink.com/docs/en), search summary) and GoldRush ([46](https://goldrush.dev/docs/chains/x-layer)) do cover it, but need API keys. Calling them from the browser leaks the owner's address, IP address and the key.
- Reading the USDT0 `Transfer` log through the RPC, filtered to `from = owner`, avoids third parties. Its block-range limits are unverified.

**Design:** make history scanning opt-in and off by default (the existing `memory-pref.js` pattern). Read only outgoing USDT0 transfers in a recent window. Compute counts and medians **in the browser with deterministic code**. Send nothing to a hosted model, or at most an anonymised aggregate. If an AI is wanted for phrasing, an in-browser model (WebLLM runs entirely on the device through WebGPU ([44](https://arxiv.org/html/2412.15803v1))) keeps the data local. If the AI phrases the suggestion, it receives only numbers that code has computed.

### Poisoning

Wallet history can be written by attackers. Address poisoning has caused at least **$83.8M** in losses, from about 270M attempts against about 17M victims on Ethereum and BSC ([39](https://www.usenix.org/conference/usenixsecurity25/presentation/tsuchiya), [38](https://arxiv.org/html/2501.16681v1)). Attackers use three tricks: tiny transfers, fake zero-value `transferFrom` records that look like they came *from the victim*, and counterfeit tokens. All come from lookalike addresses matching 3+ leading and 4+ trailing characters, mostly within 20 minutes of a real transfer ([38](https://arxiv.org/html/2501.16681v1)). The largest single loss was $50M in December 2025 ([40](https://cylab.cmu.edu/news/2026/01/07-blockchain-address-poisoning.html)). It is worst on low-fee chains, and X Layer is one. After Ethereum's fees fell, USDT dust transfers rose **612%** in 90 days ([41](https://info.etherscan.com/address-poisoning-attacks-are-rising-on-ethereum)).

The Princeton result makes this an AI problem too. Planted records in an agent's memory steer later decisions, and prompt filters barely help ([15](https://arxiv.org/abs/2503.16248v3)).

**Filters the suggester must apply:**

- Count only transactions **the owner signed** (`tx.from == owner`).
- Count only the **hard-coded canonical USDT0 contract**, never matching by token name.
- Apply a value floor (e.g. ≥ 1 USDT0).
- Require repetition across distinct days before calling anyone a "usual" payee.
- Never put token names, memos or calldata strings into any AI prompt.
- Show suggested payees as full chunked addresses, with a lookalike warning.
- **Suggestions only ever tighten.** They never auto-add a payee to a trusted list, because adding a payee is exactly what a poisoner wants.

A suggestion becomes a rule draft that goes through the same compile, read-back, examples and confirm steps as a typed rule. This matches the existing rule in `docs/RULE_SUGGESTIONS.md:29-30, 124-128` that memory text never becomes a number or address in a contract call.

---

## Risks

| Risk | What could go wrong | Mitigation |
|---|---|---|
| Mistranslation | The rule enforced is not the rule meant (bounds, time zone, negation) | Closed schema; read-back from compiled JSON; boundary examples from the simulator; one clarifying question when samples disagree; CircuitWill's own labelled test set |
| A bad rule blocks everything | A custom rule that denies every payment, including the owner's withdrawals, which also pass through circuits (`CircuitWillEscrow.sol:296-303`). Removing it waits the full `ruleDelay` (24 h default, up to 30 days), and Freeze does not help. Safe warns that a broken guard can cause denial of service ([27](https://docs.safe.global/advanced/smart-account-guards)). | The simulator warns when every example is blocked or owner withdrawals are blocked. Consider the optional "undo window": a rule attached minutes ago can be removed at once, which gives a thief nothing new. |
| NAND supply runs out | 9,155 NAND left at a cap of 10,000; anyone can mint at price 0 (probable, untested) | Create the production CPU with a much larger cap; check whether the cap can be raised later (unknown) |
| TapeOut is upgraded | Eval behaviour changes; the stored hash is not re-checked | Tripwire `checkCircuit`; dashboard re-hash; logged inputs/outputs allow re-evaluation |
| Compiler bug | Deterministic but wrong netlists | Golden artifacts; differential tests against a JS interpreter of the rule JSON on PRNG and boundary vectors (the pattern already used in `circuits/test`) |
| Prompt injection / pasted scam rule | Values altered inside the draft | The AI sees no untrusted text; values shown in human units and full addresses; owner signs |
| Front-end compromise (Bybit pattern) | The screen shows one rule while another is signed | `expectedNetlistHash` and `specHash` on chain; independent "reproduce this rule" check |
| Time | The sequencer may skew up to 1,800 s in theory (observed about 1 s); the agent chooses when to submit; daylight saving | 15-minute granularity; conservative daylight-saving intersection; show local times |
| Saturation misuse | A saturated counter compares on the unsafe side | The compiler allows only saturation-safe comparisons |
| Key transfer | A new holder inherits all custom rules; queued removals die with the old holder (`docs/RULE_SUGGESTIONS.md:205-206`) | Show attached rules and their English text to every viewer |
| Beneficiary role | A new party can propose payments | Setting a beneficiary is a delayed loosening; official rules still apply |
| Gas growth | More facts and rules eat into `GAS_RESERVE` | Gate cap of 1,000; re-run the reserve and estimate tests |
| Privacy | History sent off-device is personal data | Opt-in; local computation; aggregates only |
| Every edit costs a tapeout | Constants are baked, so each change uses NAND and about $0.11 | Accept for v1. A "parametric" custom rule with stored thresholds is deferred, because the chain cannot verify which direction loosens. |

---

## Phased build plan

| Step | What | Done when | On the mainnet critical path? |
|---|---|---|---|
| A. Contract change | Loosening delay (RULE_SUGGESTIONS) + CUSTOM kind, `uid`, `MAX_CUSTOM_RULES = 3`, `MAX_CUSTOM_GATES = 1,000`, `CustomFactsPacking` (256-bit), new fact storage, `checkIn()`, beneficiary role, `attachCustomRule` with expected hash and specHash, tripwire, detach-by-uid; reorder `Deploy.s.sol` and `app.js` buildPlan; create the CPU with a large NAND cap | All the tests listed in the contract notes pass, including the fuzz test "adding a custom rule never turns a blocked decision into an allowed one", two-custom-rule detach after index moves, and the gas reserve tests; fork dry run re-run; runbook updated | **Yes** |
| B. Compiler | Rule-JSON schema and canonicaliser; browser-safe compiler from tested blocks (comparators against constants, time windows, AND/OR groups); English renderer from JSON | Byte-identical builds; golden artifacts; differential tests; refuses off-menu facts and unsafe saturation | No |
| C. Form builder (no AI) | Pick facts from the menu; read-back, examples, X-ray; browser tapeout (NAND mint, 0.0013 OKB tapeout) and attach; pending-changes panel | A non-technical tester builds rule b and correctly predicts the boundary examples | No |
| D. AI drafting | Strict-schema drafting; self-consistency and one clarifying question; `unsupported_clauses` flow | ≥ 90% exact match on CircuitWill's own labelled sentence set, with every miss caught by the boundary examples in testing; static test that the draft module cannot reach a wallet (as `frontend/test/memory.test.mjs:243-296` does) | No |
| E. History suggestions | Opt-in, local, filtered, tighten-only | Poisoning test cases (dust, zero-value `transferFrom`, fake USDT0) never produce a suggestion | No |

---

## How conflicting numbers were settled

Two notes disagreed in places. The contract notes reasoned from the repo and estimated. The circuit-cost notes prototyped and **measured** on a mainnet fork. Measured figures win.

| Topic | Contract notes (estimate) | Circuit-cost notes (measured) | This report uses |
|---|---|---|---|
| Facts vector | ~189 bits / 24 bytes, money as uint32 base units, `spentToday` *before* payment, hour (5 bits) + weekday (3 bits) | **256 bits / 32 bytes**, money in cents, totals *after* payment, 15-minute slot of week | 256-bit. It was measured, it leaves 40 spare bits, and it costs only about +68k gas versus an 8-bit input (≈274 gas per input bit). |
| Eval gas | ≈ 30k + 2.33k per NAND, extrapolated from 4 small-input points; ~1,250 NAND fit in 3M | **≈ 95.6k + 2,250 per NAND** at 256 inputs; ~1,290 NAND fit | Measured. The higher fixed term comes from the 256-bit input. |
| Tapeout gas | ≈ 200k + 2.93k per gate | **≈ 154.7k + 2,896 per gate** | Measured |
| "Weekly spend ≤ X" size | 300–450 NAND (in-circuit adder) | **115 NAND** (rule d) | Measured design: the escrow adds, and constants are baked |
| Weekly window | Calendar week | Rolling 7 days + calendar month | Both rolling 7 days and calendar month, as prototyped. Each is about 5k gas (estimate). |
| Custom rule count | `MAX_CUSTOM_RULES = 3`, total 7, UI stops at 2 | Per-circuit budget, so gas allows many; the real limits are `MAX_CIRCUITS` and the NAND cap | **3 in the contract, 2 active in the dashboard**, one combined rule encouraged |
| Gate cap | `MAX_CUSTOM_GATES = 1,000` | ≤ ~420 if Daily Cap's 2.8× margin is kept; ≤ 1,290 fits | **1,000 on chain** (2.35M measured, 78% of budget); dashboard warning above ~450 |

---

## Conclusion

The research changes the question. "Can an AI write a safe circuit?" is the wrong question: it should never write one. The useful question is whether CircuitWill can offer a small, well-tested menu of facts and building blocks that ordinary sentences map onto. The prototypes say yes. The son rule fits in 157–176 gates and costs about $0.11 once and half a cent per payment. Time-of-week windows, which no on-chain incumbent offers, cost under 100 gates.

What the owner must actually decide is in the contract, not the AI. Five choices have to be fixed now because the escrow cannot be upgraded: how custom rules are identified and removed under the delay; how many are allowed; whether a beneficiary can ever exist; how large the NAND supply is; and whether the stored circuit hash can be re-checked. Getting those right before mainnet keeps every later step, from a form builder to AI drafting to history suggestions, a front-end change that can ship whenever it is ready.

---

## Sources

**Measurements made for this research (not in the repo)**

- R1. Local fork of X Layer mainnet (forge `createSelectFork`, nothing broadcast), 2026-11-23: tapeout and eval gas for rules a–g, supply-cap probe (`test_supplyCapIsCumulative`), gas fits for 1–20,000-gate chains. Research scratch files `rulebuilder/out/forge_output.txt`, `forge_probe2_output.txt`, `rules_output.txt`, `cost_output.txt`.
- R2. X Layer RPC reads, 2026-11-23: `eth_gasPrice` 20,000,001 wei, base fee 20,000,000 wei, 1 s block times, block gas limit 210M — https://rpc.xlayer.tech

**Web sources** (marked "search summary" where the page was not read in full)

1. OWASP, LLM01:2025 Prompt Injection — https://genai.owasp.org/llmrisk/llm01-prompt-injection/
2. S. Willison, "The lethal trifecta" (2025-06-16) — https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
3. Debenedetti et al., CaMeL (arXiv 2503.18813) — https://arxiv.org/abs/2503.18813
4. Beurer-Kellner et al., Design Patterns for Securing LLM Agents against Prompt Injections (arXiv 2506.08837) — https://arxiv.org/html/2506.08837v3
5. Cosler et al., nl2spec (CAV 2023) — https://ar5iv.labs.arxiv.org/html/2303.04864
6. NL to XACML for smart homes (SciTePress 2025) — https://scitepress.org/publishedPapers/2025/133572/pdf/index.html
7. Reparo (arXiv 2610.41800), search summary — https://arxiv.org/pdf/2610.41800
8. ClarifyGPT (FSE 2024) — https://arxiv.org/abs/2310.10996v1
9. OpenAI, Introducing Structured Outputs — https://openai.com/index/introducing-structured-outputs-in-the-api/
10. AWS, Bedrock AgentCore: writing policies in natural language — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-natural-language.html
11. AutoCedar (arXiv 2607.03656) — https://arxiv.org/abs/2607.03656
12. LLM access-control policy generation, permissiveness (arXiv 2503.11573) — https://arxiv.org/html/2503.11573v1
13. The Block, Freysa — https://www.theblock.co/post/328747/human-player-outwits-freysa-ai-agent-in-47000-crypto-challenge
14. Princeton AI Lab blog, "Real AI Agents with Fake Memories" — https://blog.ai.princeton.edu/2025/09/09/when-your-ai-assistant-gets-gaslithow-real-ai-agents-with-fake-memories-shows-that-smart-assistants-can-go-dangerously-off-script/
15. Patlan et al., arXiv 2503.16248 — https://arxiv.org/abs/2503.16248v3
16. Cointelegraph, Grok/Bankr prompt injection — https://cointelegraph.com/news/grok-bankr-wallet-free-nft-prompt-injection
17. The Block, Lobstar Wilde — https://www.theblock.co/post/390722/ai-agent-created-by-openai-dev-accidentally-sends-entire-memecoin-holdings-to-reply-guy
18. Vulnerability landscape of LLM-generated smart contracts (arXiv 2602.04039) — https://arxiv.org/abs/2602.04039v1
19. MetaMask, ERC-20 token permissions — https://docs.metamask.io/delegation-toolkit/guides/erc7715/use-permissions/erc20-token
20. Zodiac Roles, Conditions — https://docs.roles.gnosisguild.org/general/conditions
21. Brahma, Creating a policy — https://help.brahma.fi/en/articles/8955208-creating-a-policy
22. Coinbase, Agentic Wallets — https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets
23. Turnkey, Policy language — https://docs.turnkey.com/concepts/policies/language
24. Privy, Policies overview — https://docs.privy.io/controls/policies/overview
25. Circle, Custom policies — https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/custom-policies
26. EIP-7715 — https://eips.ethereum.org/EIPS/eip-7715
27. Safe, Smart account guards — https://docs.safe.global/advanced/smart-account-guards
28. Argent, How to add a guardian — https://support.argent.xyz/hc/en-us/articles/360008013258-How-to-add-a-guardian-
29. Monzo, Gambling block — https://monzo.com/ie/help/managing-money/help-gambling-block
30. NCC Group, Bybit hack analysis — https://www.nccgroup.com/research/in-depth-technical-analysis-of-the-bybit-hack/
31. Qin & Duan, wallet signing comprehension and Signature Semantic Decoder (arXiv 2601.16751, preprint) — https://arxiv.org/html/2601.16751v1
32. Brackenbury et al., How Users Interpret Bugs in Trigger-Action Programming (CHI 2019), search summary — https://par.nsf.gov/biblio/10106413
33. Brown CS blog on Ur et al. (CHI 2014) — https://blog.cs.brown.edu/2014/04/29/michael-littman-chi2014-programming-smart-home/
34. Home Office, Readability — https://design.homeoffice.gov.uk/accessibility/written-content/readability
35. DfE, Plain language standard (2025) — https://dfedigital.blog.gov.uk/2025/03/19/introducing-the-dfe-plain-language-standard/
36. Nielsen Norman Group, Confirmation dialogs, search summary — https://www.nngroup.com/articles/confirmation-dialog/
37. van der Waa et al. (2021), rule- vs example-based explanations, search summary — https://publications.tno.nl/publication/34637580/cB7b5O/waa-2021-evaluating.pdf
38. Tsuchiya et al., Blockchain Address Poisoning (arXiv 2501.16681) — https://arxiv.org/html/2501.16681v1
39. USENIX Security 2025, Blockchain Address Poisoning — https://www.usenix.org/conference/usenixsecurity25/presentation/tsuchiya
40. CMU CyLab, address poisoning (2026-01-07) — https://cylab.cmu.edu/news/2026/01/07-blockchain-address-poisoning.html
41. Etherscan, Address poisoning attacks are rising — https://info.etherscan.com/address-poisoning-attacks-are-rising-on-ethereum
42. EDPB, Guidelines 02/2025 on blockchain, v2.0 — https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_en.pdf
43. ICO, Security and data minimisation in AI — https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/guidance-on-ai-and-data-protection/how-should-we-assess-security-and-data-minimisation-in-ai
44. WebLLM (arXiv 2412.15803) — https://arxiv.org/html/2412.15803v1
45. Etherscan V2 chainlist (fetched 2026-11-22) — https://api.etherscan.io/v2/chainlist
46. GoldRush, X Layer — https://goldrush.dev/docs/chains/x-layer
47. OKLink API docs, search summary — https://oklink.com/docs/en
48. Phantom, Common token scams — https://help.phantom.com/hc/en-us/articles/37418827844755-Common-token-scams
49. OP Stack derivation spec — https://specs.optimism.io/protocol/derivation.html
50. OKX, Flashblocks on X Layer, search summary — https://web3.okx.com/learn/flashblocks-on-x-layer
51. CoinGecko simple price API, OKB/USD (last_updated 2026-11-23 ≈16:20 UTC) — https://api.coingecko.com/api/v3/simple/price?ids=okb&vs_currencies=usd&include_last_updated_at=true
52. EIP-2929 (storage gas costs used for estimates) — https://eips.ethereum.org/EIPS/eip-2929
53. OpenZeppelin, Introducing Contracts MCP — https://www.openzeppelin.com/news/introducing-contracts-mcp
54. OKX, Introducing OKX Agentic Wallet, search summary — https://web3.okx.com/learn/agentic-wallet
55. Clarify (HotNets 2025) — https://arxiv.org/pdf/2507.12443
56. Spider 2.0 (ICLR 2025) — https://arxiv.org/abs/2411.07763
57. Felt et al., Android Permissions: User Attention, Comprehension, and Behavior (SOUPS 2012), search summary — https://research.google/pubs/android-permissions-user-attention-comprehension-and-behavior/

**Repo files cited** (paths from the repo root, read 2026-11-22/23)

- `contracts/src/CircuitWillEscrow.sol` — enum 37-44; `AttachedCircuit` 61-66; `MAX_CIRCUITS` 97; `GAS_RESERVE` 109-110; eval gas default 112-117, 158; daily spend 131-136, 316-323, 352-359; `controller()` 267-269; agent 271-274; proposer check 290; `withdraw` 296-303; evaluation loop and AND combination 327-352, 384-417, 436-448; `_ageHours` 419-426; `_confirmationFor` 430-434; `attachCircuit` 598-618 (pinout check 609-612, duplicate kind 605); `detachCircuit` 621-628.
- `contracts/src/libraries/TapeOutEval.sol` 9-15, 37-71; `DailyCapPacking.sol` 5-23; `LittleEndian.sol` 4-14.
- `contracts/script/Deploy.s.sol` 99-117.
- `contracts/test/MultiCircuit.t.sol` 94, 715-781.
- `docs/RULE_SUGGESTIONS.md` 29-30, 124-128, 153-155, 165-168, 175-181, 205-206, 220, 225, 247.
- `docs/MAINNET_RUNBOOK.md` 89, 105-108, 417, 422.
- `docs/TAPEOUT_INTERFACE.md` 35-37, 43-45, 61, 65-67.
- `frontend/app.js` 734-753, 1881-1885; `frontend/lib/xray.js` 78-89, 351-414, 533-537; `frontend/lib/preview.js` 148-171; `frontend/lib/reeval.js` 143-150; `frontend/test/memory.test.mjs` 243-296.
- `circuits/daily-cap/build.mjs` 3-7, 43-67, 92-101; `circuits/lib/tap02.mjs`.
