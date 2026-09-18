param(
  [string]$ContainerName = "customer-chat-analysis",
  [string]$EvidencePath = ".\lan-host-evidence.json",
  [string]$ExpectedImage = "",
  [string]$ExpectedImageId = "",
  [string]$EntryHost = "",
  [string]$EntryAddress = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

function Fail([string]$Message) {
  throw $Message
}

function Invoke-Container([string]$Command, [switch]$AllowFailure) {
  $output = (docker exec $ContainerName sh -c $Command 2>&1) -join "`n"
  if (-not $AllowFailure -and $LASTEXITCODE -ne 0) {
    Fail "容器命令失败：$Command`n$output"
  }
  return [ordered]@{ exitCode = $LASTEXITCODE; output = $output.Trim() }
}

function Wait-ContainerHealthy {
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $state = docker inspect --format "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}" $ContainerName 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $parts = $state -split "\|", 2
    if ($parts[0] -eq "running" -and $parts.Count -eq 2 -and $parts[1] -eq "healthy") {
      return $true
    }
    Start-Sleep -Seconds 3
  }
  return $false
}

docker info --format "{{.ServerVersion}}" | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Docker 不可用" }

$inspectText = (docker inspect $ContainerName 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0) { Fail "找不到正式容器 $ContainerName`n$inspectText" }
$inspect = ($inspectText | ConvertFrom-Json)[0]
if (-not $inspect.State.Running) { Fail "容器 $ContainerName 未运行" }
if (-not $ExpectedImage) { Fail "正式主机证据必须通过 -ExpectedImage 指定已批准镜像标签" }
if (-not $ExpectedImageId) { Fail "正式主机证据必须通过 -ExpectedImageId 指定已批准镜像摘要" }
if ($inspect.Config.Image -ne $ExpectedImage) {
  Fail "容器镜像与批准镜像不一致：期望 $ExpectedImage，实际 $($inspect.Config.Image)"
}
if ($inspect.Image -ne $ExpectedImageId) {
  Fail "运行中容器镜像摘要与批准摘要不一致：期望 $ExpectedImageId，实际 $($inspect.Image)"
}
if (-not $EntryHost -or -not $EntryAddress) {
  Fail "正式主机证据必须通过 -EntryHost 和 -EntryAddress 绑定内网入口"
}
$parsedEntryAddress = $null
if (-not [Net.IPAddress]::TryParse($EntryAddress, [ref]$parsedEntryAddress)) {
  Fail "EntryAddress 不是有效 IP 地址：$EntryAddress"
}
if ($inspect.HostConfig.RestartPolicy.Name -notin @("always", "unless-stopped")) {
  Fail "正式容器必须配置 restart: always 或 unless-stopped，实际为 $($inspect.HostConfig.RestartPolicy.Name)"
}

