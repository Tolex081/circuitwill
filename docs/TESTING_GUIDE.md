# CircuitWill: a beginner's testing guide

This guide walks you through testing everything built so far, one step at a time. You do not need to know how the
code works. Each step says **what to type or click**, **what you should see**, and **what to do if it goes wrong**.

Everything here runs **on your own computer** with fake test money. Nothing touches real X Layer funds, and nothing
here can lose you money.

Tick each box as you go. Write anything strange in the [results log](#results-log) at the bottom, so the next
building session can fix it straight away.

---

## Part 0 — What you are testing (2-minute read)

CircuitWill is a "money will": a safe-box for USDT0 whose rules are tiny logic circuits (made of NAND gates, taped
out on TapeOut). There are four rules:

| Rule (dashboard name) | What it does |
|---|---|
| **Daily limit** | No more than X USDT0 can leave per day |
| **Trusted recipients** | Only saved addresses can be paid freely; new addresses wait (cooling-off) and get a small trial limit |
| **Approval** | Payments above a set amount need the owner to approve that exact payment first |
| **Freeze** | One switch that blocks every payment |

Pieces you will test:

1. **Circuits** — the four rule circuits and their simulator (Node.js tests).
2. **Smart contracts** — the escrow and the key NFT (Foundry tests).
3. **Dashboard** — the website, run against a fake copy of X Layer on your computer (called an "anvil fork").
4. **New features** — Circuit X-ray, Payment preview, Verify a decision.
5. **The public website** on Vercel (read-only).

> **Words you will see:** *Terminal* = a PowerShell window. *anvil* = a fake blockchain running on your computer.
> *Fork* = anvil copies X Layer's real state so the real TapeOut contracts exist locally. *Escrow* = the will's
> safe-box contract. *Key NFT* = the token that makes you the owner of a will.

---

## Part 1 — One-time setup check (5 minutes)

Open **PowerShell** (Start menu → type "PowerShell" → Enter). Go to the project folder:

```powershell
cd C:\Users\HELLO\Documents\circuitwill
```

Make sure Foundry's tools can be found in this window (run this once per new PowerShell window):

```powershell
$env:PATH += ";$env:USERPROFILE\.foundry\bin"
```

Now check the tools:

```powershell
node --version
```

```powershell
forge --version
```

```powershell
anvil --version
```

- [ ] `node` shows **v20** or higher
- [ ] `forge` and `anvil` each print a version (for example `1.9.0`)

**If it fails:** "not recognized" means the PATH line above wasn't run in *this* window. Run it again.

---

## Part 2 — Test the circuits (3 minutes)

These check that each rule circuit gives the right answer for thousands of test payments.

```powershell
cd C:\Users\HELLO\Documents\circuitwill\circuits
```

```powershell
npm run build
```

```powershell
npm test
```

- [ ] `npm run build` finishes with no red error text
- [ ] `npm test` ends with a summary where **fail 0**

Then check the build didn't change any committed file (it shouldn't):

```powershell
git status --short circuits
```

- [ ] Prints **nothing** (no files listed)

**If it fails:** copy the last 30 lines of red text into the results log.

---

## Part 3 — Test the smart contracts (5 minutes)

```powershell
cd C:\Users\HELLO\Documents\circuitwill\contracts
```

```powershell
forge build
```

```powershell
forge test
```

- [ ] `forge build` says `Compiler run successful` (warnings in yellow are OK)
- [ ] `forge test` ends with something like `Ran N test suites: X tests passed, 0 failed, Y skipped`
- [ ] **0 failed**. Some *skipped* tests are normal (the fork tests skip unless you turn them on, see below)

### 3a. The new "Key NFT picture" feature (not committed yet)

You have an unfinished change: the Key NFT now carries its own picture and warning text. Test just that:

```powershell
forge test --match-contract CircuitWillKeyTest -vv
```

- [ ] All `CircuitWillKeyTest` tests pass

Want to *see* the picture? This prints the image as text you can paste into a browser:

```powershell
forge test --match-test test_tokenURI_isOnChainJsonWithSvg -vvvv
```

