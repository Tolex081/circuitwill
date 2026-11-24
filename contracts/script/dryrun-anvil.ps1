# Mainnet dry run on a LOCAL anvil fork of X Layer (latest block). Every transaction goes to the anvil node only;
# nothing is signed with a key and nothing reaches X Layer.
#
# It follows docs/MAINNET_RUNBOOK.md step by step, with the same calls in the same order:
#   0. drift check: TapeOut implementations and fees against the values the runbook was written for
#   1. BEM approvals for the exact fees (not unlimited), createCPU, mint 845 NAND (measures the BEM actually pulled)
#   2. TapeOutCircuit.s.sol x4: simulated WITHOUT --broadcast (as on mainnet), then executed on anvil for the ids
#   3. Deploy.s.sol: simulated WITHOUT --broadcast, then executed on anvil
#   4. demo: fund 60 USDT0 with a plain transfer, confirm + propose 60 (blocked by Daily Cap 50),
#      confirm + propose 30 (allowed), then re-evaluate both with frontend/scripts/reevaluate.mjs
#   5. an extra mint of 1 NAND, to see whether the BEM mint fee is per call or per transistor
#   6. a custom rule (circuits/custom/build/daily-10): mint, tape out, attachCustomRule; on the next UTC day 10 is
#      allowed and 1 more is blocked by the custom rule alone; both re-evaluated
#   7. the loosening delay: raising the daily cap is refused, then queued, applied after ruleDelay
# It prints the gas of every step and writes a JSON report (broadcast-dryrun/dryrun-report.json).
#
# Start anvil first, in another terminal, WITHOUT a block pin (the point is to test today's mainnet state):
#   anvil --fork-url https://rpc.xlayer.tech --retries 20 --fork-retry-backoff 1500 --compute-units-per-second 50
# Then, from contracts/:
#   powershell -ExecutionPolicy Bypass -File script/dryrun-anvil.ps1
#
# Test-only shortcuts that do not exist on mainnet: accounts are impersonated (no keys), OKB is set with
# anvil_setBalance, and BEM / USDT0 balances are written into token storage. Outputs go to broadcast-dryrun/,
# cache-dryrun/ and out-dryrun/ so they are never confused with a real deployment record in broadcast/.

param([string]$Rpc = "http://127.0.0.1:8545")

$ErrorActionPreference = "Stop"

if ($Rpc -notmatch '^http://(127\.0\.0\.1|localhost)(:\d+)?/?$') { throw "Refusing to run: the dry run only targets a local anvil node." }

# Values the runbook was written for (read live from X Layer on 2026-11-20). A difference is reported as drift.
$Expected = [ordered]@{
    factoryImpl          = "0x336e9F0F4c3fEe7C8c803377e4DEA00293f4ae2a"
    circuitsBeaconImpl   = "0x977f217887E085D298Cb3819cDAD5A0ee35F29B2"
    newCpuCircuitsBeacon = "0xf70d1ed4F62Cf3780157b0B421b7e2f45Bd0991C"
    transistorBeaconImpl = "0x44Ebf3345bcf9aB329e7a28E53fd8EcfAd1a5EFE"
    deployFee            = "10000000"
    protocolFee          = "1000000"
    tapeoutFee           = "1300000000000000"
}
$Factory = "0x1f09DAeFA827f02CBb40967cc91b259763760761"
$Bem = "0x60e62Efa9405d6873C5deaBD4E6CC91c25363952"
$Usdt0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"
$CircuitsBeacon = "0xf70d1ed4F62Cf3780157b0B421b7e2f45Bd0991C"
$BemBalanceSlot = 5
$Usdt0BalanceSlot = 51
$ImplSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
$BeaconSlot = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"

if (-not (Get-Command forge -ErrorAction SilentlyContinue)) {
    $foundryBin = Join-Path $env:USERPROFILE ".foundry\bin"
    if (-not (Test-Path (Join-Path $foundryBin "forge.exe"))) { throw "forge/cast not found; install Foundry" }
    $env:PATH = "$env:PATH;$foundryBin"
}

