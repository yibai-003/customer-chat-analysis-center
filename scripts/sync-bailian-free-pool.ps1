[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BaseUrl,
    [string]$ProviderId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'bailian-free-pool-sync.psm1') -Force

$script:MaxHttpBodyBytes = 5MB
$script:CliTimeoutMilliseconds = 30000
$script:ConfirmationText = 'APPLY BAILIAN QWEN PAID POOL'
$script:StopAllConfirmationText = 'STOP ALL MANAGED QWEN MODELS'

function Get-ValidatedBaseUri {
    param([string]$Value)
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) { throw 'BaseUrl must be an absolute HTTP(S) URL.' }
    if ($uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'BaseUrl must be HTTP(S) without credentials, query, or fragment.'
    }
    if ($uri.Scheme -eq 'http' -and $uri.Host -notin @('localhost', '127.0.0.1', '::1', '[::1]')) {
        throw 'Plain HTTP is allowed only for loopback addresses.'
    }
    if ($uri.AbsolutePath -ne '/') { throw 'BaseUrl must identify the application origin without a path.' }
    return $uri
}

function Get-ApiUri {
    param([Uri]$Base, [string]$Path)
    return [Uri]::new($Base, $Path)
}

function ConvertFrom-ApiResponse {
    param([string]$Content, [string]$Operation)
    if ([string]::IsNullOrWhiteSpace($Content) -or $Content.Length -gt $script:MaxHttpBodyBytes) {
        throw "$Operation returned an empty response or exceeded the 5 MiB response limit."
    }
    try { $envelope = ConvertFrom-Json -InputObject $Content -AsHashtable -Depth 40 -ErrorAction Stop }
    catch { throw "$Operation returned invalid JSON." }
    if ($envelope -isnot [System.Collections.IDictionary] -or $envelope['success'] -ne $true) {
        $serverMessage = if ($envelope -is [System.Collections.IDictionary] -and $envelope['error'] -is [string]) {
            $safeMessage = ($envelope['error'] -replace '[\x00-\x1F\x7F]', ' ').Trim()
            if ($safeMessage.Length -gt 500) { $safeMessage.Substring(0, 500) } else { $safeMessage }
        } else { 'Request failed.' }
        if ([string]::IsNullOrWhiteSpace($serverMessage)) { $serverMessage = 'Request failed.' }
        throw "$Operation failed: $serverMessage"
    }
    return $envelope
}

function Read-BoundedHttpContent {
    param([System.Net.Http.HttpContent]$Content, [System.Threading.CancellationToken]$CancellationToken)
    $stream = $null
    $memory = [System.IO.MemoryStream]::new()
    try {
        $stream = $Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $buffer = New-Object byte[] 81920
        while (($read = $stream.ReadAsync($buffer, 0, $buffer.Length, $CancellationToken).GetAwaiter().GetResult()) -gt 0) {
            if ($memory.Length + $read -gt $script:MaxHttpBodyBytes) { throw 'HTTP response exceeded the 5 MiB limit.' }
            $memory.Write($buffer, 0, $read)
        }
        return [Text.Encoding]::UTF8.GetString($memory.ToArray())
    } finally {
        if ($stream) { $stream.Dispose() }
        $memory.Dispose()
    }
}

function Get-SafeServerError {
    param([string]$Content)
    if ([string]::IsNullOrWhiteSpace($Content)) { return 'Request failed.' }
    try {
        $envelope = ConvertFrom-Json -InputObject $Content -AsHashtable -Depth 20 -ErrorAction Stop
        if ($envelope -is [System.Collections.IDictionary] -and $envelope['error'] -is [string]) {
            $message = ($envelope['error'] -replace '[\x00-\x1F\x7F]', ' ').Trim()
            if ($message.Length -gt 500) { return $message.Substring(0, 500) }
            if ($message) { return $message }
        }
    } catch { }
    return 'Request failed.'
}

function New-BailianHttpClient {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $true
    $handler.CookieContainer = [System.Net.CookieContainer]::new()
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    return [pscustomobject]@{ Client = $client; Handler = $handler }
}

