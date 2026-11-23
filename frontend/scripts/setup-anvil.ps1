# Prepares a LOCAL anvil fork of X Layer for the dashboard. Every transaction goes to the anvil node only.
#
# It creates a TapeOut CPU, mints NAND transistors, tapes out the four CircuitWill circuits with the real
# script/TapeOutCircuit.s.sol, gives two fresh demo wallets (owner, agent) OKB for gas and gives the owner USDT0.
# It does NOT create a CircuitWill: you do that in the dashboard. The result (addresses and circuit ids, no keys)
# is written to frontend/local-config.json, which the dashboard reads.
#
# Start anvil first, in another terminal:
#   anvil --fork-url https://rpc.xlayer.tech --fork-block-number 76350000 --retries 20 --fork-retry-backoff 1500 --compute-units-per-second 50
# Then, from frontend/:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-anvil.ps1
#
# Test-only shortcuts that do not exist on mainnet: accounts are impersonated (no keys), OKB is set with
# anvil_setBalance, and BEM / USDT0 balances are written into token storage (same slots as
# contracts/script/rehearse-anvil.ps1). Forge outputs go to the rehearsal folders, never to contracts/broadcast/.

param([string]$Rpc = "http://127.0.0.1:8545")

$ErrorActionPreference = "Stop"

if ($Rpc -notmatch '^http://(127\.0\.0\.1|localhost)(:\d+)?/?$') { throw "Refusing to run: this script only targets a local anvil node." }

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
    $ErrorActionPreference = "Continue"
    $out = & $Exe @ToolArgs
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($ToolArgs -join ' ') failed (exit $LASTEXITCODE)" }
    return $out
}
# Read-only cast commands are retried (anvil fetches fork state lazily from a public RPC). Transactions are not.
function Invoke-Cast {
    $castArgs = [string[]]$args
    $readOnly = @("call", "code", "chain-id", "nonce", "rpc", "keccak", "index", "to-uint256", "to-check-sum-address", "block-number") -contains $castArgs[0]
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
    $callArgs = @("call", $to, $sig) + $rest + @("--from", $from, "--rpc-url", $Rpc)
    Invoke-Cast @callArgs | Out-Null
    $sendArgs = @("send", $to, $sig) + $rest + @("--from", $from, "--unlocked", "--rpc-url", $Rpc)
    for ($attempt = 1; ; $attempt++) {
        $nonceBefore = (Invoke-Cast nonce $from --rpc-url $Rpc).Trim()
        try { Invoke-Tool "cast" $sendArgs | Out-Null; return }
        catch {
            $pending = (Invoke-Cast rpc txpool_status --rpc-url $Rpc | ConvertFrom-Json).pending
            $nonceAfter = (Invoke-Cast nonce $from --rpc-url $Rpc).Trim()
            if ($attempt -ge 5 -or $pending -ne "0x0" -or $nonceAfter -ne $nonceBefore) { throw }
            Write-Host "  ..  transaction was not submitted (RPC error); retrying ($attempt/4)"
            Start-Sleep -Seconds 5
        }
    }
}

# --- guard: this must be anvil forking X Layer
Invoke-Cast rpc anvil_nodeInfo --rpc-url $Rpc | Out-Null
if ((Invoke-Cast chain-id --rpc-url $Rpc).Trim() -ne "196") { throw "chain id is not 196: start anvil with --fork-url https://rpc.xlayer.tech" }