function Invoke-Tool {
    param([string]$Exe, [string[]]$ToolArgs)
    # Native tools print warnings on stderr; success is judged by the exit code only.
    $ErrorActionPreference = "Continue"
    $out = & $Exe @ToolArgs 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 15 | Write-Host; throw "$Exe $($ToolArgs -join ' ') failed (exit $LASTEXITCODE)" }
    return $out
}
# Read-only cast commands are retried (anvil fetches fork state lazily from the public RPC). Transactions are not.
function Invoke-Cast {
    $castArgs = [string[]]$args
    $readOnly = @("call", "code", "chain-id", "nonce", "rpc", "keccak", "index", "to-uint256", "to-check-sum-address",
        "storage", "parse-bytes32-address", "block-number", "balance") -contains $castArgs[0]
    for ($attempt = 1; ; $attempt++) {
        try { return Invoke-Tool "cast" $castArgs }
        catch {
            if (-not $readOnly -or $attempt -ge 5) { throw }
            Write-Host "  ..  retrying cast $($castArgs[0]) ($attempt/4) after an RPC error"
            Start-Sleep -Seconds 3
        }
    }
}
function Get-Uint($text) { return [decimal](("$text").Trim().Split(" ")[0]) }
function New-LabelAddress([string]$label) {
    $h = ("" + (Invoke-Cast keccak $label)).Trim()
    return ("" + (Invoke-Cast to-check-sum-address $h.Substring(0, 42))).Trim()
}
function Get-Impl([string]$proxy) {
    $word = ("" + (Invoke-Cast storage $proxy $ImplSlot --rpc-url $Rpc)).Trim()
    return ("" + (Invoke-Cast parse-bytes32-address $word)).Trim()
}
function Get-Beacon([string]$proxy) {
    $word = ("" + (Invoke-Cast storage $proxy $BeaconSlot --rpc-url $Rpc)).Trim()
    return ("" + (Invoke-Cast parse-bytes32-address $word)).Trim()
}
function Set-TokenBalance([string]$token, [int]$slot, [string]$holder, [decimal]$amount) {
    $key = ("" + (Invoke-Cast index address $holder $slot)).Trim()
    $value = ("" + (Invoke-Cast to-uint256 $amount)).Trim()
    Invoke-Cast rpc anvil_setStorageAt $token $key $value --rpc-url $Rpc | Out-Null
    $bal = Get-Bal $token $holder
    if ($bal -ne $amount) { throw "Balance slot $slot of $token is wrong (got $bal); probe it again." }
}
function Get-Bal([string]$token, [string]$holder) { return Get-Uint (Invoke-Cast call $token "balanceOf(address)(uint256)" $holder --rpc-url $Rpc) }
function Get-Nand([string]$transistors, [string]$holder) { return Get-Uint (Invoke-Cast call $transistors "balanceOf(address,uint256)(uint256)" $holder 0 --rpc-url $Rpc) }
function Read-Uint([string]$to, [string]$sig) { $rest = @($args); return Get-Uint (Invoke-Cast call $to $sig @rest --rpc-url $Rpc) }

$gasLog = [System.Collections.ArrayList]::new()
function Add-Gas([string]$step, [decimal]$gas, [string]$kind) {
    [void]$gasLog.Add([ordered]@{ step = $step; gas = $gas; kind = $kind })
    Write-Host ("  gas {0,12:N0}  {1}  [{2}]" -f $gas, $step, $kind)
}
# One transaction from an impersonated account, sent with cast's eth_estimateGas limit like a wallet. Returns the receipt.
function Send-Tx([string]$step, [string]$from, [string]$to, [string]$sig) {
    $rest = @($args)
    $callArgs = @("call", $to, $sig) + $rest + @("--from", $from, "--rpc-url", $Rpc)
    Invoke-Cast @callArgs | Out-Null   # simulate first; also loads the touched fork state into anvil's cache
    $sendArgs = @("send", $to, $sig) + $rest + @("--from", $from, "--unlocked", "--rpc-url", $Rpc, "--json")
    $raw = (Invoke-Tool "cast" $sendArgs) -join ""
    $r = $raw.Substring($raw.IndexOf("{")) | ConvertFrom-Json
    if ([Convert]::ToInt64($r.status, 16) -ne 1) { throw "$step reverted" }
    Add-Gas $step ([decimal][Convert]::ToInt64($r.gasUsed, 16)) "anvil receipt"
    return $r
}
function Assert-Equal($actual, $expected, [string]$what) {
    if ("$actual" -ne "$expected") { throw "FAILED: $what (expected $expected, got $actual)" }
    Write-Host "  ok  $what"
}
# forge script WITHOUT --broadcast, as the runbook's first run of each command. Records forge's estimate
# (which includes forge's default 130% gas estimate multiplier).
function Invoke-Simulation([string]$step, [string[]]$forgeArgs) {
    if ($forgeArgs -contains "--broadcast") { throw "simulation must not broadcast" }
    $text = (Invoke-Tool "forge" $forgeArgs) -join "`n"
    if ($text -notmatch "SIMULATION COMPLETE") { throw "$step : forge did not report a completed simulation" }
    $m = [regex]::Match($text, "Estimated total gas used for script: (\d+)")
    if (-not $m.Success) { throw "$step : no gas estimate in forge output" }
    Add-Gas $step ([decimal]$m.Groups[1].Value) "forge simulation, no --broadcast"
    return $text
}
function Get-BroadcastGas([string]$script) {
    $j = Get-Content (Join-Path "broadcast-dryrun" "$script/196/run-latest.json") -Raw | ConvertFrom-Json
    $sum = [decimal]0
    foreach ($r in $j.receipts) { $sum += [decimal][Convert]::ToInt64($r.gasUsed, 16) }
    return @{ gas = $sum; txs = @($j.receipts).Count }
}