if (-not ('BailianBoundedProcessReader' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;

public sealed class BailianBoundedReadResult
{
    public string Text { get; set; }
    public bool Exceeded { get; set; }
}

public static class BailianBoundedProcessReader
{
    public static Task<BailianBoundedReadResult> DrainAsync(StreamReader reader, int characterLimit)
    {
        return Task.Run(async () =>
        {
            var text = new StringBuilder(Math.Min(characterLimit, 65536));
            var buffer = new char[8192];
            var exceeded = false;
            int read;
            while ((read = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
            {
                var room = characterLimit - text.Length;
                if (room > 0) text.Append(buffer, 0, Math.Min(room, read));
                if (read > room) exceeded = true;
            }
            return new BailianBoundedReadResult { Text = text.ToString(), Exceeded = exceeded };
        });
    }
}
'@ -ErrorAction Stop
}

function Invoke-JsonRequest {
    param(
        [ValidateSet('GET', 'POST')][string]$Method,
        [Uri]$Uri,
        [System.Net.Http.HttpClient]$Client,
        [object]$Body
    )
    $httpMethod = if ($Method -eq 'GET') { [System.Net.Http.HttpMethod]::Get } else { [System.Net.Http.HttpMethod]::Post }
    $request = [System.Net.Http.HttpRequestMessage]::new($httpMethod, $Uri)
    if ($Method -eq 'POST') {
        $json = ConvertTo-Json -InputObject $Body -Depth 40 -Compress
        $request.Content = [System.Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
    }
    $response = $null
    $cancellation = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(30))
    try {
        $response = $Client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancellation.Token).GetAwaiter().GetResult()
        $content = Read-BoundedHttpContent -Content $response.Content -CancellationToken $cancellation.Token
        if (-not $response.IsSuccessStatusCode) {
            $status = [int]$response.StatusCode
            throw "$Method $($Uri.AbsolutePath) failed (HTTP $status): $(Get-SafeServerError -Content $content)"
        }
        return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Content = $content }
    } catch {
        if ($_.Exception.Message -match 'HTTP response exceeded|failed \(HTTP \d+\):') { throw $_.Exception.Message }
        throw "$Method $($Uri.AbsolutePath) failed: network error."
    } finally {
        if ($response) { $response.Dispose() }
        $request.Dispose()
        $cancellation.Dispose()
    }
}

function Get-ApiData {
    param([string]$Method, [Uri]$Uri, [System.Net.Http.HttpClient]$Client, [object]$Body)
    $response = Invoke-JsonRequest -Method $Method -Uri $Uri -Client $Client -Body $Body
    $envelope = ConvertFrom-ApiResponse -Content $response.Content -Operation $Uri.AbsolutePath
    return $envelope['data']
}

function Resolve-BailianCliLauncher {
    param(
        [Parameter(Mandatory)][object]$Command,
        [AllowEmptyCollection()][string[]]$Arguments = @()
    )

    $source = $null
    foreach ($property in @('Path', 'Source', 'Definition')) {
        $propertyInfo = $Command.PSObject.Properties[$property]
        $candidate = if ($propertyInfo) { $propertyInfo.Value } else { $null }
        if ($candidate -is [string] -and -not [string]::IsNullOrWhiteSpace($candidate)) {
            $source = $candidate
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($source)) { throw 'The Bailian CLI command has no executable path.' }

    $extension = [IO.Path]::GetExtension($source).ToLowerInvariant()
    $launcherArguments = [System.Collections.Generic.List[string]]::new()
    switch ($extension) {
        '.ps1' {
            $shellCandidates = @(
                (Join-Path $PSHOME 'pwsh.exe'),
                (Join-Path $PSHOME 'powershell.exe')
            )
            $shell = $shellCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
            if (-not $shell) { throw 'Unable to locate the PowerShell executable for bl.ps1.' }
            $fileName = [string]$shell
            $launcherArguments.Add('-NoProfile')
            $launcherArguments.Add('-File')
            $launcherArguments.Add($source)
            foreach ($argument in $Arguments) { $launcherArguments.Add([string]$argument) }
        }
        { $_ -in @('.cmd', '.bat') } {
            $fileName = if (-not [string]::IsNullOrWhiteSpace($env:ComSpec)) { $env:ComSpec } else { 'cmd.exe' }
            $launcherArguments.Add('/d')
            $launcherArguments.Add('/s')
            $launcherArguments.Add('/c')
            # Keep the shim path and every CLI value as separate
            # ProcessStartInfo.ArgumentList entries. cmd.exe consumes the
            # remaining entries as the /c command; model IDs are validated
            # before this launcher is reached and are never interpolated into
            # a shell command string.
            $launcherArguments.Add('call')
            $launcherArguments.Add($source)
            foreach ($argument in $Arguments) { $launcherArguments.Add([string]$argument) }
        }
        { $_ -in @('', '.exe') } {
            $fileName = $source
            foreach ($argument in $Arguments) { $launcherArguments.Add([string]$argument) }
        }
        default { throw "Unsupported Bailian CLI launcher type '$extension'." }
    }
    return [pscustomobject]@{ FileName = $fileName; Arguments = @($launcherArguments.ToArray()) }
}

function Invoke-BailianJsonRetry {
    param(
        [Parameter(Mandatory)][scriptblock]$Attempt,
        [Parameter(Mandatory)][string]$Operation,
        [object]$AttemptArguments,
        [scriptblock]$Delay = { param([int]$attemptNumber) Start-Sleep -Seconds $attemptNumber }
    )

    for ($attemptNumber = 1; $attemptNumber -le 3; $attemptNumber++) {
        $output = [string](& $Attempt $AttemptArguments $Operation)
        try {
            $null = ConvertFrom-Json -InputObject $output -AsHashtable -NoEnumerate -Depth 30 -DateKind String -ErrorAction Stop
            return $output
        } catch {
            if ($attemptNumber -eq 3) {
                $trimmed = $output.Trim()
                $first = if ($trimmed.Length) { [int][char]$trimmed[0] } else { -1 }
                $last = if ($trimmed.Length) { [int][char]$trimmed[$trimmed.Length - 1] } else { -1 }
                $hasJsonStart = $trimmed.StartsWith('{') -or $trimmed.StartsWith('[')
                $hasJsonEnd = $trimmed.EndsWith('}') -or $trimmed.EndsWith(']')
                $hasAnsi = $output.Contains([char]27)
                throw "Bailian CLI $Operation returned invalid JSON after 3 attempts (chars=$($output.Length), first=$first, last=$last, jsonStart=$hasJsonStart, jsonEnd=$hasJsonEnd, ansi=$hasAnsi)."
            }
            & $Delay $attemptNumber
        }
    }
    throw "Bailian CLI $Operation returned invalid JSON."
}

function Invoke-BlJsonAttempt {
    param([string[]]$Arguments, [string]$Operation)
    $command = @(Get-Command bl -All -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandType -in @('Application', 'ExternalScript')
    } | Select-Object -First 1)
    if (-not $command) { throw "Unable to run the Bailian CLI for $Operation. Confirm 'bl' is installed and authenticated." }
    $process = $null
    try {
        $launcher = Resolve-BailianCliLauncher -Command $command[0] -Arguments $Arguments
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $launcher.FileName
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        foreach ($argument in $launcher.Arguments) { [void]$startInfo.ArgumentList.Add($argument) }
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'process could not start' }
        $stdoutTask = [BailianBoundedProcessReader]::DrainAsync($process.StandardOutput, $script:MaxHttpBodyBytes)
        $stderrTask = [BailianBoundedProcessReader]::DrainAsync($process.StandardError, $script:MaxHttpBodyBytes)
        if (-not $process.WaitForExit($script:CliTimeoutMilliseconds)) {
            try { $process.Kill($true) } catch { }
            throw "Bailian CLI $Operation timed out after 30 seconds."
        }
        $stdoutResult = $stdoutTask.GetAwaiter().GetResult()
        $stderrResult = $stderrTask.GetAwaiter().GetResult()
        $exitCode = $process.ExitCode
    } catch {
        if ($_.Exception.Message -match 'timed out') { throw $_.Exception.Message }
        throw "Unable to run the Bailian CLI for $Operation. Confirm 'bl' is installed and authenticated."
    } finally {
        if ($process) { $process.Dispose() }
    }
    if ($stdoutResult.Exceeded -or $stderrResult.Exceeded) { throw "Bailian CLI $Operation exceeded the 5 MiB output limit." }
    if ($exitCode -ne 0) { throw "Bailian CLI $Operation failed with exit code $exitCode." }
    $output = [string]$stdoutResult.Text
    if ([string]::IsNullOrWhiteSpace($output) -or $output.Length -gt $script:MaxHttpBodyBytes) {
        throw "Bailian CLI $Operation returned empty output or exceeded the 5 MiB limit."
    }
    return $output
}

