# Deployment rehearsal on a LOCAL anvil fork of X Layer. Every transaction goes to the anvil node only.
#
# It runs the real scripts (TapeOutCircuit.s.sol x4, Deploy.s.sol) the way a mainnet deployment would, then exercises
# the deployed escrow: an allowed payment, a blocked unconfirmed payment, a confirmed payment, and a frozen withdrawal.
#
# Start anvil first, in another terminal (pinning a block makes repeated runs cheaper on the public RPC):
#   anvil --fork-url https://rpc.xlayer.tech --fork-block-number 76350000 --retries 20 --fork-retry-backoff 1500 --compute-units-per-second 50
# Then, from contracts/:
#   powershell -ExecutionPolicy Bypass -File script/rehearse-anvil.ps1
#
# Test-only shortcuts that do not exist on mainnet: accounts are impersonated (no keys), OKB is set with
# anvil_setBalance, and BEM / USDT0 balances are written into token storage (slots observed 2026-11-19 and checked
# below). Script outputs go to broadcast-rehearsal/, cache-rehearsal/ and out-rehearsal/, so they are never confused
# with a real chain-196 deployment record in broadcast/.

param([string]$Rpc = "http://127.0.0.1:8545")

$ErrorActionPreference = "Stop"

if ($Rpc -notmatch '^http://(127\.0\.0\.1|localhost)(:\d+)?/?$') { throw "Refusing to run: the rehearsal only targets a local anvil node." }

$Factory = "0x1f09DAeFA827f02CBb40967cc91b259763760761"
$Bem = "0x60e62Efa9405d6873C5deaBD4E6CC91c25363952"
$Usdt0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"
$BemBalanceSlot = 5
$Usdt0BalanceSlot = 51
$MaxUint = "115792089237316195423570616584007913129639935"

if (-not (Get-Command forge -ErrorAction SilentlyContinue)) {
    $foundryBin = Join-Path $env:USERPROFILE ".foundry\bin"
    if (-not (Test-Path (Join-Path $foundryBin "forge.exe"))) { throw "forge/cast not found; install Foundry" }
    $env:PATH = "$env:PATH;$foundryBin"
}

