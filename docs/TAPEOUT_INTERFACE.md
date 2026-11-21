# TapeOut / X Layer interface: what is verified and what is not

TapeOut has no official ABI or specification document that this project could find. Everything below comes from
three sources, and each fact is labelled with its source:

- **[live]**: read-only `cast call` / `cast selectors` against X Layer mainnet (`https://rpc.xlayer.tech`, chain
  196) on 2026-11-19. Nothing was signed or broadcast.
- **[fork]**: `test/fork/TapeOutFork.t.sol`, run against a local fork of X Layer mainnet near block 76,336,000 on
  2026-11-19 (Phase 1), and again near block 76,348,000 the same day with all four circuits (Phase 2). Fork
  transactions are simulated locally and never reach the network.
- **[community]**: third-party integrations (NetLayerLabs/Cerebr `TAPEOUT.md`, Cheeeeez/tapesynth, 0xdopewilly/fusebox),
  read only as references. Where they disagree with [live] or [fork], the chain wins.

## Addresses (X Layer, chain 196)

| What | Address | Source |
|---|---|---|
| TapeOut factory (UUPS proxy) | `0x1f09DAeFA827f02CBb40967cc91b259763760761` | [live] |
| Factory implementation (2026-11-19) | `0x336e9F0F4c3fEe7C8c803377e4DEA00293f4ae2a` | [live] EIP-1967 slot. **Changed** since the community docs (they list `0x7495…`) |
| Circuit beacon → implementation | `0xf70d1ed4…991C` → `0x977f2178…29B2` | [live] |
| CPU #0 circuits (TapeOut's own) | `0x839bdD6fa7A66416A609A735e11DE5411B98574e` | [live] |
| USDT0 | `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` (symbol `USD₮0`, 6 decimals) | [live] |
| BEM (factory fee token) | `0x60e62Efa9405d6873C5deaBD4E6CC91c25363952` (8 decimals) | [live] / [fork] |

## What CircuitWill depends on (verified)

| Interface | Evidence |
|---|---|
| `eval(uint256 id, bytes inputs) view returns (bytes)` | [live] selector `0x934d06ea` in the circuit implementation; [live] calls to CPU 0 circuit #1 |
| Bit packing: input/output bit *i* = `(byte[i>>3] >> (i&7)) & 1` | [live] CPU 0 circuit #1 (XOR, 4 NAND) returned `0x00,0x01,0x01,0x00` for `0x00..0x03` |
| Netlist NAND element `0x00 a:u24 b:u24`; signals 0=const0, 1=const1, 2..1+nIn=inputs; outputs = last nOut signals | [live] `netlist(1)` of CPU 0 decodes this way, and its eval results match; [fork] our 447-gate netlist taped out and evaluated correctly |
| `circuitInfo(id) returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)` | [fork] returned `(96, 1, 0, 447)` Daily Cap, `(97, 1, 0, 237)` Payee Whitelist, `(65, 1, 0, 160)` Confirmation, `(1, 1, 0, 1)` Freeze |
| `netlist(id) returns (bytes)` returns exactly the submitted bytes | [fork] all four circuits |
| `eval` of each CircuitWill circuit returns exactly 1 byte | [fork] all four circuits |
| Input counts that are not a multiple of 8 (97, 65, 1) are accepted by `tapeout` and evaluate with the LSB-first packing (13, 9 and 1 input bytes) | [fork] tapeout succeeded; edge vectors match the reference rules. Behaviour with non-zero padding bits was not tested (the escrow always sends zeros) |
| A 1-element netlist (Freeze: `NAND(in0, in0)`) is a valid circuit | [fork] taped out and evaluated `0x00 → 1`, `0x01 → 0` |
| Tapeout burns one NAND transistor (ERC-1155 id 0) per netlist element | [fork] 845 minted, 845 elements taped out in four circuits, balance 0 afterwards |
| Payee Whitelist, Confirmation and Freeze correctness on real TapeOut | [fork] 12, 16 and 2 edge vectors (0, max, exact thresholds, MSB cases) match the reference rules |
| Escrow end-to-end with all four circuits | [fork] new payee blocked before cooling-off and allowed after; unconfirmed payment above threshold blocked; confirmed payment allowed once; freeze blocks `withdraw` |
| Factory `isCPU(address circuits)` | [fork] the escrow's attach check passed for the fork-created CPU |
| Daily Cap correctness on real TapeOut | [fork] 12 edge vectors, including uint32 max and 33-bit carry cases, match `spent + amount <= cap` |
| Escrow end-to-end with real TapeOut + real USDT0 | [fork] cap 50: 60 USDT0 blocked, 30 USDT0 paid |
| Gas | [fork] eval incl. call overhead ≈ 1.07M (447 NAND), 0.59M (237), 0.41M (160), 0.03M (1); allowed `proposePayment` ≈ 1.23M with Daily Cap only, ≈ 2.32M with all four circuits (confirmation consumed); blocked `withdraw` with four ≈ 2.23M; `eth_estimateGas`-style search for a 10 USDT0 payment with four ≈ 2.43M |
| Starved eval behind the proxy | [fork] when an eval runs out of gas, the circuits beacon proxy reverts with the 1/64 it kept back (EIP-150), so the caller sees less than its full gas limit used. `TapeOutEval` treats a failure after 15/16 of the limit as out of gas; with an exact `used >= limit` check, the estimated limit starved Freeze |
| Block gas limit | [live] 210,000,000 on X Layer (2026-11-20) |
| Circuit NFT burnability | [live] the circuit implementation exposes no `burn(uint256)` selector today. It is beacon-upgradeable, so this can change |

