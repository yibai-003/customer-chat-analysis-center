Set-StrictMode -Version Latest

$script:SupportedQuotaTypes = @('Text', 'Vision', 'Multimodal')
$script:ModelIdPattern = '^[A-Za-z0-9._:/-]{1,200}$'
$script:MaxRecords = 500
$script:MaxSafeInteger = [decimal]9007199254740991

function Test-BailianExpiry {
    param([string]$Value)
    if ($Value -match '^\d{4}-\d{2}-\d{2}$') {
        $parsedDate = [DateTime]::MinValue
        return [DateTime]::TryParseExact($Value, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsedDate)
    }
    if ($Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$') { return $false }
    $parsedTimestamp = [DateTimeOffset]::MinValue
    return [DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsedTimestamp)
}

function ConvertFrom-BailianQuotaJson {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Json)

    if ([string]::IsNullOrWhiteSpace($Json) -or $Json.Length -gt 5MB) {
        throw 'Bailian quota output is empty or exceeds the 5 MiB limit.'
    }
    if ($Json.Trim() -ceq '[]') { return @() }
    try { $rows = ConvertFrom-Json -InputObject $Json -AsHashtable -Depth 30 -NoEnumerate -DateKind String -ErrorAction Stop }
    catch { throw 'Bailian quota output is not valid JSON.' }
    if ($rows -isnot [System.Collections.IList] -or $rows -is [string]) {
        throw 'Bailian quota output must be a JSON array.'
    }
    if ($rows.Count -gt $script:MaxRecords) { throw 'Bailian quota output exceeds 500 records.' }

    $result = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($row in $rows) {
        if ($row -isnot [System.Collections.IDictionary]) { throw 'Bailian quota record must be an object.' }
        $model = $row['model']
        $type = $row['type']
        $remaining = $row['remaining']
        $total = $row['total']
        $expires = $row['expires']
        $autoStop = $row['autoStop']
        if ($model -isnot [string] -or $model -notmatch $script:ModelIdPattern) {
            throw 'Bailian quota record has an invalid model ID.'
        }
        if (-not $seen.Add($model)) { throw 'Bailian quota output contains duplicate model IDs.' }
        if ($type -isnot [string] -or [string]::IsNullOrWhiteSpace($type)) {
            throw 'Bailian quota record has no model type.'
        }
        if ($remaining -isnot [long] -and $remaining -isnot [int] -and $remaining -isnot [double] -and $remaining -isnot [decimal]) {
            throw 'Bailian quota remaining value is invalid.'
        }
        if ($total -isnot [long] -and $total -isnot [int] -and $total -isnot [double] -and $total -isnot [decimal]) {
            throw 'Bailian quota total value is invalid.'
        }
        try {
            $remainingDecimal = [decimal]$remaining
            $totalDecimal = [decimal]$total
        } catch {
            throw 'Bailian quota range must contain non-negative safe integers.'
        }
        if ($remainingDecimal -lt 0 -or $totalDecimal -lt 0 -or $remainingDecimal -gt $script:MaxSafeInteger -or $totalDecimal -gt $script:MaxSafeInteger -or [decimal]::Truncate($remainingDecimal) -ne $remainingDecimal -or [decimal]::Truncate($totalDecimal) -ne $totalDecimal) {
            throw 'Bailian quota range must contain non-negative safe integers.'
        }
        if ($expires -isnot [string] -or [string]::IsNullOrWhiteSpace($expires)) {
            throw 'Bailian quota record has no expiry value.'
        }
        if (-not (Test-BailianExpiry -Value $expires)) { throw 'Bailian quota expiry value is invalid.' }
        if ($autoStop -isnot [bool]) { throw 'Bailian quota autoStop value must be boolean.' }
        if ($script:SupportedQuotaTypes -ccontains $type) {
            $result.Add([ordered]@{
                model = $model
                type = $type
                remaining = [long]$remaining
                total = [long]$total
                expires = $expires
                autoStop = [bool]$autoStop
            })
        }
    }
    return $result.ToArray()
}