function Invoke-BlJson {
    param([string[]]$Arguments, [string]$Operation)
    $attempt = {
        param([string[]]$attemptArguments, [string]$attemptOperation)
        Invoke-BlJsonAttempt -Arguments $attemptArguments -Operation $attemptOperation
    }
    return Invoke-BailianJsonRetry -Attempt $attempt -Operation $Operation -AttemptArguments @($Arguments)
}

function Select-BailianProvider {
    param([object[]]$Providers, [string]$RequestedId)
    if ($RequestedId) {
        $selected = @($Providers | Where-Object { $_.id -ceq $RequestedId -and $_.isEnabled -eq $true })
        if ($selected.Count -ne 1) { throw 'The selected provider ID does not identify one enabled provider.' }
        return $selected[0]
    }
    $enabled = @($Providers | Where-Object {
        $_.isEnabled -eq $true -and (($_.name -match '(?i)bailian|dashscope') -or ($_.baseUrl -match '(?i)bailian|dashscope'))
    })
    if ($enabled.Count -eq 0) { throw 'No enabled model provider is available.' }
    if ($enabled.Count -eq 1) { return $enabled[0] }
    Write-Host 'Select the enabled Bailian provider whose API key belongs to the same account as the host CLI:'
    for ($index = 0; $index -lt $enabled.Count; $index++) {
        $provider = $enabled[$index]
        Write-Host ("[{0}] {1} | {2} | key {3}" -f ($index + 1), $provider.name, $provider.baseUrl, $provider.maskedApiKey)
    }
    $selection = Read-Host 'Provider number'
    $number = 0
    if (-not [int]::TryParse($selection, [ref]$number) -or $number -lt 1 -or $number -gt $enabled.Count) {
        throw 'Provider selection was invalid.'
    }
    return $enabled[$number - 1]
}