function Invoke-Tool {
    param([string]$Exe, [string[]]$ToolArgs)
    # Native tools print warnings on stderr; success is judged by the exit code only.
    $ErrorActionPreference = "Continue"
    $out = & $Exe @ToolArgs
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($ToolArgs -join ' ') failed (exit $LASTEXITCODE)" }
    return $out
}
# Read-only cast commands are retried: anvil fetches fork state lazily, and the public RPC sometimes resets
# connections. Transactions (cast send, forge script) are never retried.
function Invoke-Cast {
    $castArgs = [string[]]$args
    $readOnly = @("call", "code", "chain-id", "nonce", "rpc", "keccak", "index", "to-uint256", "to-check-sum-address") -contains $castArgs[0]
    for ($attempt = 1; ; $attempt++) {
        try { return Invoke-Tool "cast" $castArgs }
        catch {
            if (-not $readOnly -or $attempt -ge 5) { throw }
            Write-Host "  ..  retrying cast $($castArgs[0]) ($attempt/4) after an RPC error"
            Start-Sleep -Seconds 3
        }
    }
}
function Get-Uint([string]$text) { return [decimal]($text.Trim().Split(" ")[0]) }
function New-LabelAddress([string]$label) {
    $h = Invoke-Cast keccak $label
    return (Invoke-Cast to-check-sum-address $h.Substring(0, 42)).Trim()
}
function Set-TokenBalance([string]$token, [int]$slot, [string]$holder, [decimal]$amount) {
    $key = Invoke-Cast index address $holder $slot
    $value = Invoke-Cast to-uint256 $amount
    Invoke-Cast rpc anvil_setStorageAt $token $key $value --rpc-url $Rpc | Out-Null
    $bal = Get-Uint (Invoke-Cast call $token "balanceOf(address)(uint256)" $holder --rpc-url $Rpc)
    if ($bal -ne $amount) { throw "Balance slot $slot of $token is wrong (got $bal); probe it again." }
}
function Enable-Account([string]$account) {
    Invoke-Cast rpc anvil_impersonateAccount $account --rpc-url $Rpc | Out-Null
    Invoke-Cast rpc anvil_setBalance $account "0x8AC7230489E80000" --rpc-url $Rpc | Out-Null  # 10 OKB
}
function Send-Tx([string]$from, [string]$to, [string]$sig) {
    $rest = @($args)
    # Simulate first (read-only, retried): this also loads the fork state the transaction touches into anvil's cache,
    # so the transaction itself rarely needs the upstream RPC. The transaction is sent once.
    $callArgs = @("call", $to, $sig) + $rest + @("--from", $from, "--rpc-url", $Rpc)
    Invoke-Cast @callArgs | Out-Null
    $sendArgs = @("send", $to, $sig) + $rest + @("--from", $from, "--unlocked", "--rpc-url", $Rpc)
    # No explicit gas limit, on purpose: cast uses eth_estimateGas, as a wallet would. The escrow reverts with
    # InsufficientGas when an eval is starved by the caller, so the estimate is enough to evaluate every circuit.
    for ($attempt = 1; ; $attempt++) {
        $nonceBefore = (Invoke-Cast nonce $from --rpc-url $Rpc).Trim()
        try { Invoke-Tool "cast" $sendArgs | Out-Null; return }
        catch {
            # Retry only if provably nothing happened: anvil automines, so a submitted transaction either moved the
            # sender's nonce or is still pending. In either case stop instead of risking a second transaction.
            $pending = (Invoke-Cast rpc txpool_status --rpc-url $Rpc | ConvertFrom-Json).pending
            $nonceAfter = (Invoke-Cast nonce $from --rpc-url $Rpc).Trim()
            if ($attempt -ge 5 -or $pending -ne "0x0" -or $nonceAfter -ne $nonceBefore) { throw }
            Write-Host "  ..  transaction was not submitted (RPC error); retrying ($attempt/4)"
            Start-Sleep -Seconds 5
        }
    }
}
function Get-Usdt0([string]$holder) { return Get-Uint (Invoke-Cast call $Usdt0 "balanceOf(address)(uint256)" $holder --rpc-url $Rpc) }
function Assert-Equal($actual, $expected, [string]$what) {
    if ($actual -ne $expected) { throw "FAILED: $what (expected $expected, got $actual)" }
    Write-Host "  ok  $what"
}

# --- guard: this must be anvil forking X Layer
Invoke-Cast rpc anvil_nodeInfo --rpc-url $Rpc | Out-Null
Assert-Equal (Invoke-Cast chain-id --rpc-url $Rpc).Trim() "196" "chain id is 196 (X Layer fork)"

