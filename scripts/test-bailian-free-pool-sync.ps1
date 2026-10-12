$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'bailian-free-pool-sync.psm1') -Force

$moduleSource = Get-Content (Join-Path $PSScriptRoot 'bailian-free-pool-sync.psm1') -Raw
$launcherSourceFull = Get-Content (Join-Path $PSScriptRoot 'sync-bailian-free-pool.ps1') -Raw
if (($moduleSource -match '(?i)usage.?free|ConvertFrom-BailianQuotaJson|QuotaJson|autoStop|remaining|expires') -or
    ($launcherSourceFull -match "'usage',\s*'free'")) {
    throw 'The Qwen catalog collector must not contain free quota handling.'
}
if ((-not (Get-Command ConvertFrom-BailianModelCatalogJson -ErrorAction SilentlyContinue)) -or
    (-not (Get-Command New-BailianQianwenPoolSnapshot -ErrorAction SilentlyContinue))) {
    throw 'The Qwen model catalog parser and snapshot builder must be exported.'
}

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
$exeLauncher = Resolve-BailianCliLauncher -Command ([pscustomobject]@{ Path = 'C:\Tools\bl.exe' }) -Arguments @('model', 'list')
Assert-Equal $exeLauncher.FileName 'C:\Tools\bl.exe' 'bl.exe launcher should execute the binary directly.'
Assert-Equal $exeLauncher.Arguments[1] 'list' 'bl.exe launcher should preserve direct arguments.'
$launcherSource = $launcherAst.Extent.Text
Assert-Contains $launcherSource "'.ps1'" 'Launcher source must handle PowerShell shims.'
Assert-Contains $launcherSource "'.cmd', '.bat'" 'Launcher source must handle cmd shims.'
Assert-Contains $launcherSource "'-NoProfile'" 'Launcher source must isolate PowerShell CLI execution.'
Assert-Contains $launcherSource "'/d'" 'Launcher source must disable cmd AutoRun commands.'
Assert-Contains $launcherSource 'ArgumentList' 'Launcher source must preserve argument boundaries.'

$script:jsonAttempts = 0
$script:jsonRetryDelays = [System.Collections.Generic.List[int]]::new()
$retriedJson = Invoke-BailianJsonRetry -Operation 'offline fixture' -Attempt {
    $script:jsonAttempts += 1
    if ($script:jsonAttempts -eq 1) { return 'temporary non-json response' }
    return '{"ok":true}'
} -Delay {
    param([int]$attemptNumber)
    $script:jsonRetryDelays.Add($attemptNumber)
}
Assert-Equal $script:jsonAttempts 2 'Invalid JSON should trigger exactly one bounded retry.'
Assert-Equal @($script:jsonRetryDelays) @(1) 'A retry should apply one delay after the first invalid response.'
Assert-Equal (($retriedJson | ConvertFrom-Json).ok) $true 'The retry helper should return the valid second response.'
$script:jsonAttempts = 0
$script:jsonRetryDelays.Clear()
Assert-Throws {
    Invoke-BailianJsonRetry -Operation 'offline fixture' -Attempt {
        $script:jsonAttempts += 1
        return 'still not json'
    } -Delay {
        param([int]$attemptNumber)
        $script:jsonRetryDelays.Add($attemptNumber)
    }
} 'Three invalid JSON responses must fail.'
Assert-Equal $script:jsonAttempts 3 'Invalid JSON retry must remain bounded to three attempts.'
Assert-Equal @($script:jsonRetryDelays) @(1, 2) 'Invalid JSON retries should delay only between attempts.'
$script:jsonAttempts = 0
$script:jsonRetryDelays.Clear()
Assert-Throws {
    Invoke-BailianJsonRetry -Operation 'offline fixture' -Attempt {
        $script:jsonAttempts += 1
        throw 'process failure'
    } -Delay {
        param([int]$attemptNumber)
        $script:jsonRetryDelays.Add($attemptNumber)
    }
} 'Process failures must not be retried as JSON errors.'
Assert-Equal $script:jsonAttempts 1 'Process failures should be propagated immediately.'
Assert-Equal $script:jsonRetryDelays.Count 0 'Process failures must not enter the JSON retry delay path.'

$catalogJson = @'
{"models":[{"model":"qwen-plus","name":"Qwen Plus","provider":"Alibaba","capabilities":["TG"],"features":["structured-outputs"],"modalities":{"input":["Text"],"output":["Text"]},"offline":false},{"model":"qwen-vl-plus","name":"Qwen VL Plus","provider":"Alibaba","capabilities":["VU"],"features":["structured-outputs"],"modalities":{"input":["Text","Image"],"output":["Text"]},"offline":false},{"model":"deepseek-v3","name":"DeepSeek V3","provider":"DeepSeek","capabilities":["TG"],"features":["structured-outputs"],"modalities":{"input":["Text"],"output":["Text"]},"offline":false}]}
'@
$parsedModels = @(ConvertFrom-BailianModelCatalogJson -Json $catalogJson)
Assert-Equal $parsedModels.Count 3 'Catalog parser should preserve all directory models for server-side filtering.'
Assert-Equal $parsedModels[0].model 'qwen-plus' 'Catalog parser should preserve exact model IDs.'
Assert-Throws { ConvertFrom-BailianModelCatalogJson -Json '{"models":[{"model":"qwen-cut' } 'Truncated catalog JSON must fail.'
Assert-Throws { ConvertFrom-BailianModelCatalogJson -Json '{"models":[{"model":"qwen-a","name":"A","provider":"Alibaba","capabilities":[],"features":[],"modalities":{"input":[],"output":[]}},{"model":"qwen-a","name":"A","provider":"Alibaba","capabilities":[],"features":[],"modalities":{"input":[],"output":[]}}]}' } 'Duplicate catalog IDs must fail.'
Assert-Throws { ConvertFrom-BailianModelCatalogJson -Json '{"models":[{"model":"qwen-missing"}]}' } 'Missing catalog fields must fail.'

$snapshot = New-BailianQianwenPoolSnapshot -ProviderId 'provider-1' -ModelCatalogJson $catalogJson -AccountMatchConfirmed
Assert-Equal $snapshot.providerId 'provider-1' 'Snapshot should associate the selected provider.'
Assert-Equal $snapshot.accountMatchConfirmed $true 'Snapshot should record explicit account-match confirmation.'
Assert-Equal $snapshot.Contains('quotas') $false 'Snapshot must not contain quota fields.'
Assert-Equal $snapshot.models.Count 3 'Snapshot should include the complete model catalog.'
Assert-Equal $snapshot.models[0].capabilities[0] 'TG' 'Snapshot should normalize model detail metadata.'

Assert-Throws {
    New-BailianQianwenPoolSnapshot -ProviderId 'provider-1' -ModelCatalogJson '{"models":[]' -AccountMatchConfirmed
} 'Truncated catalog data must fail the whole snapshot.'

Write-Output 'Bailian Qwen paid-pool parser tests passed.'