function Show-PreviewList {
    param([string]$Title, [object]$Items)
    $values = @($Items)
    Write-Output ("{0}: {1}" -f $Title, $values.Count)
    foreach ($item in $values) {
        if ($item -is [string]) { Write-Output ("  {0}" -f $item) }
        elseif ($item -is [System.Collections.IDictionary]) {
            $id = if ($item['model']) { $item['model'] } elseif ($item['id']) { $item['id'] } else { '[item]' }
            $reason = if ($item['reason']) { " — $($item['reason'])" } else { '' }
            Write-Output ("  {0}{1}" -f $id, $reason)
        } else { Write-Output '  [item]' }
    }
}

function Show-PreviewChanges {
    param([object]$Changes)
    $items = @($Changes)
    Write-Output ("Changes: {0}" -f $items.Count)
    foreach ($change in $items) {
        if ($change -is [System.Collections.IDictionary]) {
            $action = if ($change['action']) { $change['action'] } elseif ($change['type']) { $change['type'] } else { 'change' }
            $model = if ($change['model']) { $change['model'] } elseif ($change['id']) { $change['id'] } else { '[model]' }
            $reason = if ($change['reason']) { " — $($change['reason'])" } else { '' }
            Write-Output ("  {0}: {1}{2}" -f $action, $model, $reason)
        } else {
            Write-Output '  [change]'
        }
    }
}

