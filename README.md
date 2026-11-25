# CircuitWill

**A money will for your crypto, enforced by on-chain logic circuits.**

You put USDT0 in a CircuitWill and set rules for how it can leave: a daily limit, trusted recipients, approval for
big payments, a freeze switch. Every payment, including one proposed by an AI agent, is checked by small NAND-gate
circuits taped out on [TapeOut](https://github.com/TapeOutProtocol) (X Layer). If a circuit says no, the money does
not move. No button, agent or server can override it.

**Dashboard:** <https://circuitwill.vercel.app/>

> **Status:** built and tested end to end on a local copy of X Layer mainnet. Not yet deployed to mainnet, so the
> public dashboard has no live will to open yet. The mainnet steps are ready in
> [`docs/MAINNET_RUNBOOK.md`](docs/MAINNET_RUNBOOK.md).

## How it works

```
 You or your AI agent                CircuitWill escrow                  TapeOut circuits
 ────────────────────       ───────────────────────────────       ─────────────────────────
 "Pay 30 USDT0 to Ana"  ──▶  packs the facts for each rule  ──▶   Daily limit      ALLOW
                             (amount, spent today, ...)           Trusted list     ALLOW
                                                                   Approval         DENY
                        ◀──  all ALLOW? send the money.    ◀──    Freeze           ALLOW
                             any DENY? block it and record why.
```

| Rule | What it does |
|---|---|
| **Daily limit** | At most X USDT0 can leave per day. |
| **Trusted recipients** | New addresses wait a cooling-off period and can only receive a small trial amount. |
| **Approval** | Payments above X need the owner to approve that exact payment first. |
| **Freeze** | One switch that blocks everything. |
| **Custom rules** | Write a rule as a sentence ("no more than 200 USDT0 in any 7 days"). It is compiled into a NAND circuit you can see before you sign. |

Three things make it trustworthy:

- **The owner is whoever holds the key NFT.** Hand the NFT over, and control goes with it.
- **The AI agent can only propose payments.** It cannot change rules or withdraw.
- **Every decision is public and can be re-checked.** Anyone can re-run the circuits on the recorded inputs with the
  dashboard's **Verify** button. Changes that loosen a rule wait 24 hours (by default) before they apply.

## Try it

You need [Node.js 20+](https://nodejs.org), [Foundry](https://getfoundry.sh) and Git. Clone the repository with its
two contract libraries:

```powershell
git clone --recursive https://github.com/Tolex081/circuitwill.git
```

```powershell
cd circuitwill
```

### 1. Run the tests

```powershell
cd circuits; npm test; cd ..
```

```powershell
cd contracts; forge test; cd ..
```

```powershell
cd frontend; npm test; cd ..
```

### 2. Use the dashboard with test money

This starts a local copy of X Layer, with fake money and the real TapeOut contracts. Use three terminals, each
started in the `circuitwill` folder.

Terminal 1, the local chain (leave it running):

```powershell
anvil --fork-url https://rpc.xlayer.tech --fork-block-number 76350000 --retries 20 --fork-retry-backoff 1500 --compute-units-per-second 50
```

Terminal 2, tape out the circuits and fund a test account (once per anvil start):

```powershell
cd frontend; powershell -ExecutionPolicy Bypass -File scripts/setup-anvil.ps1
```

Terminal 3, the website (leave it running):

```powershell
node frontend/serve.mjs
```

Open <http://127.0.0.1:5173/frontend/>, press **Use the test owner account**, then **Create a CircuitWill**. Add
money, send a payment, try one that breaks a rule, and open **History** to see why it was blocked. **See the circuits
work** shows every gate of the circuit that decided it.

## What's in the repository

| Folder | What it is |
|---|---|
| [`contracts/`](contracts) | The escrow and the key NFT, in Solidity (Foundry) |
| [`circuits/`](circuits) | Generators for the rule circuits (NAND netlists) and a simulator to test them |
| [`frontend/`](frontend) | The dashboard: plain HTML and JavaScript, no build step |
| [`docs/`](docs) | Technical reference, mainnet runbook, original spec and design notes |

## Learn more

- [`docs/TECHNICAL.md`](docs/TECHNICAL.md): every function, circuit pinout, event, test record and known limitation
- [`docs/MAINNET_RUNBOOK.md`](docs/MAINNET_RUNBOOK.md): how to deploy to X Layer mainnet, with a cost estimate
- [`docs/SPEC.md`](docs/SPEC.md): the original product spec
- [`docs/TAPEOUT_INTERFACE.md`](docs/TAPEOUT_INTERFACE.md): what is verified about TapeOut and what is not
- [`docs/RULE_BUILDER_RESEARCH.md`](docs/RULE_BUILDER_RESEARCH.md): how custom rules are designed

**Main limitations:** not on mainnet yet; each amount or limit is at most about 4,294 USDT0 (32-bit circuits); TapeOut
itself is unaudited and upgradeable by its owner; the optional Walrus Memory hints use a local stand-in in the
browser. The full list is in [Known limitations](docs/TECHNICAL.md#known-limitations).