$requiredMounts = @("/app/data", "/app/knowledge")
$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\", "/")
$mounts = @($inspect.Mounts | ForEach-Object {
  [ordered]@{
    type = $_.Type
    source = $_.Source
    destination = $_.Destination
    readOnly = -not $_.RW
  }
})
foreach ($destination in $requiredMounts) {
  $mount = $mounts | Where-Object { $_.destination -eq $destination } | Select-Object -First 1
  if (-not $mount -or $mount.readOnly) { Fail "正式容器缺少可写持久挂载：$destination" }
  if ($mount.type -ne "bind") {
    Fail "正式持久挂载必须使用可核验宿主机路径（bind）：$destination"
  }
  $source = [IO.Path]::GetFullPath([string]$mount.source).TrimEnd("\", "/")
  if ($source.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "正式持久目录不能位于临时目录：$source"
  }
  if ($source.StartsWith("\\")) { Fail "正式持久目录不能使用网络共享：$source" }
}
if (-not (Wait-ContainerHealthy)) { Fail "正式容器未达到 Docker healthy 状态" }
$healthCommand = 'node -e ''fetch("http://127.0.0.1:8787/api/health").then(async response => { if (!response.ok) process.exit(1); const body = await response.json(); if (body?.data?.status !== "ok") process.exit(1); }).catch(() => process.exit(1))'''
Invoke-Container $healthCommand | Out-Null

$runId = [guid]::NewGuid().ToString("N")
$restorePath = "/tmp/lan-host-restore-$runId"
$backup = $null
$restore = $null
$verify = $null

try {
  Write-Host "== 创建正式数据备份"
  $backupCommand = Invoke-Container "npm run --silent backup"
  $backup = $backupCommand.output | ConvertFrom-Json
  if (-not $backup.verified -or -not $backup.directory) { Fail "备份结果无效：$($backupCommand.output)" }

  Write-Host "== 恢复到独立目录并校验"
  Invoke-Container "npm run --silent restore -- '$($backup.directory)' --to '$restorePath'" | Out-Null
  $restore = [ordered]@{ directory = $restorePath; completed = $true }
  Invoke-Container "mkdir -p '$restorePath/data/.secrets' && cp /app/data/.secrets/app.db.key.json '$restorePath/data/.secrets/'" | Out-Null
  $verifyCommand = Invoke-Container "npm run --silent restore:verify -- '$restorePath'"
  $verify = $verifyCommand.output | ConvertFrom-Json
  if (-not $verify.ok) { Fail "恢复校验未通过：$($verifyCommand.output)" }

  Write-Host "== 重启正式容器并检查持久化"
  docker restart $ContainerName | Out-Null
  if (-not (Wait-ContainerHealthy)) { Fail "正式容器重启后未恢复健康" }
  $databaseCheck = Invoke-Container "npm run --silent db:check"
  $persistedFiles = Invoke-Container "test -f /app/data/app.db && test -f /app/data/.secrets/app.db.key.json && test -d /app/knowledge"

  Write-Host "== 验证单实例保护"
  $secondInstance = Invoke-Container "node --import tsx src/server/launcher.ts" -AllowFailure
  if ($secondInstance.exitCode -eq 0) { Fail "第二个应用实例被错误地允许启动" }
  if ($secondInstance.output -notmatch "已有服务|占用") {
    Fail "单实例拒绝信息不明确：$($secondInstance.output)"
  }

  $imageId = ([string]$inspect.Image).Trim()
  $evidence = [ordered]@{
    schemaVersion = 2
    mode = "host-signoff"
    productionReady = $true
    collectedAt = (Get-Date).ToString("o")
    host = [ordered]@{
      computer = $env:COMPUTERNAME
      os = [System.Environment]::OSVersion.VersionString
      cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)
      memoryGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
      docker = (docker version --format "{{.Server.Version}}")
    }
    entry = [ordered]@{
      host = $EntryHost
      address = $EntryAddress
    }
    container = [ordered]@{
      name = $ContainerName
      image = $inspect.Config.Image
      imageId = ([string]$imageId).Trim()
      restartPolicy = $inspect.HostConfig.RestartPolicy.Name
      mounts = $mounts
    }
    backup = [ordered]@{
      directoryName = Split-Path -Leaf $backup.directory
      files = $backup.files
      references = $backup.references
      verified = [bool]$backup.verified
    }
    restore = [ordered]@{
      verified = [bool]$verify.ok
      checks = $verify.checks
    }
    persistence = [ordered]@{
      databaseCheck = $databaseCheck.output
      managedKey = ($persistedFiles.exitCode -eq 0)
      mountsVerified = $true
      restartVerified = $true
    }
    singleInstance = [ordered]@{
      rejected = $true
    }
  }
  $resolvedEvidence = [IO.Path]::GetFullPath($EvidencePath)
  [IO.File]::WriteAllText($resolvedEvidence, ($evidence | ConvertTo-Json -Depth 10))
  Write-Host "HOST EVIDENCE OK"
  Write-Host "证据文件：$resolvedEvidence"
} finally {
  if ($restorePath -like "/tmp/lan-host-restore-*") {
    Invoke-Container "rm -rf -- '$restorePath'" -AllowFailure | Out-Null
  }
}