## Observed changes vs. community documentation

- `createCPU(string,string,string,uint256,uint256)` is now **non-payable**. It pulls `deployFee()` = `10000000`
  (0.1 BEM at 8 decimals) through BEM `transferFrom` to the protocol wallet [fork]. The community docs describe an OKB
  `msg.value` fee.
- CPUs created now use a transistor implementation (`0x44Ebf3345bcf9aB329e7a28E53fd8EcfAd1a5EFE`) whose
  `mint(uint256,uint256)` is **non-payable** [live]. On a CPU created with mint price 0, one `mint(0, 845)` pulled
  exactly `protocolFee()` = `1000000` (0.01 BEM) [anvil fork, block 76,350,000]. Whether that fee is per call or
  scales with the amount was not tested.
- The anvil default dev accounts (for example `0xf39F…2266`) have **EIP-7702 delegation code** on X Layer mainnet, so
  ERC-1155 `mint` to them reverts with `ERC1155InvalidReceiver` [anvil fork]. Use fresh addresses on a fork.
- BEM keeps balances in storage slot 5 and USDT0 in slot 51 (`mapping(address => uint256)`), as used by the anvil
  rehearsal to fund test accounts [anvil fork].
- `tapeout(bytes,uint32,uint32)` still requires `msg.value == TAPEOUT_FEE()` = 0.0013 OKB [fork].

## Not verified / missing

1. **No official spec or audit.** TapeOut contracts are upgradeable by their owner (`isSealed() == false` [live]).
   The eval semantics, fees and NFT behaviour can change after deployment. CircuitWill mitigates by recording
   `netlistHash` at attach time and every input/output in events, but cannot prevent an upgrade.
2. **`step` (sequential circuits)** is not used and not verified by this project. The Freeze circuit is
   combinational (1 NAND), because the escrow stores the flag.
3. **Whether the X Layer TapeOut UI lists new CPUs** was not checked. The BEM mint fee is now measured
   [anvil fork, block 76,403,789, 2026-11-20]: `mint` pulls `protocolFee()` = 0.01 BEM **per call**. Both
   `mint(0, 845)` and `mint(0, 1)` pulled exactly 1,000,000 base units.
4. **No live (mainnet) tapeout or deployment** has been done. Circuit ids and the processor address for production
   do not exist yet. All four circuits were taped out only on a local fork. The mainnet steps are in
   [`MAINNET_RUNBOOK.md`](MAINNET_RUNBOOK.md).
5. **TapeOut explorer link format** (for the UI's "Link to TapeOut circuit explorer") is still unknown. No official
   page read on 2026-11-20 documents one: tapeout.net is a single-page app, and TapeOut Protocol's TapeKit documents
   only DeWEB site URLs. See the runbook, step 10.
6. **DeWEB on X Layer.** TapeKit (README, SPEC v0.2, issue #6) describes the SiteRegistry `putFile` /
   `appendChunk` writes for BSC. It lists SiteRegistry `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6` and DomainBinding
   `0x68809Fd2fb343aa57d0aeb7f33Defe477c9666f9` for X Layer [community/TapeKit]. Both have code on chain 196 [live,
   2026-11-20]. The X Layer site URL form and a publishing CLI are not documented. Nothing was written.

**Observed 2026-11-20 [live]:** `factory.transistorBeacon()` returns a legacy beacon (`0x1059Ad62…A51B` →
`0x265bf10f…a06b`), which CPU #0's transistors use. CPUs created now get the beacon `0x41cb2bfd…ce65` →
`0x44Ebf334…5EFE` (the factory getter with selector `0xd3a27932`). The X Layer OP Stack `GasPriceOracle` has
`baseFeeScalar` = `blobBaseFeeScalar` = 0, so there is no L1 data fee. The base fee was a constant 0.02 gwei over
1,025 blocks.

## How the escrow isolates this

All TapeOut assumptions live in two places:

- `contracts/src/interfaces/ITapeOut.sol`: the three read functions (`eval`, `circuitInfo`, `netlist`) and `isCPU`.
- `contracts/src/libraries/TapeOutEval.sol`: the only code that calls `eval`. It uses a raw `staticcall` with a gas
  limit, copies at most 96 bytes of return data, and requires exactly `abi.encode(bytes)` with a 1-byte output.
  Anything else (revert, out of gas, no code, wrong length, wrong offset, garbage) becomes a `REVERTED` or
  `MALFORMED_OUTPUT` status, which the escrow records as a blocked decision. It also reports whether a failed call
  used (nearly) all of its gas, so the escrow can revert with `InsufficientGas` when the caller, not the circuit, was
  short of gas.

If TapeOut changes its ABI, only these two files need to change.