# --- guard: this must be anvil forking X Layer
Invoke-Cast rpc anvil_nodeInfo --rpc-url $Rpc | Out-Null
Assert-Equal ("" + (Invoke-Cast chain-id --rpc-url $Rpc)).Trim() "196" "chain id is 196 (X Layer fork)"
$forkBlock = ("" + (Invoke-Cast block-number --rpc-url $Rpc)).Trim()
Write-Host "anvil at block $forkBlock"

Push-Location (Join-Path $PSScriptRoot "..")
$env:FOUNDRY_BROADCAST = "broadcast-dryrun"
$env:FOUNDRY_CACHE_PATH = "cache-dryrun"
$env:FOUNDRY_OUT = "out-dryrun"
Remove-Item -Recurse -Force "broadcast-dryrun" -ErrorAction SilentlyContinue
Get-ChildItem "cache-dryrun" -Directory -Filter "*.s.sol" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
New-Item -ItemType Directory -Force "broadcast-dryrun" | Out-Null
$report = [ordered]@{ forkBlock = $forkBlock; drift = [ordered]@{}; fees = [ordered]@{}; gas = $gasLog; demo = [ordered]@{}; passed = $false }
try {
    # --- 0. drift check
    Write-Host "0. drift check against the runbook's values"
    $live = [ordered]@{
        factoryImpl          = Get-Impl $Factory
        circuitsBeaconImpl   = ("" + (Invoke-Cast call $CircuitsBeacon "implementation()(address)" --rpc-url $Rpc)).Trim()
        deployFee            = [string](Read-Uint $Factory "deployFee()(uint256)")
        protocolFee          = [string](Read-Uint $Factory "protocolFee()(uint256)")
    }
    foreach ($k in $live.Keys) {
        $same = $live[$k] -eq $Expected[$k]
        $report.drift[$k] = [ordered]@{ expected = $Expected[$k]; live = $live[$k]; same = $same }
        Write-Host ("  {0}  {1} = {2}" -f $(if ($same) { "same " } else { "DRIFT" }), $k, $live[$k])
    }

    $controller = New-LabelAddress "circuitwill.dryrun.controller"
    $payee = New-LabelAddress "circuitwill.dryrun.payee"
    foreach ($a in @($controller, $payee)) {
        if (("" + (Invoke-Cast code $a --rpc-url $Rpc)).Trim() -ne "0x") { throw "$a has code on this fork" }
    }
    Invoke-Cast rpc anvil_impersonateAccount $controller --rpc-url $Rpc | Out-Null
    Invoke-Cast rpc anvil_setBalance $controller "0x8AC7230489E80000" --rpc-url $Rpc | Out-Null  # 10 OKB, anvil only
    Set-TokenBalance $Bem $BemBalanceSlot $controller 100000000                                  # 1 BEM, anvil only
    Set-TokenBalance $Usdt0 $Usdt0BalanceSlot $controller 60000000                               # 60 USDT0, anvil only
    Write-Host "controller $controller, payee $payee (fresh addresses, anvil only)"

    # --- 1. CPU and NAND (runbook steps 1-2), approvals for the exact fee only
    Write-Host "1. CPU and NAND"
    Send-Tx "BEM approve factory, exactly deployFee" $controller $Bem "approve(address,uint256)" $Factory $live.deployFee | Out-Null
    $bem0 = Get-Bal $Bem $controller
    $index = Read-Uint $Factory "cpuCount()(uint256)"
    $r = Send-Tx "createCPU" $controller $Factory "createCPU(string,string,string,uint256,uint256)" "CircuitWill" "CWILL" "CircuitWill rule circuits" 1000000 0
    $circuits = ("" + (Invoke-Cast call $Factory "cpus(uint256)(address)" $index --rpc-url $Rpc)).Trim()
    Assert-Equal ("" + (Invoke-Cast call $Factory "isCPU(address)(bool)" $circuits --rpc-url $Rpc)).Trim() "true" "factory.cpus(cpuCount before) is a CPU"
    $logAddrs = @($r.logs | ForEach-Object { $_.address.ToLower() })
    Assert-Equal ($logAddrs -contains $circuits.ToLower()) $true "the createCPU receipt has logs from that circuits contract"
    $transistors = ("" + (Invoke-Cast call $circuits "transistors()(address)" --rpc-url $Rpc)).Trim()
    $report.fees.createCpuBem = [string]($bem0 - (Get-Bal $Bem $controller))
    Write-Host "  CPU: circuits $circuits, transistors $transistors; createCPU pulled $($report.fees.createCpuBem) BEM base units"
    # The new CPU's own beacons (factory.transistorBeacon() is a legacy beacon that new CPUs do not use).
    $more = [ordered]@{
        newCpuCircuitsBeacon = Get-Beacon $circuits
        transistorBeaconImpl = ("" + (Invoke-Cast call (Get-Beacon $transistors) "implementation()(address)" --rpc-url $Rpc)).Trim()
        tapeoutFee           = [string](Read-Uint $circuits "TAPEOUT_FEE()(uint256)")
    }
    foreach ($k in $more.Keys) {
        $same = $more[$k] -eq $Expected[$k]
        $report.drift[$k] = [ordered]@{ expected = $Expected[$k]; live = $more[$k]; same = $same }
        Write-Host ("  {0}  {1} = {2}" -f $(if ($same) { "same " } else { "DRIFT" }), $k, $more[$k])
    }

    $slugs = @("daily-cap", "payee-whitelist", "confirmation", "freeze")
    $gates = 0
    foreach ($s in $slugs) { $gates += ((Get-Content "../circuits/$s/build/$s.netlist.hex" -Raw).Trim().Length - 2) / 14 }
    Send-Tx "BEM approve transistors, exactly protocolFee" $controller $Bem "approve(address,uint256)" $transistors $live.protocolFee | Out-Null
    $bem1 = Get-Bal $Bem $controller
    Send-Tx "mint $gates NAND" $controller $transistors "mint(uint256,uint256)" 0 $gates | Out-Null
    $report.fees.mintBem = [string]($bem1 - (Get-Bal $Bem $controller))
    Assert-Equal (Get-Nand $transistors $controller) $gates "minted $gates NAND (pulled $($report.fees.mintBem) BEM base units)"

    # --- 2. tapeouts (runbook step 3): simulate without --broadcast, then execute on anvil to get the ids
    Write-Host "2. TapeOutCircuit.s.sol"
    $env:TAPEOUT_CIRCUITS = $circuits
    $ids = [ordered]@{}
    foreach ($s in $slugs) {
        $env:CIRCUIT = $s
        $base = @("script", "script/TapeOutCircuit.s.sol", "--rpc-url", $Rpc, "--sender", $controller)
        Invoke-Simulation "simulate tapeout $s" $base | Out-Null
        $okbBefore = Get-Uint (Invoke-Cast balance $controller --rpc-url $Rpc)
        $text = (Invoke-Tool "forge" ($base + @("--unlocked", "--broadcast", "--slow"))) -join "`n"
        $m = [regex]::Match($text, "circuit id: (\d+)")
        if (-not $m.Success) { throw "no circuit id for $s" }
        $ids[$s] = $m.Groups[1].Value
        $g = Get-BroadcastGas "TapeOutCircuit.s.sol"
        Add-Gas "tapeout $s (circuit $($ids[$s]))" $g.gas "anvil receipt"
    }
    Assert-Equal (Get-Nand $transistors $controller) 0 "all $gates NAND burned"
    $report.demo.processor = $circuits
    $report.demo.circuitIds = $ids

    # --- 3. Deploy.s.sol (runbook step 4)
    Write-Host "3. Deploy.s.sol"
    $env:DAILY_CAP_CIRCUIT_ID = $ids["daily-cap"]
    $env:DAILY_CAP = "50000000"
    $env:WHITELIST_CIRCUIT_ID = $ids["payee-whitelist"]
    $env:TRIAL_LIMIT = "5000000"
    $env:COOLING_OFF_HOURS = "24"
    $env:SAVED_PAYEES = "$payee,$controller"
    $env:CONFIRMATION_CIRCUIT_ID = $ids["confirmation"]
    $env:CONFIRMATION_THRESHOLD = "20000000"
    $env:FREEZE_CIRCUIT_ID = $ids["freeze"]
    Remove-Item Env:AGENT -ErrorAction SilentlyContinue
    $base = @("script", "script/Deploy.s.sol", "--rpc-url", $Rpc, "--sender", $controller)
    Invoke-Simulation "simulate Deploy.s.sol" $base | Out-Null
    $text = (Invoke-Tool "forge" ($base + @("--unlocked", "--broadcast", "--slow"))) -join "`n"
    $m = [regex]::Match($text, "CircuitWillEscrow: (0x[0-9a-fA-F]{40})")
    if (-not $m.Success) { throw "no escrow address in Deploy.s.sol output" }
    $escrow = $m.Groups[1].Value
    $g = Get-BroadcastGas "Deploy.s.sol"
    Add-Gas "Deploy.s.sol ($($g.txs) transactions)" $g.gas "anvil receipts"
    $report.demo.escrow = $escrow
    $report.demo.deployTxs = $g.txs
    Assert-Equal ("" + (Invoke-Cast call $escrow "controller()(address)" --rpc-url $Rpc)).Trim() $controller "controller is the deployer"
    Assert-Equal (Read-Uint $escrow "circuitCount()(uint256)") 4 "four circuits attached"

    # --- 4. funding and demo (runbook steps 7-8)
    Write-Host "4. demo"
    Send-Tx "fund: USDT0 transfer 60" $controller $Usdt0 "transfer(address,uint256)" $escrow 60000000 | Out-Null
    Assert-Equal (Get-Bal $Usdt0 $escrow) 60000000 "escrow holds 60 USDT0"

    $h60 = ("" + (Invoke-Cast call $escrow "currentPaymentHash(address,uint256)(bytes32)" $payee 60000000 --rpc-url $Rpc)).Trim()
    Send-Tx "confirmPayment (60)" $controller $escrow "confirmPayment(bytes32)" $h60 | Out-Null
    $r60 = Send-Tx "proposePayment 60 (blocked)" $controller $escrow "proposePayment(address,uint256,string)" $payee 60000000 "demo: 60 over the daily cap"
    Assert-Equal (Get-Bal $Usdt0 $escrow) 60000000 "60 blocked: no funds moved"
    Assert-Equal (Read-Uint $escrow "currentSpentToday()(uint256)") 0 "60 blocked: spent today stays 0"

    $h30 = ("" + (Invoke-Cast call $escrow "currentPaymentHash(address,uint256)(bytes32)" $payee 30000000 --rpc-url $Rpc)).Trim()
    Send-Tx "confirmPayment (30)" $controller $escrow "confirmPayment(bytes32)" $h30 | Out-Null
    $r30 = Send-Tx "proposePayment 30 (allowed)" $controller $escrow "proposePayment(address,uint256,string)" $payee 30000000 "demo: 30 within the daily cap"
    Assert-Equal (Get-Bal $Usdt0 $payee) 30000000 "30 allowed: payee received 30 USDT0"
    Assert-Equal (Read-Uint $escrow "currentSpentToday()(uint256)") 30000000 "spent today 30"
    Assert-Equal (Read-Uint $escrow "paymentNonce(address)(uint256)" $payee) 1 "confirmation consumed"

    foreach ($pair in @(@("blocked 60", $r60.transactionHash), @("allowed 30", $r30.transactionHash))) {
        $out = Invoke-Tool "node" @("../frontend/scripts/reevaluate.mjs", $pair[1], $Rpc)
        $out | Select-Object -First 5 | ForEach-Object { Write-Host "      $_" }
        $text = $out -join "`n"
        if ($text -notmatch "Re-evaluation matches the record") { throw "re-evaluation of $($pair[0]) failed" }
        Write-Host "  ok  re-evaluation of $($pair[0]) ($($pair[1]))"
        $report.demo[$pair[0]] = [ordered]@{ tx = $pair[1]; reevaluation = ($out | Select-Object -First 5) }
    }
    $t60 = ($report.demo["blocked 60"].reevaluation) -join "`n"
    if ($t60 -notmatch "BLOCKED \(CIRCUIT_DENIED\)" -or $t60 -notmatch "Daily Cap: DENY" -or $t60 -match "(Whitelist|Confirmation|Freeze)[^\n]*: DENY") {
        throw "the 60 USDT0 decision was not blocked by the Daily Cap alone"
    }
    Write-Host "  ok  60 USDT0 was blocked by the Daily Cap alone (the others allowed)"

    # --- 5. is the BEM mint fee per call or per transistor?
    Write-Host "5. mint fee probe"
    Send-Tx "BEM approve transistors (probe)" $controller $Bem "approve(address,uint256)" $transistors $live.protocolFee | Out-Null
    $bem2 = Get-Bal $Bem $controller
    Send-Tx "mint 1 NAND (probe)" $controller $transistors "mint(uint256,uint256)" 0 1 | Out-Null
    $report.fees.mintOneBem = [string]($bem2 - (Get-Bal $Bem $controller))
    Write-Host "  mint 845 pulled $($report.fees.mintBem), mint 1 pulled $($report.fees.mintOneBem) BEM base units"

    # --- 6. a custom rule ("Up to 10 a day", circuits/custom/build/daily-10), published like the dashboard does:
    #        mint its NAND, tape it out, check the netlist hash, attachCustomRule. Then the next UTC day: 10 allowed,
    #        1 more blocked by the custom rule alone.
    Write-Host "6. custom rule"
    $rule = "daily-10"
    $nlHex = (Get-Content "../circuits/custom/build/$rule.netlist.hex" -Raw).Trim()
    $ruleGates = ($nlHex.Length - 2) / 14
    Send-Tx "BEM approve transistors (custom rule)" $controller $Bem "approve(address,uint256)" $transistors $live.protocolFee | Out-Null
    Send-Tx "mint $ruleGates NAND (custom rule)" $controller $transistors "mint(uint256,uint256)" 0 $ruleGates | Out-Null
    Remove-Item Env:CIRCUIT -ErrorAction SilentlyContinue
    $env:CUSTOM_RULE = $rule
    $base = @("script", "script/TapeOutCircuit.s.sol", "--rpc-url", $Rpc, "--sender", $controller)
    Invoke-Simulation "simulate tapeout custom $rule" $base | Out-Null
    $text = (Invoke-Tool "forge" ($base + @("--unlocked", "--broadcast", "--slow"))) -join "`n"
    Remove-Item Env:CUSTOM_RULE
    $m = [regex]::Match($text, "circuit id: (\d+)")
    if (-not $m.Success) { throw "no circuit id for the custom rule" }
    $customId = $m.Groups[1].Value
    $g = Get-BroadcastGas "TapeOutCircuit.s.sol"
    Add-Gas "tapeout custom $rule ($ruleGates NAND, circuit $customId)" $g.gas "anvil receipt"
    $netlistHash = ("" + (Invoke-Cast keccak $nlHex)).Trim()
    $specText = Get-Content "../circuits/custom/build/$rule.spec.txt" -Raw
    $specHex = "0x" + (([System.Text.Encoding]::UTF8.GetBytes($specText) | ForEach-Object { $_.ToString("x2") }) -join "")
    $specHash = ("" + (Invoke-Cast keccak $specHex)).Trim()
    Send-Tx "attachCustomRule ($rule)" $controller $escrow "attachCustomRule(address,uint256,bytes32,bytes32,string)" $circuits $customId $netlistHash $specHash "Everyone: day <=10 USDT0" | Out-Null
    Assert-Equal (Read-Uint $escrow "circuitCount()(uint256)") 5 "five circuits attached (four official + one custom)"
    Assert-Equal (Read-Uint $escrow "customRuleCount()(uint256)") 1 "one custom rule"
    $report.demo.customRule = [ordered]@{ slug = $rule; circuitId = $customId; gates = $ruleGates; netlistHash = $netlistHash; specHash = $specHash }

    $now = Read-Uint $escrow "today()(uint32)"
    Invoke-Cast rpc evm_increaseTime 86400 --rpc-url $Rpc | Out-Null   # anvil only: move to the next UTC day
    Invoke-Cast rpc evm_mine --rpc-url $Rpc | Out-Null
    Assert-Equal (Read-Uint $escrow "today()(uint32)") ($now + 1) "next UTC day"
    $r10 = Send-Tx "proposePayment 10 (allowed, 5 circuits)" $controller $escrow "proposePayment(address,uint256,string)" $payee 10000000 "demo: 10, at the custom limit"
    Assert-Equal (Get-Bal $Usdt0 $payee) 40000000 "10 allowed: payee now holds 40 USDT0"
    $r1 = Send-Tx "proposePayment 1 (blocked by the custom rule)" $controller $escrow "proposePayment(address,uint256,string)" $payee 1000000 "demo: 1 more, over the custom limit"
    Assert-Equal (Get-Bal $Usdt0 $payee) 40000000 "1 blocked: no funds moved"
    foreach ($pair in @(@("custom allowed 10", $r10.transactionHash), @("custom blocked 1", $r1.transactionHash))) {
        $out = Invoke-Tool "node" @("../frontend/scripts/reevaluate.mjs", $pair[1], $Rpc)
        $out | Select-Object -First 7 | ForEach-Object { Write-Host "      $_" }
        if (($out -join "`n") -notmatch "Re-evaluation matches the record") { throw "re-evaluation of $($pair[0]) failed" }
        Write-Host "  ok  re-evaluation of $($pair[0]) ($($pair[1]))"
        $report.demo[$pair[0]] = [ordered]@{ tx = $pair[1]; reevaluation = ($out | Select-Object -First 7) }
    }
    $t1 = ($report.demo["custom blocked 1"].reevaluation) -join "`n"
    if ($t1 -notmatch "Custom rule: DENY" -or $t1 -match "(Daily Cap|Whitelist|Confirmation|Freeze)[^\n]*: DENY") {
        throw "the 1 USDT0 decision was not blocked by the custom rule alone"
    }
    Write-Host "  ok  1 USDT0 was blocked by the custom rule alone (the official four allowed)"

    # --- 7. loosening delay: raising the daily cap reverts, then works after queue + ruleDelay + apply
    Write-Host "7. loosening delay"
    $delayed = $false
    try { Invoke-Tool "cast" @("call", $escrow, "setDailyCap(uint256)", "100000000", "--from", $controller, "--rpc-url", $Rpc) | Out-Null }
    catch { $delayed = $true }
    Assert-Equal $delayed $true "raising the daily cap directly is refused (LooseningIsDelayed)"
    Send-Tx "queueChange DAILY_CAP 100" $controller $escrow "queueChange(uint8,address,uint256)" 0 "0x0000000000000000000000000000000000000000" 100000000 | Out-Null
    $changeId = Read-Uint $escrow "changeCount()(uint256)"
    $early = $false
    try { Invoke-Tool "cast" @("call", $escrow, "applyChange(uint256)", "$changeId", "--from", $controller, "--rpc-url", $Rpc) | Out-Null }
    catch { $early = $true }
    Assert-Equal $early $true "applying before the delay is refused"
    $delay = Read-Uint $escrow "ruleDelay()(uint256)"
    Invoke-Cast rpc evm_increaseTime ([int]$delay + 60) --rpc-url $Rpc | Out-Null   # anvil only
    Invoke-Cast rpc evm_mine --rpc-url $Rpc | Out-Null
    Send-Tx "applyChange (after $delay s)" $controller $escrow "applyChange(uint256)" $changeId | Out-Null
    Assert-Equal (Read-Uint $escrow "dailyCap()(uint256)") 100000000 "daily cap is 100 USDT0 after the delay"

    $report.passed = $true
    Write-Host "Dry run passed on the local anvil fork (block $forkBlock). Nothing was sent to X Layer."
}
finally {
    $report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 "broadcast-dryrun/dryrun-report.json"
    Write-Host "report: contracts/broadcast-dryrun/dryrun-report.json"
    Pop-Location
}