function ConvertFrom-BailianModelDetailJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Json,
        [Parameter(Mandatory)][string]$ExpectedModel
    )

    if ($ExpectedModel -notmatch $script:ModelIdPattern) { throw 'Expected model ID is invalid.' }
    if ([string]::IsNullOrWhiteSpace($Json) -or $Json.Length -gt 5MB) {
        throw 'Bailian model detail output is empty or exceeds the 5 MiB limit.'
    }
    try { $envelope = ConvertFrom-Json -InputObject $Json -AsHashtable -Depth 30 -NoEnumerate -DateKind String -ErrorAction Stop }
    catch { throw 'Bailian model detail output is not valid JSON.' }
    if ($envelope -isnot [System.Collections.IDictionary]) { throw 'Bailian model detail output must be an object.' }
    if ($envelope['model'] -cne $ExpectedModel) { throw 'Bailian model detail envelope does not match the requested model.' }
    $items = $envelope['items']
    if ($items -isnot [System.Collections.IList] -or $items -is [string]) { throw 'Bailian model detail items must be an array.' }
    if ($items.Count -gt $script:MaxRecords) { throw 'Bailian model detail output exceeds 500 records.' }
    $matches = @($items | Where-Object { $_ -is [System.Collections.IDictionary] -and $_['model'] -ceq $ExpectedModel })
    if ($matches.Count -ne 1) { throw 'Bailian model detail must contain exactly one requested model version.' }

    $item = $matches[0]
    if ($item['name'] -isnot [string] -or [string]::IsNullOrWhiteSpace($item['name'])) { throw 'Bailian model detail item has no exact display name.' }
    if ($item['provider'] -isnot [string] -or [string]::IsNullOrWhiteSpace($item['provider'])) { throw 'Bailian model detail provider is invalid.' }
    $capabilities = @()
    if ($item['capabilities'] -isnot [System.Collections.IList] -or $item['capabilities'] -is [string]) { throw 'Bailian model capabilities must be an array.' }
    $capabilities = @($item['capabilities'] | ForEach-Object { if ($_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_)) { throw 'Bailian model capability must be non-empty text.' }; $_ })
    if ($capabilities.Count -eq 0) { throw 'Bailian model capabilities must not be empty.' }
    $features = @()
    if ($item['features'] -isnot [System.Collections.IList] -or $item['features'] -is [string]) { throw 'Bailian model features must be an array.' }
    $features = @($item['features'] | ForEach-Object { if ($_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_)) { throw 'Bailian model feature must be non-empty text.' }; $_ })
    if ($features.Count -eq 0 -or -not ($features -ccontains 'structured-outputs')) { throw 'Bailian model detail is missing structured-outputs support.' }
    $modalities = $item['modalities']
    if ($modalities -isnot [System.Collections.IDictionary]) { throw 'Bailian model modalities must be an object.' }
    foreach ($direction in @('input', 'output')) {
        if ($modalities[$direction] -isnot [System.Collections.IList] -or $modalities[$direction] -is [string]) {
            throw "Bailian model modalities.$direction must be an array."
        }
        foreach ($modality in $modalities[$direction]) {
            if ($modality -isnot [string] -or [string]::IsNullOrWhiteSpace($modality)) { throw 'Bailian model modality must be non-empty text.' }
        }
        if (@($modalities[$direction]).Count -eq 0) { throw "Bailian model modalities.$direction must not be empty." }
    }
    if ($item['offline'] -isnot [bool]) { throw 'Bailian model offline value must be boolean.' }
    $upcoming = $item['upcomingOfflineAt']
    if ($null -ne $upcoming -and $upcoming -isnot [string]) { throw 'Bailian model upcomingOfflineAt value must be text or null.' }

    return [ordered]@{
        model = $ExpectedModel
        name = $item['name']
        provider = $item['provider']
        capabilities = $capabilities
        modalities = [ordered]@{ input = @($modalities['input']); output = @($modalities['output']) }
        features = $features
        offline = [bool]$item['offline']
        upcomingOfflineAt = $upcoming
    }
}

function New-BailianFreePoolSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProviderId,
        [Parameter(Mandatory)][string]$QuotaJson,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$ModelDetails,
        [Parameter(Mandatory)][switch]$AccountMatchConfirmed
    )

    if ([string]::IsNullOrWhiteSpace($ProviderId) -or $ProviderId.Length -gt 200) { throw 'Provider ID is invalid.' }
    if (-not $AccountMatchConfirmed) { throw 'Explicit Bailian account match confirmation is required.' }
    $quotas = @(ConvertFrom-BailianQuotaJson -Json $QuotaJson)
    if ($ModelDetails.Count -gt $script:MaxRecords) { throw 'Bailian model detail output exceeds 500 records.' }
    if ($quotas.Count -gt $script:MaxRecords) { throw 'Bailian quota output exceeds 500 supported records.' }
    if ($quotas.Count -ne $ModelDetails.Count) { throw 'Bailian model details must cover every supported quota model exactly once.' }

    $models = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($json in $ModelDetails) {
        if ([string]::IsNullOrWhiteSpace($json)) { throw 'Bailian model detail output is empty.' }
        try { $outer = ConvertFrom-Json -InputObject $json -AsHashtable -Depth 30 -NoEnumerate -DateKind String -ErrorAction Stop }
        catch { throw 'Bailian model detail output is not valid JSON.' }
        $modelId = $outer['model']
        if ($modelId -isnot [string] -or -not $seen.Add($modelId)) { throw 'Bailian model detail output contains a duplicate or invalid model ID.' }
        $models.Add((ConvertFrom-BailianModelDetailJson -Json $json -ExpectedModel $modelId))
    }
    foreach ($quota in $quotas) {
        if (-not $seen.Contains([string]$quota.model)) { throw 'Bailian model detail output is incomplete for supported quota models.' }
    }
    return [ordered]@{
        providerId = $ProviderId
        capturedAt = [DateTimeOffset]::UtcNow.ToString('o')
        accountMatchConfirmed = $true
        quotas = @($quotas)
        models = @($models.ToArray())
    }
}

Export-ModuleMember -Function ConvertFrom-BailianQuotaJson, ConvertFrom-BailianModelDetailJson, New-BailianFreePoolSnapshot
