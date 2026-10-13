Set-StrictMode -Version Latest

$script:ModelIdPattern = '^[A-Za-z0-9._:/-]{1,200}$'
$script:MaxRecords = 500

function ConvertFrom-BailianModelCatalogJson {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Json)

    if ([string]::IsNullOrWhiteSpace($Json) -or $Json.Length -gt 5MB) {
        throw 'Bailian model catalog output is empty or exceeds the 5 MiB limit.'
    }
    try { $envelope = ConvertFrom-Json -InputObject $Json -AsHashtable -Depth 40 -NoEnumerate -DateKind String -ErrorAction Stop }
    catch { throw 'Bailian model catalog output is not valid JSON.' }
    if ($envelope -isnot [System.Collections.IDictionary]) { throw 'Bailian model catalog output must be an object.' }
    $rows = $envelope['models']
    if ($rows -isnot [System.Collections.IList] -or $rows -is [string]) { throw 'Bailian model catalog must contain a models array.' }
    if ($rows.Count -gt $script:MaxRecords) { throw 'Bailian model catalog exceeds 500 records.' }

    $models = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($row in $rows) {
        if ($row -isnot [System.Collections.IDictionary]) { throw 'Bailian catalog entry must be an object.' }
        $model = $row['model']
        if ($model -isnot [string] -or $model -notmatch $script:ModelIdPattern) { throw 'Bailian catalog entry has an invalid model ID.' }
        if (-not $seen.Add($model)) { throw 'Bailian model catalog contains duplicate model IDs.' }
        foreach ($field in @('name', 'provider')) {
            if ($row[$field] -isnot [string] -or [string]::IsNullOrWhiteSpace($row[$field])) { throw "Bailian catalog entry has no valid $field." }
        }
        foreach ($field in @('capabilities', 'features')) {
            if ($row[$field] -isnot [System.Collections.IList] -or $row[$field] -is [string]) { throw "Bailian catalog $field must be an array." }
            foreach ($item in $row[$field]) { if ($item -isnot [string] -or [string]::IsNullOrWhiteSpace($item)) { throw "Bailian catalog $field contains an invalid value." } }
        }
        $modalities = $row['modalities']
        if ($modalities -isnot [System.Collections.IDictionary]) { throw 'Bailian catalog modalities must be an object.' }
        foreach ($direction in @('input', 'output')) {
            if ($modalities[$direction] -isnot [System.Collections.IList] -or $modalities[$direction] -is [string]) { throw "Bailian catalog modalities.$direction must be an array." }
            foreach ($item in $modalities[$direction]) { if ($item -isnot [string] -or [string]::IsNullOrWhiteSpace($item)) { throw 'Bailian catalog modality is invalid.' } }
        }
        if ($null -ne $row['offline'] -and $row['offline'] -isnot [bool]) { throw 'Bailian catalog offline value must be boolean.' }
        $upcoming = $row['upcomingOfflineAt']
        if ($null -ne $upcoming -and $upcoming -isnot [string]) { throw 'Bailian catalog upcomingOfflineAt must be text or null.' }
        $models.Add([ordered]@{
            model = $model
            name = $row['name']
            provider = $row['provider']
            capabilities = @($row['capabilities'])
            modalities = [ordered]@{ input = @($modalities.input); output = @($modalities.output) }
            features = @($row['features'])
            offline = if ($null -eq $row['offline']) { $false } else { [bool]$row['offline'] }
            upcomingOfflineAt = $upcoming
        })
    }
    return @($models.ToArray())
}

function New-BailianQianwenPoolSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProviderId,
        [Parameter(Mandatory)][string]$ModelCatalogJson,
        [Parameter(Mandatory)][switch]$AccountMatchConfirmed
    )
    if ([string]::IsNullOrWhiteSpace($ProviderId) -or $ProviderId.Length -gt 200) { throw 'Provider ID is invalid.' }
    if (-not $AccountMatchConfirmed) { throw 'Explicit Bailian account match confirmation is required.' }
    $models = @(ConvertFrom-BailianModelCatalogJson -Json $ModelCatalogJson)
    return [ordered]@{
        providerId = $ProviderId
        capturedAt = [DateTimeOffset]::UtcNow.ToString('o')
        accountMatchConfirmed = $true
        models = @($models)
    }
}

Export-ModuleMember -Function ConvertFrom-BailianModelCatalogJson, New-BailianQianwenPoolSnapshot