(Optional — if it's hard to read, skip it. The next session can show it properly.)

### 3b. Code style check

```powershell
forge fmt --check
```

- [ ] Prints nothing (means formatting is fine). If it lists files, just note it in the log; it's cosmetic.

### 3c. Optional: test against the *real* X Layer state (needs internet, ~5–10 min)

This reads real X Layer data and simulates locally. It sends nothing.

```powershell
$env:XLAYER_FORK_RPC = "https://rpc.xlayer.tech"; forge test --match-path test/fork/TapeOutFork.t.sol -vv
```

- [ ] Tests pass. If it fails with "timeout" or "429", the public server is busy: try again later, not a bug.

---

## Part 4 — Test the dashboard's own logic (2 minutes)

```powershell
cd C:\Users\HELLO\Documents\circuitwill\frontend
```

```powershell
npm test
```

- [ ] Ends with **fail 0** (this covers amounts, memory isolation, X-ray and Payment preview math)

---

## Part 5 — Run the dashboard on a fake X Layer (the main event)

You need **three PowerShell windows** open at the same time. Don't close any of them while testing.

### Window 1 — start the fake blockchain

```powershell
$env:PATH += ";$env:USERPROFILE\.foundry\bin"; anvil --fork-url https://rpc.xlayer.tech --fork-block-number 76350000 --retries 20 --fork-retry-backoff 1500 --compute-units-per-second 50
```

- [ ] It prints a list of accounts and ends with `Listening on 127.0.0.1:8545`
- Leave this window alone. It will print lines as you use the dashboard; that's normal.

### Window 2 — set up test circuits and test money

```powershell
cd C:\Users\HELLO\Documents\circuitwill\frontend; powershell -ExecutionPolicy Bypass -File scripts/setup-anvil.ps1
```

This takes a few minutes. It tapes out the four circuits on the fake chain and gives a test owner 500 fake USDT0.

- [ ] It finishes without a red error and says it wrote `local-config.json`
- **Important:** every time you restart Window 1 (anvil), you must run this again. Anvil forgets everything when it stops.

**If it fails with RPC errors:** the public X Layer server was slow. Stop anvil (Ctrl+C in Window 1), start it
again, and rerun this.

### Window 3 — start the website

```powershell
cd C:\Users\HELLO\Documents\circuitwill; node frontend/serve.mjs
```

Open your web browser at: **http://127.0.0.1:5173/frontend/**

- [ ] The page loads and the top bar badge says **Test network · not real money**

---

## Part 6 — Click-through tests on the dashboard

Use the test addresses from `frontend\local-config.json` (open it in Notepad). You will need:

- **payee** — an address you will trust
- **newPayee** — an address you will *not* trust
- **agent** — the AI helper

### 6.1 Welcome screen

- [ ] You see what a CircuitWill is, an **Example** will, "how it works" in three steps, and common questions
- [ ] Switch dark/light theme: everything stays readable
- [ ] Press **Use the test owner account**: the page shows you as connected

### 6.2 Create a will

Press **Create a CircuitWill** and fill the 3 steps with these exact numbers (they match the tests below):

| Setting | Value |
|---|---|
| Daily limit | **50** USDT0 |
| Trusted recipients | ON — trial limit **5** USDT0, waiting time **24** hours |
| Approval | ON — above **20** USDT0 |
| Freeze | ON (the rule exists; the will is not frozen yet) |
| AI helper (step 2) | paste the **agent** address |

- [ ] Step 3 shows a review and a live checklist; every item turns done
- [ ] You land on the **Overview** of your new will. Header says role **Owner**
- [ ] Write the will's address in the results log (handy later)

### 6.3 Add money

- [ ] On **Overview**, use **Add money** with **100** USDT0 → balance shows **100**

### 6.4 Trust a recipient

- [ ] **Rules** tab → Trusted recipients → add the **payee** address as trusted

### 6.5 Payment tests — Send tab

For each row: type the recipient and amount, **read the Preview card first**, then press **Send payment**, then
compare the result. The preview and the real result should **always agree**.

| # | To | Amount | Preview should say | Result should be |
|---|---|---|---|---|
| A | payee | 10 | would go through, 10 of 50 used | **Payment sent**. Balance 90 |
| B | payee | 25 | blocked: needs your approval (offers **Approve this payment**) | **Payment blocked** (Approval) |
| C | payee | 25 | press **Approve this payment** first → preview turns to *would go through* | **Payment sent**. 35 of 50 used |
| D | payee | 20 | blocked: today's spending would reach 55, over 50 | **Payment blocked** (Daily limit) |
| E | newPayee | 3 | blocked: not on your trusted list yet | **Payment blocked** (Trusted recipients) |
| F | payee | 5000 | — | Rejected in the form **before** any transaction (too big) |

- [ ] A ✓  - [ ] B ✓  - [ ] C ✓  - [ ] D ✓  - [ ] E ✓  - [ ] F ✓
- [ ] Every blocked result explains **why** in plain English
- [ ] Blocked payments did **not** move money (check balance on Overview)

### 6.6 Freeze

- [ ] **Rules** → Freeze → freeze the will. A banner with **Unfreeze** appears in the header
- [ ] Send **1** USDT0 to payee → preview says blocked: frozen → result **Payment blocked** (Freeze)
- [ ] Press **Unfreeze**, send 1 USDT0 again → **Payment sent**

### 6.7 History, Verify, and Circuit X-ray

Open the **History** tab.

- [ ] Every payment you tried is listed as *Sent* or *Blocked* with a one-line reason
- [ ] Expand one → press **Verify this decision** → all checks pass (green)
- [ ] Press **See the circuits work** → a gate diagram appears and lights up left to right
- [ ] Switch between rules in the picker (Daily limit ≈ 447 gates, Trusted ≈ 237, Approval ≈ 160, Freeze = 1)
- [ ] Tap a gate: it shows its inputs and output. Try − / Fit / + zoom
- [ ] **No red "Mismatch"** and no "circuit changed" warning
- [ ] On the Send tab, the Preview's **See the circuits** link also opens an X-ray (worded "would be")

### 6.8 Act as the AI helper

At the bottom of the page: **Network settings** → developer mode → choose the **agent** account.

- [ ] Header role says **AI helper**
- [ ] Send **2** USDT0 to payee → **Payment sent**
- [ ] Send **25** USDT0 to payee → blocked, and it tells you to **ask the owner** to approve (no approve button for the helper)
- [ ] The helper **cannot** change rules or withdraw (Rules tab is read-only)

Switch back to the owner account afterwards.

### 6.9 Withdraw (owner)

- [ ] Send tab → **Withdraw** 1 USDT0 to the payee → it is checked by the same rules and succeeds

### 6.10 View-only mode

- [ ] Open a **private/incognito** browser window at `http://127.0.0.1:5173/frontend/` → **View a CircuitWill** →
  paste your will's address
- [ ] Role says **View only**; you can see everything but cannot send or change rules

### 6.11 Phone size

- [ ] Make the browser window narrow (about phone width) or press F12 → phone icon. Nothing overlaps or runs off screen

### 6.12 Optional: time travel (tests the next day and the 24 h waiting time)

In a **fourth** PowerShell window, jump the fake clock forward 25 hours:

```powershell
$env:PATH += ";$env:USERPROFILE\.foundry\bin"; cast rpc evm_increaseTime 90000; cast rpc evm_mine
```

Back in the dashboard (refresh the page):

- [ ] Overview: **spent today** went back to 0 (a new day started)
- [ ] Send tab → the Preview mentions the new day
- [ ] **Rules** → add **newPayee** (not trusted) *before* jumping time, then after the jump send it **3** USDT0
  (under the 5 trial limit) → **Payment sent**, because the 24 h wait is over

### 6.13 Optional: Walrus Memory toggle

- [ ] Turn memory ON (it's off by default). Hints appear beside the Send form, clearly labelled as a **stub**
- [ ] Hints never fill in or submit the form; turning it OFF hides them

### 6.14 Optional: verify from the command line

Copy a transaction hash from **Advanced** → transaction log (a payment), then in Window 2:

```powershell
cd C:\Users\HELLO\Documents\circuitwill; node frontend/scripts/reevaluate.mjs PASTE_TX_HASH_HERE http://127.0.0.1:8545
```

- [ ] Ends saying every check passed

---

## Part 7 — The public website (5 minutes)

Open **https://circuitwill.vercel.app/**

- [ ] Loads; the badge says **X Layer** (real network, read-only)
- [ ] Welcome screen, Example will, and FAQ all read well; dark/light both work
- [ ] It works on your phone too
- **Expected and not a bug:** you can't create a real will yet, because nothing is deployed on X Layer mainnet
  (the official circuit set is empty until the mainnet tapeout).

---

## When you're done

1. In Windows 1 and 3 press **Ctrl+C** to stop anvil and the website.
2. Fill in the results log below and save this file.
3. In your next building session, say: *"Read docs/TESTING_GUIDE.md results log and fix what failed."*

### Known limits (not bugs)

- Nothing is deployed on X Layer mainnet yet; the mainnet runbook (`docs/MAINNET_RUNBOOK.md`) is ready but not run.
- Walrus Memory in the browser is a labelled local stub, not connected to Walrus.
- The Key NFT picture change (Part 3a) is uncommitted, and the dashboard still uses the previous Key contract build.
- If the public X Layer server is slow, anvil and the setup script may fail. Restart them; that's the network, not CircuitWill.

---

## Results log

Fill in as you go. "✓" for pass, "✗" plus a short note for fail.

| Part | Result | Notes (copy error text or describe what you saw) |
|---|---|---|
| 1 Setup | | |
| 2 Circuits | | |
| 3 Contracts | | |
| 3a Key NFT | | |
| 3c Fork test (optional) | | |
| 4 Dashboard logic | | |
| 5 Local dashboard runs | | |
| 6.2 Create will | | Will address: |
| 6.5 Payments A–F | | |
| 6.6 Freeze | | |
| 6.7 History / Verify / X-ray | | |
| 6.8 AI helper | | |
| 6.9 Withdraw | | |
| 6.10 View only | | |
| 6.11 Phone size | | |
| 6.12 Time travel (optional) | | |
| 6.13 Memory (optional) | | |
| 7 Public site | | |

Anything confusing, ugly, or worded badly? Write it here too. Novice feedback is exactly what the next session needs:

-