$frontend = Join-Path $PSScriptRoot ".."
Push-Location (Join-Path $frontend "..\contracts")
$env:FOUNDRY_BROADCAST = "broadcast-rehearsal"
$env:FOUNDRY_CACHE_PATH = "cache-rehearsal"
$env:FOUNDRY_OUT = "out-rehearsal"
try {
    # Fresh addresses: anvil's default accounts carry EIP-7702 delegations on X Layer mainnet.
    $designer = New-LabelAddress "circuitwill.dashboard.designer"
    $owner = New-LabelAddress "circuitwill.dashboard.owner"
    $agent = New-LabelAddress "circuitwill.dashboard.agent"
    $payee = New-LabelAddress "circuitwill.dashboard.payee"
    $stranger = New-LabelAddress "circuitwill.dashboard.new-payee"
    foreach ($a in @($designer, $owner, $agent, $payee, $stranger)) {
        if ((Invoke-Cast code $a --rpc-url $Rpc).Trim() -ne "0x") { throw "$a has code on this fork" }
    }
    Enable-Account $designer
    Enable-Account $owner
    Enable-Account $agent
    Write-Host "designer $designer, owner $owner, agent $agent, payee $payee, new payee $stranger"

    # --- 1. A CPU with enough NAND transistors
    Set-TokenBalance $Bem $BemBalanceSlot $designer 100000000000000
    Set-TokenBalance $Bem $BemBalanceSlot $owner 100000000000 # 1,000 BEM so the owner can publish custom rules from the dashboard
    Send-Tx $designer $Bem "approve(address,uint256)" $Factory $MaxUint
    $cpu = Invoke-Cast call $Factory "createCPU(string,string,string,uint256,uint256)(address,address)" "CircuitWill Dashboard" CWD dashboard 1000000 0 --from $designer --rpc-url $Rpc
    Send-Tx $designer $Factory "createCPU(string,string,string,uint256,uint256)" "CircuitWill Dashboard" CWD dashboard 1000000 0
    $transistors = $cpu[0].Trim()
    $circuits = $cpu[1].Trim()
    if ((Invoke-Cast call $Factory "isCPU(address)(bool)" $circuits --rpc-url $Rpc).Trim() -ne "true") { throw "new CPU is not registered" }
    Send-Tx $designer $Bem "approve(address,uint256)" $transistors $MaxUint
    Send-Tx $designer $Bem "approve(address,uint256)" $circuits $MaxUint
    $slugs = @("daily-cap", "payee-whitelist", "confirmation", "freeze")
    $gates = 0
    foreach ($s in $slugs) {
        $hex = (Get-Content "../circuits/$s/build/$s.netlist.hex" -Raw).Trim()
        $gates += ($hex.Length - 2) / 14
    }
    Send-Tx $designer $transistors "mint(uint256,uint256)" 0 $gates
    Write-Host "  ok  CPU $circuits with $gates NAND"

    # --- 2. Tape out each circuit with the real script
    $ids = [ordered]@{}
    $env:TAPEOUT_CIRCUITS = $circuits
    foreach ($s in $slugs) {
        $env:CIRCUIT = $s
        $out = Invoke-Tool "forge" @("script", "script/TapeOutCircuit.s.sol", "--rpc-url", $Rpc, "--sender", $designer, "--unlocked", "--broadcast", "--slow")
        $m = $out | Select-String -Pattern "circuit id: (\d+)"
        if (-not $m) { throw "no circuit id for $s" }
        $ids[$s] = [int]$m.Matches[0].Groups[1].Value
        Write-Host "  ok  taped out $s as circuit $($ids[$s])"
    }

    # --- 3. Demo funds: 500 USDT0 for the owner (who funds the escrow from the dashboard)
    Set-TokenBalance $Usdt0 $Usdt0BalanceSlot $owner 500000000
    Write-Host "  ok  owner holds 500 USDT0"

    $config = [ordered]@{
        note        = "Generated by frontend/scripts/setup-anvil.ps1 for a LOCAL anvil fork only. Addresses and ids, no keys. Nothing here exists on X Layer."
        rpc         = $Rpc
        chainId     = 196
        forkBlock   = [int](Invoke-Cast block-number --rpc-url $Rpc).Trim()
        token       = $Usdt0
        factory     = $Factory
        bem         = $Bem
        processor   = $circuits
        circuitIds  = [ordered]@{ dailyCap = $ids["daily-cap"]; whitelist = $ids["payee-whitelist"]; confirmation = $ids["confirmation"]; freeze = $ids["freeze"] }
        accounts    = [ordered]@{ owner = $owner; agent = $agent; payee = $payee; newPayee = $stranger; designer = $designer }
    }
    $path = Join-Path $frontend "local-config.json"
    # UTF-8 without BOM (Windows PowerShell's -Encoding utf8 adds one).
    [System.IO.File]::WriteAllText($path, ($config | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))
    Write-Host "Wrote $path. Local anvil only; nothing was sent to X Layer."
}
finally {
    Pop-Location
}