$baseUri = Get-ValidatedBaseUri -Value $BaseUrl
$httpContext = New-BailianHttpClient
$client = $httpContext.Client
try {
    $catalogJson = Invoke-BlJson -Arguments @('model', 'list', '--output', 'json', '--quiet') -Operation 'model catalog query'
    $catalogModels = @(ConvertFrom-BailianModelCatalogJson -Json $catalogJson)

    $credential = Get-Credential -Message 'Sign in to the Customer Chat Analysis Center. The password is held only in this process.'
    if ($null -eq $credential) { throw 'Project login was cancelled.' }
    $password = $credential.GetNetworkCredential().Password
    $sessionResponse = Invoke-JsonRequest -Method 'POST' -Uri (Get-ApiUri $baseUri '/api/auth/login') -Client $client -Body @{ username = $credential.UserName; password = $password }
    $null = ConvertFrom-ApiResponse -Content $sessionResponse.Content -Operation '/api/auth/login'
    $password = $null
    $credential = $null

    $providers = @(Get-ApiData -Method 'GET' -Uri (Get-ApiUri $baseUri '/api/model-providers') -Client $client)
    $provider = Select-BailianProvider -Providers $providers -RequestedId $ProviderId
    Write-Output ("Selected provider: {0} | {1} | key {2}" -f $provider.name, $provider.baseUrl, $provider.maskedApiKey)
    Write-Output 'Confirm that the account authenticated by the host Bailian CLI is the same account as the selected provider API key.'
    $accountConfirmation = Read-Host 'Type SAME BAILIAN ACCOUNT to confirm'
    if ($accountConfirmation -cne 'SAME BAILIAN ACCOUNT') { throw 'Account match was not confirmed; no snapshot was submitted.' }
    $snapshot = New-BailianQianwenPoolSnapshot -ProviderId ([string]$provider.id) -ModelCatalogJson $catalogJson -AccountMatchConfirmed

    $preview = Get-ApiData -Method 'POST' -Uri (Get-ApiUri $baseUri '/api/model-pools/bailian-qwen-paid/preview') -Client $client -Body $snapshot
    Write-Output 'Bailian Qwen paid-pool preview:'
    $summary = $preview.summary
    Write-Output ("Created: {0}; updated: {1}; disabled: {2}; preserved manual: {3}; excluded: {4}" -f $summary.created, $summary.updated, $summary.disabled, $summary.preservedManual, $summary.excluded)
    Show-PreviewChanges -Changes $preview.changes
    Show-PreviewList -Title 'Excluded' -Items $preview.excluded
    if ($preview.expiresAt) { Write-Output ("Preview expires at: {0}" -f $preview.expiresAt) }
    $confirmation = Read-Host "Type '$script:ConfirmationText' to apply this preview"
    if ($confirmation -cne $script:ConfirmationText) { throw 'Preview was not confirmed; no changes were applied.' }
    $applyConfirmation = $script:ConfirmationText
    if ($preview.requiresDisableAllConfirmation -eq $true) {
        $stopConfirmation = Read-Host "Type '$script:StopAllConfirmationText' to disable all managed Qwen models"
        if ($stopConfirmation -cne $script:StopAllConfirmationText) { throw 'Zero-candidate stop was not confirmed; no changes were applied.' }
        $applyConfirmation = $script:StopAllConfirmationText
    }
    $applyBody = @{ previewId = [string]$preview.previewId; confirmation = $applyConfirmation }
    $result = Get-ApiData -Method 'POST' -Uri (Get-ApiUri $baseUri '/api/model-pools/bailian-qwen-paid/apply') -Client $client -Body $applyBody
    Write-Output 'Applied Bailian Qwen paid-pool sync.'
} finally {
    try { $null = Invoke-JsonRequest -Method 'POST' -Uri (Get-ApiUri $baseUri '/api/auth/logout') -Client $client -Body @{} } catch { }
    $password = $null
    $credential = $null
    if ($client) { $client.Dispose() }
    if ($httpContext.Handler) { $httpContext.Handler.Dispose() }
    $client = $null
}
