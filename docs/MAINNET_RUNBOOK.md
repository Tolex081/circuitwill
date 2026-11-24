# CircuitWill mainnet runbook (X Layer, chain 196)

**Status: prepared, not executed.** Nothing in this document has been broadcast to X Layer. No CPU, circuit, escrow
or website exists on mainnet for CircuitWill. Every step was rehearsed on a local anvil fork of the latest mainnet
block (see [Dry run](#dry-run-2026-11-20)); you broadcast each step yourself, from your own Foundry keystore.

> **Re-measured on 2026-11-24.** On 2026-11-23 the escrow gained custom rules (`attachCustomRule`) and the
> loosening delay (`queueChange` / `applyChange`, 24 h by default). The dry run was re-run on that contract
> ([Dry run 2026-11-24](#dry-run-2026-11-24-custom-rules-and-the-delay)) and passed; the cost estimate below uses
> its figures. The steps themselves are unchanged, except for the larger NAND supply cap in step 1. It was run
> again the same day after the security review (custom rules now declare who they limit), and the figures below
> are from that second run.

Rules for every step:

- **Keys.** Commands sign with `--account <keystore name>` (an encrypted Foundry keystore that asks for its password).
  Never pass `--private-key`, never put a key or seed phrase in a file, an environment variable or this repository.
- **Simulate first.** Every `forge script` command is run twice: first **without** `--broadcast` (simulation only, it
  spends nothing), then again with `--broadcast` once the output looks right. `cast call` is always read-only;
  `cast send` always broadcasts.
- **One terminal.** Run everything in one PowerShell window, so the variables you set stay available.

## 0. What you need

| Item | Amount | Why |
|---|---|---|
| OKB (gas + fees) | **≥ 0.01 OKB** (≈ 0.0055 OKB expected, see [Cost](#cost-estimate)) | 4 × 0.0013 OKB tapeout fee + ≈ 13.7M gas |
| BEM | **0.11 BEM** (11,000,000 base units, 8 decimals) | 0.1 BEM `deployFee` (createCPU) + 0.01 BEM `protocolFee` (one mint call) |
| USDT0 | **60 USDT0** for the demo | not spent: 30 goes to your own payee address, 30 stays in the escrow |
| A Foundry keystore | one account | the deployer becomes the CPU creator, NAND holder and CircuitWill controller |
| A second address you control | – | the demo payee (saved in the whitelist) |
| An OKLink API key (optional) | free | contract verification on the OKLink explorer ([step 6](#6-verify-the-contracts)) |

Create or import the keystore yourself, in your own terminal; this project never sees the key:

```powershell
cast wallet import circuitwill-deployer --interactive
```

`--interactive` asks for the private key and a password without echoing them. `cast wallet list` shows the names.

### Pre-flight (read-only)

```powershell
$env:PATH += ";$env:USERPROFILE\.foundry\bin"
$Rpc = "https://rpc.xlayer.tech"
$Account = "circuitwill-deployer"
$Me = cast wallet address --account $Account
$Payee = "<second address you control>"
$Factory = "0x1f09DAeFA827f02CBb40967cc91b259763760761"
$Bem = "0x60e62Efa9405d6873C5deaBD4E6CC91c25363952"
$Usdt0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"
```

```powershell
cast chain-id --rpc-url $Rpc; cast code $Me --rpc-url $Rpc; cast balance $Me --ether --rpc-url $Rpc; cast call $Bem "balanceOf(address)(uint256)" $Me --rpc-url $Rpc; cast call $Usdt0 "balanceOf(address)(uint256)" $Me --rpc-url $Rpc
```

Expect `196`, then **`0x`**, then your OKB, BEM (≥ 11000000) and USDT0 (≥ 60000000) balances.

`cast code $Me` must print `0x`. Some wallets give accounts EIP-7702 delegation code. TapeOut's NAND `mint` is an
ERC-1155 mint, and it reverts with `ERC1155InvalidReceiver` for an address with code that does not accept ERC-1155
tokens. This happened to anvil's default accounts on the fork. Use an address without code.

Check that TapeOut has not changed since this runbook was written. The proxies are owner-upgradeable
(`isSealed() == false`):

```powershell
cast storage $Factory 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $Rpc; cast call 0xf70d1ed4F62Cf3780157b0B421b7e2f45Bd0991C "implementation()(address)" --rpc-url $Rpc; cast call $Factory "deployFee()(uint256)" --rpc-url $Rpc; cast call $Factory "protocolFee()(uint256)" --rpc-url $Rpc
```

| Read | Expected (2026-11-20) |
|---|---|
| factory implementation (EIP-1967 slot) | `…336e9f0f4c3fee7c8c803377e4dea00293f4ae2a` |
| circuits beacon implementation | `0x977f217887E085D298Cb3819cDAD5A0ee35F29B2` |
| `deployFee()` | `10000000` (0.1 BEM) |
| `protocolFee()` | `1000000` (0.01 BEM) |

If any value differs, stop. Re-run the [dry run](#dry-run-2026-11-20) against a fresh fork, and update the amounts
below before you spend anything.

## 1. Create your TapeOut CPU (0.1 BEM)

`createCPU` is non-payable. It pulls `deployFee()` in BEM with `transferFrom`, so approve exactly that amount (not an
unlimited allowance):

```powershell
cast send $Bem "approve(address,uint256)" $Factory 10000000 --account $Account --rpc-url $Rpc
```

```powershell
$Index = (cast call $Factory "cpuCount()(uint256)" --rpc-url $Rpc).Split(" ")[0]; $Index
```

```powershell
cast send $Factory "createCPU(string,string,string,uint256,uint256)" "CircuitWill" "CWILL" "CircuitWill rule circuits" 1000000 0 --account $Account --rpc-url $Rpc
```

Copy the `transactionHash` it prints, then find the new CPU's circuits contract (the **processor**):

```powershell
$CpuTx = "<transactionHash of createCPU>"
$Circuits = cast call $Factory "cpus(uint256)(address)" $Index --rpc-url $Rpc
cast call $Factory "isCPU(address)(bool)" $Circuits --rpc-url $Rpc
(cast receipt $CpuTx --json --rpc-url $Rpc | ConvertFrom-Json).logs.address -contains $Circuits.ToLower()
```

Expect `true`, then `True`. The second check confirms that `cpus($Index)` is the CPU your transaction created, and
not one that someone else created in the same block. If it prints `False`, set
`$Circuits = cast call $Factory "cpus(uint256)(address)" ([int]$Index + 1) --rpc-url $Rpc` and check again.

The last two `createCPU` arguments are the NAND supply cap (`1000000`) and the NAND mint price (`0`). The cap counts
every NAND ever minted on this CPU, even ones already burned by a tapeout, and it is fixed for the CPU's life
(measured on a fork, 2026-11-23: after 10,000 minted, the next `mint(0, 1)` failed with `"supply cap"`). The earlier
rehearsals used `10000`. That would leave only about 9,155 NAND after the four official circuits, which is about 50
custom rules (each custom rule is taped out once and uses up to 1,000 NAND). A cap of 1,000,000 worked on the fork.
With `0` as the NAND mint price, anyone can mint NAND on your CPU and pay only TapeOut's protocol fee. This does not
affect CircuitWill: a taped-out circuit cannot be changed, and the escrow records its `netlistHash` when it is
attached.

## 2. Mint 845 NAND (0.01 BEM)

The four circuits need 447 + 237 + 160 + 1 = **845** NAND transistors (ERC-1155 id 0 of your CPU). `mint` is
non-payable and pulls `protocolFee()` = 0.01 BEM **per call** (measured on the fork: one call minting 845 cost
0.01 BEM, and so did one minting 1). Mint all 845 in one call.

```powershell
$Transistors = cast call $Circuits "transistors()(address)" --rpc-url $Rpc; $Transistors
```

```powershell
cast send $Bem "approve(address,uint256)" $Transistors 1000000 --account $Account --rpc-url $Rpc
```

```powershell
cast send $Transistors "mint(uint256,uint256)" 0 845 --account $Account --rpc-url $Rpc
```

```powershell
cast call $Transistors "balanceOf(address,uint256)(uint256)" $Me 0 --rpc-url $Rpc
```

Expect `845`.

## 3. Tape out the four circuits (4 × 0.0013 OKB)

`contracts/script/TapeOutCircuit.s.sol` reads `circuits/<name>/build/<name>.netlist.hex`, checks that you hold
enough NAND, sends `TAPEOUT_FEE()` (0.0013 OKB) with `tapeout`, and checks `circuitInfo` afterwards. Each tapeout
burns one NAND per gate and mints you a circuit NFT. Run it from `contracts/`:

```powershell
cd contracts; $env:TAPEOUT_CIRCUITS = $Circuits
```

For each circuit, simulate first (**no `--broadcast`**):

```powershell
$env:CIRCUIT = "daily-cap"; forge script script/TapeOutCircuit.s.sol --rpc-url xlayer --account $Account --sender $Me
```

The simulation ends with `circuit id: <n>` and `SIMULATION COMPLETE`. Then broadcast the same command with
**`--broadcast` added at the end**:

```powershell
forge script script/TapeOutCircuit.s.sol --rpc-url xlayer --account $Account --sender $Me --broadcast
```

Write down the `circuit id` printed by the broadcast run. Repeat both commands with `$env:CIRCUIT` set to
`"payee-whitelist"`, `"confirmation"` and `"freeze"`. On the fork, a new CPU numbered its circuits 1, 2, 3, 4 in
this order. Use the ids your broadcast runs print.

```powershell
$CapId = "<daily-cap id>"; $WlId = "<payee-whitelist id>"; $ConfId = "<confirmation id>"; $FrzId = "<freeze id>"
cast call $Transistors "balanceOf(address,uint256)(uint256)" $Me 0 --rpc-url $Rpc
```

Expect `0` NAND left. `forge script` keeps its records in `contracts/broadcast/TapeOutCircuit.s.sol/196/`
(git-ignored); it holds addresses and transaction hashes only, no keys.

## 4. Deploy and configure the escrow

`contracts/script/Deploy.s.sol` deploys a `CircuitWillKey` and mints controller NFT #1 to you. It then deploys
`CircuitWillEscrow` (USDT0, that key, token id, TapeOut factory), sets every parameter, and then attaches each
circuit. That is 13 transactions for this configuration (14 if you set `AGENT`). The order matters: until the first
circuit is attached, every setting applies at once. After that, tightening a rule still applies at once, but any
change that loosens one (a higher cap, saving a payee, unfreezing, removing a circuit) reverts with
`LooseningIsDelayed` and has to go through `queueChange`, wait `ruleDelay()` (24 h), then `applyChange`. The demo values are a cap of 50
USDT0, a trial limit of 5, a 24 h cooling-off and a confirmation threshold of 20:

```powershell
$env:DAILY_CAP_CIRCUIT_ID = $CapId; $env:DAILY_CAP = "50000000"; $env:WHITELIST_CIRCUIT_ID = $WlId; $env:TRIAL_LIMIT = "5000000"; $env:COOLING_OFF_HOURS = "24"; $env:SAVED_PAYEES = "$Payee,$Me"; $env:CONFIRMATION_CIRCUIT_ID = $ConfId; $env:CONFIRMATION_THRESHOLD = "20000000"; $env:FREEZE_CIRCUIT_ID = $FrzId
```

`SAVED_PAYEES` includes your own address, so you can withdraw to it later. Leave `AGENT` unset for the demo, or set
`$env:AGENT = "<agent address>"` to appoint one.

Simulate (**no `--broadcast`**):

```powershell
forge script script/Deploy.s.sol --rpc-url xlayer --account $Account --sender $Me
```

Check the printed `CircuitWillEscrow`, `controller NFT` and `controller token id` lines and `SIMULATION COMPLETE`.
Then broadcast. **`--broadcast` goes at the end, and `--slow`** sends the 13 transactions one at a time (each waits
for the previous receipt):

```powershell
forge script script/Deploy.s.sol --rpc-url xlayer --account $Account --sender $Me --broadcast --slow
```

You can add verification to this same command; see the next step for the flags. Record the addresses:

```powershell
$Escrow = "<CircuitWillEscrow address>"; $Key = "<controller NFT address>"; $TokenId = "<controller token id>"
cast call $Escrow "controller()(address)" --rpc-url $Rpc; cast call $Escrow "circuitCount()(uint256)" --rpc-url $Rpc; cast call $Escrow "dailyCap()(uint256)" --rpc-url $Rpc
```

Expect your address, `4` and `50000000`. The dashboard reads decisions from the deployment block onwards:

```powershell
$DeployBlock = [Convert]::ToInt64((Get-Content broadcast/Deploy.s.sol/196/run-latest.json -Raw | ConvertFrom-Json).receipts[0].blockNumber, 16); $DeployBlock
```

## 5. (alternative) Verify while deploying

X Layer's own guide verifies through OKLink with
`--verifier oklink --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/{chainShortName}`
([OKX: Verifying with Foundry](https://web3.okx.com/onchainos/dev-docs/xlayer/developer/verify-a-smart-contract/verify-with-foundry)).
The short name for mainnet is `XLAYER`, and the OKLink API key comes from "My account → API management" on
oklink.com, free
([OKX: Verifying with Hardhat](https://web3.okx.com/onchainos/dev-docs/xlayer/developer/verify-a-smart-contract/verify-with-hardhat)).
The guide also says to wait at least one minute after deploying.

To verify in the same run, append **`--verify` and the verifier flags after `--broadcast`**. `--delay`/`--retries`
cover the one-minute wait:

```powershell
$env:OKLINK_API_KEY = "<your OKLink API key>"
```

```powershell
forge script script/Deploy.s.sol --rpc-url xlayer --account $Account --sender $Me --broadcast --slow --verify --verifier oklink --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER --verifier-api-key $env:OKLINK_API_KEY --delay 30 --retries 10
```

Set the API key only in the terminal session; never in a file. If verification fails here, the deployment is still
complete. Verify afterwards with step 6, and do not run the deploy command again.

## 6. Verify the contracts

```powershell
$OkUrl = "https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER"
forge verify-contract $Key src/CircuitWillKey.sol:CircuitWillKey --chain 196 --verifier oklink --verifier-url $OkUrl --verifier-api-key $env:OKLINK_API_KEY --watch
```

```powershell
$CtorArgs = cast abi-encode "constructor(address,address,uint256,address)" $Usdt0 $Key $TokenId $Factory
forge verify-contract $Escrow src/CircuitWillEscrow.sol:CircuitWillEscrow --chain 196 --constructor-args $CtorArgs --verifier oklink --verifier-url $OkUrl --verifier-api-key $env:OKLINK_API_KEY --watch
```

Run these from `contracts/`. Forge takes the compiler settings from `foundry.toml` (solc 0.8.28, `via_ir`,
optimizer 200 runs, `cancun`); no libraries need linking.

Without an OKLink key, Sourcify takes chain 196 and needs no key (from a third-party guide,
[Chainstack: X Layer tooling](https://docs.chainstack.com/docs/xlayer-tooling)). Sourcify verification does not
necessarily show on the OKLink explorer.

```powershell
forge verify-contract $Escrow src/CircuitWillEscrow.sol:CircuitWillEscrow --chain 196 --constructor-args $CtorArgs --verifier sourcify --watch
```

**Not tested here:** no verification request was sent by this project, because nothing is deployed. OKLink's
handling of a `via_ir` build is therefore unconfirmed. If it rejects the source, use Sourcify, or OKLink's manual
verification with the standard JSON input from
`forge verify-contract … --show-standard-json-input`.

Explorer: the official block explorer for X Layer mainnet is `https://www.okx.com/web3/explorer/xlayer`
([OKX: Network information](https://web3.okx.com/onchainos/dev-docs/xlayer/developer/build-on-xlayer/network-information)),
and OKLink's X Layer browser is `https://www.oklink.com/xlayer` (OKX Hardhat guide). Neither page documents an
address or transaction URL pattern. `…/address/<address>` and `…/tx/<hash>` are the usual form, but they were not
checked. Open them once and copy the link that works.

## 7. Fund the escrow

A plain USDT0 transfer. Its balance is the escrow's balance:

```powershell
cast send $Usdt0 "transfer(address,uint256)" $Escrow 60000000 --account $Account --rpc-url $Rpc
```

```powershell
cast call $Usdt0 "balanceOf(address)(uint256)" $Escrow --rpc-url $Rpc
```

Expect `60000000`.

## 8. Demo transactions (handoff section 5)

The threshold is 20 USDT0, so each demo payment is confirmed first. Then the Daily Cap is the only rule that decides
the outcome. The 60 is blocked first, so the escrow still holds 60 and "blocked" cannot be put down to a low
balance. A confirmation expires after one hour, so send each `proposePayment` soon after its `confirmPayment`.

**Blocked: 60 USDT0 with Daily Cap 50**

```powershell
$H60 = cast call $Escrow "currentPaymentHash(address,uint256)(bytes32)" $Payee 60000000 --rpc-url $Rpc
cast send $Escrow "confirmPayment(bytes32)" $H60 --account $Account --rpc-url $Rpc
```

```powershell
cast send $Escrow "proposePayment(address,uint256,string)" $Payee 60000000 "demo: 60 over the daily cap" --account $Account --rpc-url $Rpc
```

The transaction **succeeds** (status 1), moves no funds, and records decision #1 as `BLOCKED (CIRCUIT_DENIED)`: Daily
Cap DENY, Whitelist, Confirmation and Freeze ALLOW. `cast` uses `eth_estimateGas` (about 2.4M), which is enough;
see the README, "Gas estimation works". Copy the `transactionHash` as `$TxBlocked`.

**Allowed: 30 USDT0**

```powershell
$H30 = cast call $Escrow "currentPaymentHash(address,uint256)(bytes32)" $Payee 30000000 --rpc-url $Rpc
cast send $Escrow "confirmPayment(bytes32)" $H30 --account $Account --rpc-url $Rpc
```

```powershell
cast send $Escrow "proposePayment(address,uint256,string)" $Payee 30000000 "demo: 30 within the daily cap" --account $Account --rpc-url $Rpc
```

Decision #2 is `ALLOWED`. Your payee address receives 30 USDT0, `currentSpentToday()` becomes `30000000`, and the
confirmation is consumed (`paymentNonce($Payee)` = 1). Copy the `transactionHash` as `$TxAllowed`.

**Re-evaluate both (read-only, anyone can do this)**, from the repository root (`cd ..` if you are still in
`contracts/`):

```powershell
node frontend/scripts/reevaluate.mjs $TxBlocked https://rpc.xlayer.tech
```

```powershell
node frontend/scripts/reevaluate.mjs $TxAllowed https://rpc.xlayer.tech
```

Each exits 0 and ends with "Re-evaluation matches the record." The tool re-runs TapeOut `eval` on each recorded
input, checks `keccak256(netlist)`, simulates the netlist offline, and recomputes `recordHash`.

**Afterwards:** 30 USDT0 stays in the escrow. A withdrawal is circuit-gated like any payment. It works from the next
UTC day (30 + 30 > 50 today), to a saved address (`$Me` is saved), with a `confirmPayment` first (30 > 20):

```powershell
$HW = cast call $Escrow "currentPaymentHash(address,uint256)(bytes32)" $Me 30000000 --rpc-url $Rpc
cast send $Escrow "confirmPayment(bytes32)" $HW --account $Account --rpc-url $Rpc
cast send $Escrow "withdraw(address,uint256)" $Me 30000000 --account $Account --rpc-url $Rpc
```

## 9. Record the deliverables

| Deliverable (handoff section 6) | Where it comes from |
|---|---|
| Processor address | `$Circuits` (step 1) |
| Circuit ids | `$CapId`, `$WlId`, `$ConfId`, `$FrzId` (step 3) |
| Verified contracts | `$Key`, `$Escrow` (steps 4–6) |
| Test transactions | `$TxBlocked`, `$TxAllowed` (step 8), plus their re-evaluation output |
| DeWEB link | step 10, if publishing works on X Layer |

Add them to the README's "Deployment configuration" section and change its status line. Until then, the README
correctly says nothing is deployed.

## 10. Host the dashboard on DeWEB

**Not done and not rehearsed.** TapeOut's DeWEB is described only in TapeOut Protocol's TapeKit repository
([TapeKit README](https://github.com/TapeOutProtocol/TapeKit), [SPEC.md v0.2](https://github.com/TapeOutProtocol/TapeKit/blob/main/SPEC.md),
[issue #6](https://github.com/TapeOutProtocol/TapeKit/issues/6), read on 2026-11-20). Here is what those sources say.

- A site is a set of files in a **container** that belongs to a TapeOut circuit NFT. Your circuit NFTs from step 3
  qualify. The container must first be "opened" through the container opener; the README says the HashPort console
  does this. The pages read here give no URL or call for the opener.
- Files are written to the **SiteRegistry** contract with `putFile(container, path, contentType, sha256, data)`, the
  first chunk at most 24,000 bytes. Then `appendChunk(container, path, expectIndex, data)` adds the rest, with
  `expectIndex` 1, 2, 3, … `setFallback(container, path)` is optional. The NFT holder or an operator set with
  `setOperator` may write. Limits: 24,000-byte chunks, at most 350 chunks (8.4 MB) per file.
- **No publishing CLI exists yet.** The README says to use the hosted console, or your own script against SPEC
  Appendix B.
- **X Layer:** SPEC v0.2 covers BNB Smart Chain only. The README lists SiteRegistry
  `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6` and DomainBinding `0x68809Fd2fb343aa57d0aeb7f33Defe477c9666f9` for
  X Layer and Base. A collaborator's reply on issue #6 (2026-09-28) says both are deployed on X Layer and that seven
  sites are live there. This project checked on 2026-11-20, read-only: both addresses have code on chain 196
  (EIP-1967 implementations `0xa85c4143…a45f` and `0x5ebf29b8…47df`), and DomainBinding `monthlyFee()` returns 0.
- **Reaching a site:** the gateway form `https://<id>-<cpu>.tapekit.org/` and `tape://<id>.<cpu>.tape/` are
  documented for BSC. The form for X Layer sites is **not documented**. Sites are listed at
  [web.tapeout.link](https://web.tapeout.link) ("TapeWeb · TapeOut On-chain Site Explorer").

**What this means for CircuitWill.** Uploading the dashboard is possible in principle, through the TapeOut / HashPort
console with one of your circuit NFTs. The steps and the final link could not be confirmed from official
documentation, and nothing was written. If you publish it:

- Upload `frontend/index.html`, `app.js`, `style.css`, `artifacts.js`, `lib/*.js` and
  `vendor/ethers-6.13.4.min.js` (+ its license), keeping their relative paths. That is about 672 KB in 14 files;
  `ethers` alone is 501 KB, which is 21 chunks. Do **not** upload `local-config.json`, which turns on developer mode.
- `lib/reeval.js` loads the offline simulator from `../../circuits/lib/tap02.mjs`. To keep that check, publish the
  files as `frontend/…` plus `circuits/lib/tap02.mjs` and open `/frontend/index.html`. Without it, the page reports
  that check as "n/a" and every other check still runs.
- Open your will with `?escrow=<$Escrow>&from=<$DeployBlock>`.
- **Cost:** not measured. It depends on how SiteRegistry stores data, which was not inspected. Storing 672 KB in
  contract storage would be about 420M gas (≈ 625 gas per byte), or ≈ 0.0084 OKB at 0.02 gwei. Treat that as a
  rough upper bound until you test one file.

**TapeOut explorer link:** **not confirmed.** No official page read for this runbook documents a URL for viewing a
circuit or CPU. tapeout.net is a single-page app without visible per-circuit routes. TapeKit documents site URLs
only. Link the circuit by its processor address and id instead (`$Circuits` #`$CapId`, the `0x…#<id>` form that SPEC
section 2.4 accepts as input), and give the read-only check:
`cast call $Circuits "circuitInfo(uint256)(uint32,uint32,uint32,uint32)" $CapId --rpc-url $Rpc`.

## Cost estimate

Gas measured on the [dry run of 2026-11-24](#dry-run-2026-11-24-custom-rules-and-the-delay) (anvil receipts, fork of
block 76,708,316, the contract with custom rules and the delay). Prices read live from `https://rpc.xlayer.tech` on
2026-11-20 (block ≈ 76,403,000); `eth_gasPrice` was still 20,000,001 wei on 2026-11-24:

- **Gas price:** `eth_gasPrice` = 20,000,001 wei. The base fee was 20,000,000 wei (0.02 gwei) in all of the last
  1,025 blocks (`eth_feeHistory`), and `eth_maxPriorityFeePerGas` = 1 wei. The busiest block used 24% of the
  210,000,000 gas limit.
- **L1 data fee:** none. The OP Stack `GasPriceOracle` (`0x4200…000F`, v1.6.0) has `baseFeeScalar` = 0 and
  `blobBaseFeeScalar` = 0, and `getL1FeeUpperBound` returns 0 for 200 to 60,000 bytes.
- **TapeOut fees:** `deployFee()` 10,000,000 (0.1 BEM), `protocolFee()` 1,000,000 (0.01 BEM, per mint call),
  `TAPEOUT_FEE()` 1,300,000,000,000,000 wei (0.0013 OKB).

| Step | Gas (anvil receipt) |
|---|---|
| BEM approve factory | 46,393 |
| createCPU | 686,601 |
| BEM approve transistors | 46,393 |
| mint 845 NAND | 171,411 |
| tapeout Daily Cap / Whitelist / Confirmation / Freeze | 1,511,368 + 878,655 + 659,569 + 204,815 = 3,254,407 |
| Deploy.s.sol (13 transactions) | 7,204,565 |
| fund (USDT0 transfer) | 56,112 |
| 2 × confirmPayment | 2 × 51,899 = 103,798 |
| proposePayment 60, blocked | 2,259,653 |
| proposePayment 30, allowed | 2,359,656 |
| **Total** | **16,188,989** |

Arithmetic:

```
setup      46,393 + 686,601 + 46,393 + 171,411           =    950,798 gas
tapeouts   1,511,368 + 878,655 + 659,569 + 204,815       =  3,254,407 gas
deploy                                                    =  7,204,565 gas
demo       56,112 + 103,798 + 2,259,653 + 2,359,656       =  4,779,219 gas
total                                                     = 16,188,989 gas

gas cost   16,188,989 gas × 20,000,001 wei                = 323,779,796,188,989 wei ≈ 0.000324 OKB
tapeouts   4 × 0.0013 OKB                                 = 0.0052 OKB
OKB total  0.000324 + 0.0052                              ≈ 0.0055 OKB
  at 10× today's gas price (0.2 gwei): 0.00324 + 0.0052   ≈ 0.0084 OKB

BEM total  0.1 (createCPU) + 0.01 (one mint call)         = 0.11 BEM  (11,000,000 base units)
USDT0      60 funded; 30 moves to your own payee, 30 stays in the escrow; none is a fee
```

The tapeout fee is 94% of the OKB cost. Keep **at least 0.01 OKB** for the forge simulations' 130% gas margin,
wallet-side `maxFeePerGas` headroom and a retry. Each later payment with four circuits costs about 2.26M to 2.36M gas,
≈ 0.000047 OKB at 0.02 gwei. Each custom rule adds about 0.24M gas per payment (84-NAND rule; see the
2026-11-24 dry run), and publishing one costs about 0.82M gas + 0.0013 OKB + 0.01 BEM. Fiat prices were not looked up. The optional verification and re-evaluation steps are
free; DeWEB hosting is not included (see step 10).

## Dry run (2026-11-24): custom rules and the delay

Same script, same commands as below, on the contract with custom rules and the loosening delay. It now also runs
step 6 (a custom rule) and step 7 (the delay). **Result: passed** (fork of block 76,708,316, no pin).

- **Drift:** none. Factory and beacon implementations, `deployFee`, `protocolFee` and `TAPEOUT_FEE` match the
  values in step 0.
- **Steps 1 to 5:** the same as on 2026-11-20 (blocked 60 by the Daily Cap alone, allowed 30, both re-evaluated,
  BEM mint fee per call). `Deploy.s.sol` now uses 7,101,282 gas (was 4,796,120), because the escrow is larger;
  forge estimated 9,356,846 without `--broadcast`.
- **Custom rule ("Up to 10 a day", `circuits/custom/build/daily-10`, 84 NAND):** BEM approve 46,393, mint 84 NAND
  83,099, tapeout 445,843 (`TapeOutCircuit.s.sol` with `CUSTOM_RULE=daily-10`, circuit id 5), `attachCustomRule`
  218,588. Total 793,923 gas, plus 0.0013 OKB tapeout fee and 0.01 BEM. Five circuits attached.
- **Next UTC day (anvil `evm_increaseTime`):** 10 USDT0 allowed (2,601,830 gas with five circuits); 1 USDT0 more
  blocked by the custom rule alone (2,571,414 gas), the four official circuits all allowed. Both decisions re-evaluated
  with `reevaluate.mjs`: "Re-evaluation matches the record".
- **Loosening delay:** `setDailyCap(100)` reverted with `LooseningIsDelayed`. `queueChange(DAILY_CAP, 0, 100)` used
  121,600 gas; `applyChange` before the delay reverted with `ChangeNotReady`; after 24 hours it applied (41,064 gas)
  and the cap read 100 USDT0.
- **Re-run after the security review (same day, fork of block 76,752,951): passed.** No drift. `Deploy.s.sol`
  7,204,565 gas (forge estimate 9,497,438); `attachCustomRule` now takes `appliesTo` (7 = everyone here) and used
  240,458 gas, so publishing the 84-NAND rule totals 815,793 gas. Custom rule: 10 allowed (2,602,524 gas), 1 more
  blocked by the custom rule alone (2,571,004), both re-evaluated. Delay: refused, queued (121,610), refused before
  the delay, applied after it (41,100). The cost table above uses this run.

## Dry run (2026-11-20)

`contracts/script/dryrun-anvil.ps1` replays steps 1 to 8 on a **local** anvil fork of the latest block. It
impersonates fresh addresses (no keys), writes OKB/BEM/USDT0 balances into the fork, and writes its records to
`broadcast-dryrun/`, `cache-dryrun/` and `out-dryrun/`. It refuses any RPC other than `127.0.0.1`/`localhost`. Both
scripts are first simulated **without `--broadcast`**, exactly as in steps 3 and 4. They are then executed on anvil
only, because the next step needs their ids and addresses.

```powershell
anvil --fork-url https://rpc.xlayer.tech --retries 20 --fork-retry-backoff 1500 --compute-units-per-second 50
```

```powershell
cd contracts; powershell -ExecutionPolicy Bypass -File script/dryrun-anvil.ps1
```

**Result: passed** (fork of block 76,403,789, no pin; an earlier run at 76,403,201 gave the same gas).

- The approvals were exact, not unlimited, and they were enough. `createCPU` pulled exactly 0.1 BEM. One
  `mint(0, 845)` pulled exactly 0.01 BEM, and so did a separate `mint(0, 1)`: the BEM mint fee is per call. Circuits
  were taped out as ids 1 to 4, and all 845 NAND were burned.
- Simulated without `--broadcast`, forge estimated 2,087,576 / 1,213,641 / 964,619 / 282,899 gas for the four
  tapeouts and 6,338,585 for `Deploy.s.sol`. These figures include forge's default 130% multiplier. Actual use was
  1.51M / 0.88M / 0.66M / 0.20M and 4.80M.
- `Deploy.s.sol` ran 13 transactions and attached four circuits; the controller was the deployer.
- **Blocked 60:** decision #1 was `BLOCKED (CIRCUIT_DENIED)`. Daily Cap DENIED (`0 + 60 > 50`); Whitelist,
  Confirmation (confirmed) and Freeze ALLOWED. No funds moved, and spent today stayed 0.
- **Allowed 30:** decision #2 was `ALLOWED`. The payee received 30, spent today became 30, and the confirmation was
  consumed.
- `reevaluate.mjs` reported "Re-evaluation matches the record" for both.

**Drift since the earlier rehearsal** (block 76,350,000, 2026-11-19/20). The factory implementation (`0x336e…ae2a`),
circuits beacon (`0xf70d…991C`) → implementation (`0x977f…29B2`), the new CPUs' transistor implementation
(`0x44Eb…5EFE`), `deployFee`, `protocolFee` and `TAPEOUT_FEE` are **unchanged**. The circuits' gate counts and
`circuitInfo` are unchanged. Payment gas matches within 0.5% (2,315,901 vs 2,310,560 allowed; the blocked case
differs in which circuits deny). `cpuCount()` was 435. One trap for anyone checking by hand:
`factory.transistorBeacon()` returns a legacy beacon (`0x1059…A51B` → `0x265b…a06b`, used by CPU #0). New CPUs get
the beacon behind the factory's unnamed getter `0xd3a27932` (`0x41cb…ce65` → `0x44Eb…5EFE`). The dry-run script reads
the new CPU's own EIP-1967 beacon slot for this reason.

**What the dry run cannot show:** your real account's balances, nonce and possible delegation code (see Pre-flight),
the password prompt of your keystore, explorer verification, DeWEB publishing, and any TapeOut upgrade after
2026-11-20.
