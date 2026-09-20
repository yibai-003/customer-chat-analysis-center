param(
  [string]$EnvFile = "deploy/.env",
  [string]$ImageRepository = "customer-chat-analysis-center",
  [string]$ContainerName = "customer-chat-analysis",
  [string]$EntryUrl = "http://127.0.0.1:8787",
  [string]$RollbackImage = "",
  [switch]$Preview,
  [switch]$SkipQualityGates
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PolicyPath = Join-Path $ProjectRoot "scripts/lan-deploy-policy.mjs"
$ComposePath = Join-Path $ProjectRoot "deploy/docker-compose.yml"
$ResolvedEnvFile = if ([System.IO.Path]::IsPathRooted($EnvFile)) {
  $EnvFile
} else {
  Join-Path $ProjectRoot $EnvFile
}

function Invoke-Checked([string]$Label, [scriptblock]$Command) {
  Write-Host "== $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label 失败，退出码 $LASTEXITCODE"
  }
}

function Wait-ContainerHealthy([string]$Name, [int]$Attempts = 40) {
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    $state = ((& docker inspect --format "{{.State.Status}}" $Name 2>$null) | Out-String).Trim()
    $health = ((& docker inspect --format "{{.State.Health.Status}}" $Name 2>$null) | Out-String).Trim()
    if ($state -eq "running" -and $health -eq "healthy") {
      return $true
    }
    if ($state -and $state -ne "running") {
      return $false
    }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Get-ContainerImage([string]$Name) {
  $image = ((& docker inspect --format "{{.Config.Image}}" $Name 2>$null) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    return ""
  }
  return $image
}

function Get-ImageRuntimeMetadata([string]$Image) {
  $raw = ((& docker image inspect --format "{{json .Config.Env}}" $Image 2>$null) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $raw) {
    return @{}
  }
  $metadata = @{}
  foreach ($item in ($raw | ConvertFrom-Json)) {
    $parts = $item -split "=", 2
    if ($parts.Count -eq 2 -and $parts[0] -in @("APP_VERSION", "APP_COMMIT_SHA", "APP_BUILD_TIME", "APP_IMAGE")) {
      $metadata[$parts[0]] = $parts[1]
    }
  }
  return $metadata
}

function Get-RuntimeVersion([string]$BaseUrl) {
  $response = Invoke-RestMethod -Method Get -Uri "$($BaseUrl.TrimEnd('/'))/api/version"
  if (-not $response.success -or -not $response.data) {
    throw "运行版本接口响应无效"
  }
  return $response.data
}

function Get-EntryAssets([string]$BaseUrl) {
  $html = (Invoke-WebRequest -UseBasicParsing -Uri "$($BaseUrl.TrimEnd('/'))/").Content
  $scripts = @(
    [regex]::Matches($html, '<script[^>]+src=["'']/?([^"'']+\.js)["'']', "IgnoreCase") |
      ForEach-Object { $_.Groups[1].Value }
  )
  $styles = @(
    [regex]::Matches($html, '<link[^>]+href=["'']/?([^"'']+\.css)["'']', "IgnoreCase") |
      ForEach-Object { $_.Groups[1].Value }
  )
  return @{
    scripts = @($scripts | Select-Object -Unique)
    styles = @($styles | Select-Object -Unique)
  }
}

function Invoke-ComposeImage([string]$Image) {
  $env:APP_IMAGE = $Image
  & docker compose --env-file $ResolvedEnvFile -f $ComposePath up -d --no-build app
  if ($LASTEXITCODE -ne 0) {
    throw "Compose 启动镜像失败：$Image"
  }
}

function Restore-PreviousImage([string]$Image) {
  if (-not $Image) {
    throw "没有可用于回滚的旧容器镜像"
  }
  Write-Host "== 回滚到 $Image"
  $metadata = Get-ImageRuntimeMetadata $Image
  $env:APP_IMAGE = $Image
  foreach ($name in @("APP_VERSION", "APP_COMMIT_SHA", "APP_BUILD_TIME")) {
    if ($metadata.ContainsKey($name)) {
      Set-Item -Path "Env:$name" -Value $metadata[$name]
    } else {
      Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    }
  }
  $env:APP_CONTAINER_NAME = $ContainerName
  Invoke-ComposeImage $Image
}

function Invoke-DeploymentVerification(
  [string]$TargetImage,
  [string]$TargetCommitSha
) {
  if (-not (Wait-ContainerHealthy $ContainerName)) {
    throw "容器健康检查失败"
  }

  Write-Host "== 容器内 ready:check"
  & docker exec $ContainerName npm run ready:check
  $actualReadinessExitCode = $LASTEXITCODE

  $runtime = Get-RuntimeVersion $EntryUrl
  $entryAssets = Get-EntryAssets $EntryUrl
  $verification = @{
    targetCommitSha = $TargetCommitSha
    targetImage = $TargetImage
    healthy = $true
    readinessExitCode = $actualReadinessExitCode
    runtime = $runtime
    entryAssets = $entryAssets
  } | ConvertTo-Json -Depth 10 -Compress

  Write-Host "== 策略核验"
  $policyOutput = $verification | & node $PolicyPath verify
  if ($LASTEXITCODE -ne 0) {
    throw "部署策略核验失败：$($policyOutput -join ' ')"
  }
  Write-Host ($policyOutput -join "`n")
  return $runtime
}

Push-Location $ProjectRoot
try {
  if (-not (Test-Path $ResolvedEnvFile)) {
    throw "找不到 Compose 环境文件：$ResolvedEnvFile"
  }

  $commit = ((& git rev-parse HEAD) | Out-String).Trim()
  if (-not $commit -or $LASTEXITCODE -ne 0) {
    throw "无法读取当前 Git 提交"
  }
  $status = (& git status --porcelain | Out-String).Trim()
  if (-not $Preview -and -not $RollbackImage -and $status) {
    throw "正式部署要求干净工作区"
  }

  $previousImage = Get-ContainerImage $ContainerName
  $previousVersion = if ($previousImage) { Get-RuntimeVersion $EntryUrl } else { $null }
  $targetCommit = $commit
  $targetVersion = ""
  $targetImage = $RollbackImage

  if ($RollbackImage) {
    Write-Host "== 显式回滚：$RollbackImage"
    $metadata = Get-ImageRuntimeMetadata $RollbackImage
    if ($metadata.ContainsKey("APP_COMMIT_SHA")) {
      $targetCommit = $metadata["APP_COMMIT_SHA"]
    }
    foreach ($name in @("APP_VERSION", "APP_COMMIT_SHA", "APP_BUILD_TIME", "APP_IMAGE")) {
      if ($metadata.ContainsKey($name)) {
        Set-Item -Path "Env:$name" -Value $metadata[$name]
      }
    }
    $env:APP_IMAGE = $RollbackImage
  } else {
    $targetVersion = ((& node -p "require('./package.json').version") | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $targetVersion) {
      throw "无法读取 package.json 版本"
    }
    $imageVersion = if ($Preview) { "$targetVersion-preview" } else { $targetVersion }
    $targetImage = ((& node $PolicyPath image-tag $ImageRepository $imageVersion $commit) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $targetImage) {
      throw "无法生成目标镜像标签"
    }
    $buildTime = [DateTimeOffset]::UtcNow.ToString("o")

    if (-not $SkipQualityGates) {
      Invoke-Checked "安装检查" { & npm run check:installation }
      Invoke-Checked "测试" { & npm test }
      Invoke-Checked "类型检查" { & npm run typecheck }
      Invoke-Checked "Lint" { & npm run lint }
      Invoke-Checked "构建" { & npm run build }
    }

    Invoke-Checked "构建镜像 $targetImage" {
      & docker build `
        --build-arg "APP_VERSION=$targetVersion" `
        --build-arg "APP_COMMIT_SHA=$commit" `
        --build-arg "APP_BUILD_TIME=$buildTime" `
        --build-arg "APP_IMAGE=$targetImage" `
        -t $targetImage .
    }

    $env:APP_VERSION = $targetVersion
    $env:APP_COMMIT_SHA = $commit
    $env:APP_BUILD_TIME = $buildTime
    $env:APP_IMAGE = $targetImage
  }

  $env:APP_CONTAINER_NAME = $ContainerName
  Invoke-ComposeImage $targetImage
  $runtime = Invoke-DeploymentVerification $targetImage $targetCommit
  $imageId = ((& docker inspect --format "{{.Image}}" $ContainerName) | Out-String).Trim()
  Write-Host "PASS: commit=$($runtime.commitSha) image=$($runtime.image) imageId=$imageId"
  if ($previousVersion) {
    Write-Host "previous=$($previousVersion.image); rollback=pwsh -File scripts/lan-deploy.ps1 -RollbackImage $($previousVersion.image)"
  }
} catch {
  $failure = $_.Exception.Message
  Write-Host "FAIL: $failure"
  if ($previousImage) {
    try {
      Restore-PreviousImage $previousImage
      if (-not (Wait-ContainerHealthy $ContainerName)) {
        throw "回滚后容器健康检查失败"
      }
      $restoredImage = Get-ContainerImage $ContainerName
      if ($restoredImage -ne $previousImage) {
        throw "回滚后运行镜像不匹配：$restoredImage"
      }
      $restoredRuntime = Get-RuntimeVersion $EntryUrl
      if ($restoredRuntime.image -ne $previousImage) {
        throw "回滚后版本接口镜像不匹配：$($restoredRuntime.image)"
      }
      Write-Host "ROLLBACK PASS: $restoredImage"
    } catch {
      throw "$failure；自动回滚失败：$($_.Exception.Message)"
    }
  }
  throw
} finally {
  Pop-Location
}
