$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'bailian-free-pool-sync.psm1') -Force

function Assert-Equal {
    param([object]$Actual, [object]$Expected, [string]$Message)
    if ($Actual -is [System.Array] -or $Expected -is [System.Array]) {
        $actualJson = ConvertTo-Json -InputObject @($Actual) -Depth 20 -Compress
        $expectedJson = ConvertTo-Json -InputObject @($Expected) -Depth 20 -Compress
        if ($actualJson -cne $expectedJson) { throw "$Message`nExpected: $expectedJson`nActual:   $actualJson" }
    } elseif ($Actual -cne $Expected) {
        throw "$Message (expected '$Expected', got '$Actual')"
    }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Message)
    try { & $Action } catch { return }
    throw $Message
}

function Assert-Contains {
    param([string]$Text, [string]$Needle, [string]$Message)
    if ($Text.IndexOf($Needle, [StringComparison]::Ordinal) -lt 0) { throw $Message }
}

# This is intentionally offline. Parse and load only the launcher helper
# functions, then exercise their three supported Windows command types with
# mocked command objects. The real CLI is never started.
$syncPath = Join-Path $PSScriptRoot 'sync-bailian-free-pool.ps1'
$tokens = $parseErrors = $null
$syncAst = [System.Management.Automation.Language.Parser]::ParseFile($syncPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'The sync script has PowerShell parse errors.' }
$functionAsts = @($syncAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
$launcherAst = $functionAsts | Where-Object Name -eq 'Resolve-BailianCliLauncher' | Select-Object -First 1
$jsonRetryAst = $functionAsts | Where-Object Name -eq 'Invoke-BailianJsonRetry' | Select-Object -First 1
if (-not $launcherAst -or -not $jsonRetryAst) { throw 'Sync helper functions were not found in the sync script.' }
. ([scriptblock]::Create($launcherAst.Extent.Text))
. ([scriptblock]::Create($jsonRetryAst.Extent.Text))
$psLauncher = Resolve-BailianCliLauncher -Command ([pscustomobject]@{ Path = 'C:\Users\tester\AppData\Roaming\npm\bl.ps1' }) -Arguments @('model', 'list', '--model', 'qwen-plus')
Assert-Equal ([IO.Path]::GetExtension($psLauncher.FileName).ToLowerInvariant()) '.exe' 'bl.ps1 should launch through a PowerShell executable.'
Assert-Equal $psLauncher.Arguments[0] '-NoProfile' 'bl.ps1 launcher should disable profile loading.'
Assert-Equal $psLauncher.Arguments[1] '-File' 'bl.ps1 launcher should pass the script with -File.'
Assert-Equal $psLauncher.Arguments[3] 'model' 'bl.ps1 launcher should preserve CLI argument order.'
$cmdLauncher = Resolve-BailianCliLauncher -Command ([pscustomobject]@{ Path = 'C:\Program Files\Bailian\bl.cmd' }) -Arguments @('model', 'list', '--model', 'qwen-plus')
Assert-Equal $cmdLauncher.Arguments[0] '/d' 'bl.cmd launcher should disable AutoRun commands.'
Assert-Equal $cmdLauncher.Arguments[2] '/c' 'bl.cmd launcher should use cmd /c.'
Assert-Equal $cmdLauncher.Arguments[3] 'call' 'bl.cmd launcher should invoke the shim with call.'
Assert-Equal $cmdLauncher.Arguments[4] 'C:\Program Files\Bailian\bl.cmd' 'bl.cmd launcher should preserve a spaced shim path as one argument.'
Assert-Equal $cmdLauncher.Arguments[8] 'qwen-plus' 'bl.cmd launcher should preserve the model ID as one argument.'
$exeLauncher = Resolve-BailianCliLauncher -Command ([pscustomobject]@{ Path = 'C:\Tools\bl.exe' }) -Arguments @('usage', 'free')
Assert-Equal $exeLauncher.FileName 'C:\Tools\bl.exe' 'bl.exe launcher should execute the binary directly.'
Assert-Equal $exeLauncher.Arguments[1] 'free' 'bl.exe launcher should preserve direct arguments.'
$launcherSource = $launcherAst.Extent.Text
Assert-Contains $launcherSource "'.ps1'" 'Launcher source must handle PowerShell shims.'
Assert-Contains $launcherSource "'.cmd', '.bat'" 'Launcher source must handle cmd shims.'
Assert-Contains $launcherSource "'-NoProfile'" 'Launcher source must isolate PowerShell CLI execution.'
Assert-Contains $launcherSource "'/d'" 'Launcher source must disable cmd AutoRun commands.'
Assert-Contains $launcherSource 'ArgumentList' 'Launcher source must preserve argument boundaries.'

$script:jsonAttempts = 0
$retriedJson = Invoke-BailianJsonRetry -Operation 'offline fixture' -Attempt {
    $script:jsonAttempts += 1
    if ($script:jsonAttempts -eq 1) { return 'temporary non-json response' }
    return '{"ok":true}'
}
Assert-Equal $script:jsonAttempts 2 'Invalid JSON should trigger exactly one bounded retry.'
Assert-Equal (($retriedJson | ConvertFrom-Json).ok) $true 'The retry helper should return the valid second response.'
$script:jsonAttempts = 0
Assert-Throws {
    Invoke-BailianJsonRetry -Operation 'offline fixture' -Attempt {
        $script:jsonAttempts += 1
        return 'still not json'
    }
} 'Two invalid JSON responses must fail.'
Assert-Equal $script:jsonAttempts 2 'Invalid JSON retry must remain bounded to two attempts.'
$script:jsonAttempts = 0
Assert-Throws {
    Invoke-BailianJsonRetry -Operation 'offline fixture' -Attempt {
        $script:jsonAttempts += 1
        throw 'process failure'
    }
} 'Process failures must not be retried as JSON errors.'
Assert-Equal $script:jsonAttempts 1 'Process failures should be propagated immediately.'

$quotaJson = @'
[
  {"model":"qwen-plus-2026-01-01","type":"Text","remaining":24000,"total":100000,"usagePercent":76,"remainingPercent":24,"expires":"2099-12-31","autoStop":true},
  {"model":"qwen-vl-plus-2026-01-01","type":"Vision","remaining":0,"total":50000,"usagePercent":100,"remainingPercent":0,"expires":"2099-12-31","autoStop":true},
  {"model":"qwen-audio-turbo","type":"Audio","remaining":999,"total":1000,"usagePercent":1,"remainingPercent":99,"expires":"2099-12-31","autoStop":true}
]
'@
$modelDetails = @(
    @'
 {"model":"qwen-plus","name":"Qwen Family","items":[{"model":"qwen-plus-2026-01-01","name":"Qwen Plus Exact Version","provider":"Alibaba","capabilities":["TG"],"features":["structured-outputs"],"modalities":{"input":["Text"],"output":["Text"]},"offline":false,"upcomingOfflineAt":null},{"model":"qwen-vl-plus-2026-01-01","name":"Another Quota Model In Family Response","provider":"Alibaba","capabilities":["VU"],"features":["structured-outputs"],"modalities":{"input":["Image"],"output":["Text"]},"offline":false,"upcomingOfflineAt":null}]}
'@,
    @'
 {"model":"qwen-vl-plus-2026-01-01","name":"Qwen VL Family","items":[{"model":"qwen-vl-plus-2026-01-01","name":"Qwen VL Exact Version","provider":"Alibaba","capabilities":["VU"],"features":["structured-outputs"],"modalities":{"input":["Text","Image"],"output":["Text"]},"offline":false,"upcomingOfflineAt":null}]}
'@
)

$parsedQuotas = @(ConvertFrom-BailianQuotaJson -Json $quotaJson)
Assert-Equal $parsedQuotas.Count 2 'Quota parser should retain supported text/vision rows only.'
Assert-Equal $parsedQuotas[0].model 'qwen-plus-2026-01-01' 'Quota model should be preserved.'
Assert-Equal $parsedQuotas[1].remaining 0 'Exhausted rows should remain available for server diff policy.'

$parsedModel = ConvertFrom-BailianModelDetailJson -Json $modelDetails[0] -ExpectedModel 'qwen-plus-2026-01-01'
Assert-Equal $parsedModel.model 'qwen-plus-2026-01-01' 'Detail parser should return the exact version.'
Assert-Equal $parsedModel.name 'Qwen Plus Exact Version' 'Detail parser should preserve the exact item display name.'
Assert-Equal $parsedModel.modalities.input[0] 'Text' 'Detail parser should preserve normalized modalities.'

$empty = @(ConvertFrom-BailianQuotaJson -Json '[]')
Assert-Equal $empty.Count 0 'A valid empty quota array should be accepted.'
$singleQuota = @(ConvertFrom-BailianQuotaJson -Json '[{"model":"single","type":"Text","remaining":1,"total":2,"expires":"2099-01-01T00:00:00+08:00","autoStop":true}]')
Assert-Equal $singleQuota.Count 1 'A valid one-record quota array should be accepted.'
Assert-Throws { ConvertFrom-BailianQuotaJson -Json '[{"model":"cut' } 'Truncated quota JSON must fail.'
Assert-Throws { ConvertFrom-BailianQuotaJson -Json '[{"model":"m","type":"Text","remaining":1,"total":2,"expires":"2099-01-01","autoStop":true},{"model":"m","type":"Vision","remaining":1,"total":2,"expires":"2099-01-01","autoStop":true}]' } 'Duplicate quota model IDs must fail.'
Assert-Throws { ConvertFrom-BailianQuotaJson -Json '[{"model":"m","type":"Text","remaining":1,"total":2,"autoStop":true}]' } 'Missing quota expiry must fail.'
Assert-Throws { ConvertFrom-BailianQuotaJson -Json '[{"model":"m","type":"Text","remaining":-1,"total":2,"expires":"2099-01-01","autoStop":true}]' } 'Invalid quota ranges must fail.'
Assert-Throws { ConvertFrom-BailianQuotaJson -Json '[{"model":"m","type":"Text","remaining":9007199254740992,"total":9007199254740992,"expires":"2099-01-01","autoStop":true}]' } 'Unsafe quota integers must fail.'
Assert-Throws { ConvertFrom-BailianQuotaJson -Json '[{"model":"m","type":"Text","remaining":1,"total":2,"expires":"2099-02-30","autoStop":true}]' } 'Impossible quota expiry dates must fail.'
Assert-Throws { ConvertFrom-BailianModelDetailJson -Json $modelDetails[0] -ExpectedModel 'qwen-max' } 'Mismatched detail model IDs must fail.'
Assert-Throws { ConvertFrom-BailianModelDetailJson -Json '{"model":"m","name":"M","items":[]}' -ExpectedModel 'm' } 'Missing exact detail items must fail.'
$insufficientCapabilities = ConvertFrom-BailianModelDetailJson -Json '{"model":"m","items":[{"model":"m","name":"M","provider":"P","capabilities":[],"features":["structured-outputs"],"modalities":{"input":[],"output":[]},"offline":false}]}' -ExpectedModel 'm'
Assert-Equal $insufficientCapabilities.capabilities.Count 0 'A valid empty capability list should reach server exclusion policy.'
Assert-Equal $insufficientCapabilities.modalities.input.Count 0 'Valid empty modalities should reach server exclusion policy.'
$missingStructuredOutputs = ConvertFrom-BailianModelDetailJson -Json '{"model":"m","items":[{"model":"m","name":"M","provider":"P","capabilities":["TG"],"features":[],"modalities":{"input":["Text"],"output":["Text"]},"offline":false}]}' -ExpectedModel 'm'
Assert-Equal $missingStructuredOutputs.features.Count 0 'A valid feature list without structured outputs should reach server exclusion policy.'
$onlineWithoutOfflineFlag = ConvertFrom-BailianModelDetailJson -Json '{"model":"m-family","items":[{"model":"m","name":"M","provider":"P","capabilities":["TG"],"features":["structured-outputs"],"modalities":{"input":["Text"],"output":["Text"]}}]}' -ExpectedModel 'm'
Assert-Equal $onlineWithoutOfflineFlag.offline $false 'The official CLI omits offline for online models; the normalizer should emit false.'

$snapshot = New-BailianFreePoolSnapshot -ProviderId 'provider-1' -QuotaJson $quotaJson -ModelDetails $modelDetails -AccountMatchConfirmed
Assert-Equal $snapshot.providerId 'provider-1' 'Snapshot should associate the selected provider.'
Assert-Equal $snapshot.accountMatchConfirmed $true 'Snapshot should record explicit account-match confirmation.'
Assert-Equal $snapshot.quotas.Count 2 'Snapshot should preserve all supported quota rows for service policy.'
Assert-Equal $snapshot.models.Count 2 'Snapshot should include exact details for supported text/vision quota IDs.'
Assert-Equal $snapshot.models[0].capabilities[0] 'TG' 'Snapshot should normalize model detail metadata.'

Assert-Throws {
    New-BailianFreePoolSnapshot -ProviderId 'provider-1' -QuotaJson $quotaJson -ModelDetails @($modelDetails[0]) -AccountMatchConfirmed
} 'Missing supported model details must fail the whole snapshot.'

Write-Output 'Bailian free pool parser tests passed.'