Push-Location (Join-Path $PSScriptRoot "..")
$env:FOUNDRY_BROADCAST = "broadcast-rehearsal"
$env:FOUNDRY_CACHE_PATH = "cache-rehearsal"
$env:FOUNDRY_OUT = "out-rehearsal"
# Each run starts from scratch: drop records of earlier rehearsals (only the rehearsal folders, never broadcast/).
Remove-Item -Recurse -Force "broadcast-rehearsal" -ErrorAction SilentlyContinue
Get-ChildItem "cache-rehearsal" -Directory -Filter "*.s.sol" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
try {
    # Fresh addresses: anvil's default accounts carry EIP-7702 delegations on X Layer mainnet and reject ERC-1155 mints.
    $designer = New-LabelAddress "circuitwill.rehearsal.designer"
    $payee = New-LabelAddress "circuitwill.rehearsal.payee"
    $agent = New-LabelAddress "circuitwill.rehearsal.agent"
    foreach ($a in @($designer, $payee, $agent)) {
        if ((Invoke-Cast code $a --rpc-url $Rpc).Trim() -ne "0x") { throw "$a has code on this fork" }
    }
    Enable-Account $designer
    Enable-Account $agent
    Write-Host "designer/controller $designer, payee $payee, agent $agent"

    # --- 1. A CPU with enough NAND transistors (createCPU pulls 0.1 BEM; mint pulls protocolFee in BEM)
    Set-TokenBalance $Bem $BemBalanceSlot $designer 100000000000000
    Send-Tx $designer $Bem "approve(address,uint256)" $Factory $MaxUint
    $cpu = Invoke-Cast call $Factory "createCPU(string,string,string,uint256,uint256)(address,address)" "CircuitWill Rehearsal" CWR rehearsal 10000 0 --from $designer --rpc-url $Rpc
    Send-Tx $designer $Factory "createCPU(string,string,string,uint256,uint256)" "CircuitWill Rehearsal" CWR rehearsal 10000 0
    $transistors = $cpu[0].Trim()
    $circuits = $cpu[1].Trim()
    Assert-Equal (Invoke-Cast call $Factory "isCPU(address)(bool)" $circuits --rpc-url $Rpc).Trim() "true" "factory.isCPU(new CPU)"
    Send-Tx $designer $Bem "approve(address,uint256)" $transistors $MaxUint
    Send-Tx $designer $Bem "approve(address,uint256)" $circuits $MaxUint
    $slugs = @("daily-cap", "payee-whitelist", "confirmation", "freeze")
    $gates = 0
    foreach ($s in $slugs) {
        $hex = (Get-Content "../circuits/$s/build/$s.netlist.hex" -Raw).Trim()
        $gates += ($hex.Length - 2) / 14
    }
    Send-Tx $designer $transistors "mint(uint256,uint256)" 0 $gates
    Assert-Equal (Get-Uint (Invoke-Cast call $transistors "balanceOf(address,uint256)(uint256)" $designer 0 --rpc-url $Rpc)) ([decimal]$gates) "minted $gates NAND"

    # --- 2. Tape out each circuit with the real script
    $ids = @{}
    $env:TAPEOUT_CIRCUITS = $circuits
    foreach ($s in $slugs) {
        $env:CIRCUIT = $s
        $out = Invoke-Tool "forge" @("script", "script/TapeOutCircuit.s.sol", "--rpc-url", $Rpc, "--sender", $designer, "--unlocked", "--broadcast", "--slow")
        $m = $out | Select-String -Pattern "circuit id: (\d+)"
        if (-not $m) { throw "no circuit id for $s" }
        $ids[$s] = $m.Matches[0].Groups[1].Value
        Write-Host "  ok  taped out $s as circuit $($ids[$s])"
    }
    Assert-Equal (Get-Uint (Invoke-Cast call $transistors "balanceOf(address,uint256)(uint256)" $designer 0 --rpc-url $Rpc)) ([decimal]0) "all NAND burned"

    # --- 3. Deploy and configure with the real script
    $env:DAILY_CAP_CIRCUIT_ID = $ids["daily-cap"]
    $env:DAILY_CAP = "50000000"
    $env:WHITELIST_CIRCUIT_ID = $ids["payee-whitelist"]
    $env:TRIAL_LIMIT = "5000000"
    $env:COOLING_OFF_HOURS = "24"
    $env:SAVED_PAYEES = "$payee,$designer"
    $env:CONFIRMATION_CIRCUIT_ID = $ids["confirmation"]
    $env:CONFIRMATION_THRESHOLD = "20000000"
    $env:FREEZE_CIRCUIT_ID = $ids["freeze"]
    $env:AGENT = $agent
    $out = Invoke-Tool "forge" @("script", "script/Deploy.s.sol", "--rpc-url", $Rpc, "--sender", $designer, "--unlocked", "--broadcast", "--slow")
    $m = $out | Select-String -Pattern "CircuitWillEscrow: (0x[0-9a-fA-F]{40})"
    if (-not $m) { throw "no escrow address in Deploy.s.sol output" }
    $escrow = $m.Matches[0].Groups[1].Value
    Write-Host "  ok  escrow deployed at $escrow (anvil only)"

    Assert-Equal (Invoke-Cast call $escrow "controller()(address)" --rpc-url $Rpc).Trim() $designer "controller is the deployer"
    Assert-Equal (Get-Uint (Invoke-Cast call $escrow "circuitCount()(uint256)" --rpc-url $Rpc)) ([decimal]4) "four circuits attached"
    Assert-Equal (Get-Uint (Invoke-Cast call $escrow "dailyCap()(uint256)" --rpc-url $Rpc)) ([decimal]50000000) "daily cap"
    Assert-Equal (Get-Uint (Invoke-Cast call $escrow "trialLimit()(uint256)" --rpc-url $Rpc)) ([decimal]5000000) "trial limit"
    Assert-Equal (Get-Uint (Invoke-Cast call $escrow "coolingOffHours()(uint256)" --rpc-url $Rpc)) ([decimal]24) "cooling-off hours"
    Assert-Equal (Get-Uint (Invoke-Cast call $escrow "confirmationThreshold()(uint256)" --rpc-url $Rpc)) ([decimal]20000000) "confirmation threshold"
    Assert-Equal (Invoke-Cast call $escrow "agent()(address)" --rpc-url $Rpc).Trim() $agent "agent set"
    $p = Invoke-Cast call $escrow "payees(address)(uint64,bool)" $payee --rpc-url $Rpc
    Assert-Equal $p[1].Trim() "true" "payee saved"

    # --- 4. Exercise it with real USDT0 and the real circuits
    Set-TokenBalance $Usdt0 $Usdt0BalanceSlot $escrow 100000000
    $payee0 = Get-Usdt0 $payee
    $designer0 = Get-Usdt0 $designer
    Send-Tx $agent $escrow "proposePayment(address,uint256,string)" $payee 10000000 "rehearsal: saved payee, 10"
    Assert-Equal ((Get-Usdt0 $payee) - $payee0) ([decimal]10000000) "agent pays 10 USDT0 to a saved payee"

    Send-Tx $agent $escrow "proposePayment(address,uint256,string)" $payee 30000000 "rehearsal: 30 unconfirmed"
    Assert-Equal ((Get-Usdt0 $payee) - $payee0) ([decimal]10000000) "30 USDT0 above threshold is blocked without confirmation"

    $hash = (Invoke-Cast call $escrow "currentPaymentHash(address,uint256)(bytes32)" $payee 30000000 --rpc-url $Rpc).Trim()
    Send-Tx $designer $escrow "confirmPayment(bytes32)" $hash
    Send-Tx $agent $escrow "proposePayment(address,uint256,string)" $payee 30000000 "rehearsal: 30 confirmed"
    Assert-Equal ((Get-Usdt0 $payee) - $payee0) ([decimal]40000000) "confirmed 30 USDT0 goes through"
    Assert-Equal (Get-Uint (Invoke-Cast call $escrow "paymentNonce(address)(uint256)" $payee --rpc-url $Rpc)) ([decimal]1) "confirmation consumed"

    Send-Tx $designer $escrow "setFrozen(bool)" true
    Send-Tx $designer $escrow "withdraw(address,uint256)" $designer 1000000
    Assert-Equal ((Get-Usdt0 $designer) - $designer0) ([decimal]0) "freeze blocks the controller's withdrawal"
    Assert-Equal (Get-Usdt0 $escrow) ([decimal]60000000) "escrow keeps the rest"
    Assert-Equal (Get-Uint (Invoke-Cast call $escrow "decisionCount()(uint256)" --rpc-url $Rpc)) ([decimal]4) "four decisions recorded"

    Write-Host "Rehearsal passed on the local anvil fork. Nothing was sent to X Layer."
}
finally {
    Pop-Location
}
