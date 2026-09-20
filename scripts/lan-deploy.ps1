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

function Get-ContainerImageId([string]$Name) {
  $imageId = ((& docker inspect --format "{{.Image}}" $Name 2>$null) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    return ""
  }
  return $imageId
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

function Normalize-HostPath([string]$Value) {
  if (-not $Value) {
    throw "Compose 持久化目录不能为空"
  }
  if ($Value.StartsWith("\") -or $Value.StartsWith("//")) {
    throw "持久化目录不能使用网络共享盘：$Value"
  }
  try {
    return [System.IO.Path]::GetFullPath($Value).TrimEnd([char[]]@("\", "/"))
  } catch {
    throw "无法解析持久化目录：$Value"
  }
}

function Get-ComposeMounts {
  $raw = ((& docker compose --env-file $ResolvedEnvFile -f $ComposePath config --format json 2>$null) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $raw) {
    throw "无法读取 Compose 渲染后的挂载配置"
  }
  $config = $raw | ConvertFrom-Json
  if (-not $config.services.app.volumes) {
    throw "Compose app 服务未声明持久化挂载"
  }
  return @($config.services.app.volumes)
}

function Assert-ExpectedMounts([string]$Name) {
  $expectedMounts = Get-ComposeMounts
  $actualRaw = ((& docker inspect --format "{{json .Mounts}}" $Name 2>$null) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $actualRaw) {
    throw "无法读取容器实际挂载"
  }
  $actualMounts = @($actualRaw | ConvertFrom-Json)

  foreach ($target in @("/app/data", "/app/knowledge")) {
    $expected = @($expectedMounts | Where-Object { $_.target -eq $target }) | Select-Object -First 1
    $actual = @($actualMounts | Where-Object { $_.Destination -eq $target }) | Select-Object -First 1
    if (-not $expected -or -not $actual) {
      throw "容器缺少持久化挂载：$target"
    }
    if ([string]$expected.type -ne "bind" -or [string]$actual.Type -ne "bind") {
      throw "持久化挂载必须是 bind 类型：$target"
    }

    $expectedSource = Normalize-HostPath ([string]$expected.source)
    $actualSource = Normalize-HostPath ([string]$actual.Source)
    if ($expectedSource -ne $actualSource) {
      throw "容器挂载来源与 Compose 配置不一致：$target"
    }
  }
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
  $assetJson = ($html | & node $PolicyPath assets | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $assetJson) {
    throw "无法解析入口资源"
  }
  $assets = $assetJson | ConvertFrom-Json
  return @{
    scripts = @($assets.scripts)
    styles = @($assets.styles)
  }
}

function Invoke-ComposeImage([string]$Image) {
  $env:APP_IMAGE = $Image
  & docker compose --env-file $ResolvedEnvFile -f $ComposePath up -d --no-build app
  if ($LASTEXITCODE -ne 0) {
    throw "Compose 启动镜像失败：$Image"
  }
}

function Restore-PreviousImage([string]$Image, [string]$ImageId) {
  if (-not $Image) {
    throw "没有可用于回滚的旧容器镜像"
  }
  Write-Host "== 回滚到 $Image"
  if ($ImageId) {
    & docker tag $ImageId $Image
    if ($LASTEXITCODE -ne 0) {
      throw "无法将旧镜像 ID 重新绑定到镜像标签：$Image"
    }
  }
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
  Assert-ExpectedMounts $ContainerName

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
  return @{
    Runtime = $runtime
    EntryAssets = $entryAssets
  }
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
  $previousImageId = if ($previousImage) { Get-ContainerImageId $ContainerName } else { "" }
  if ($previousImage -and -not $previousImageId) {
    throw "无法读取当前容器镜像 ID，拒绝开始部署"
  }
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
  $verification = Invoke-DeploymentVerification $targetImage $targetCommit
  $runtime = $verification.Runtime
  $imageId = Get-ContainerImageId $ContainerName
  $assetsJson = $verification.EntryAssets | ConvertTo-Json -Depth 5 -Compress
  Write-Host "PASS: commit=$($runtime.commitSha) image=$($runtime.image) imageId=$imageId assets=$assetsJson"
  if ($previousVersion) {
    Write-Host "previous=$($previousVersion.image); rollback=pwsh -File scripts/lan-deploy.ps1 -RollbackImage $($previousVersion.image)"
  }
} catch {
  $failure = $_.Exception.Message
  Write-Host "FAIL: $failure"
  if ($previousImage) {
    try {
      Restore-PreviousImage $previousImage $previousImageId
      $restoredVerification = Invoke-DeploymentVerification $previousImage $previousVersion.commitSha
      $restoredRuntime = $restoredVerification.Runtime
      $restoredImage = Get-ContainerImage $ContainerName
      if ($restoredImage -ne $previousImage) {
        throw "回滚后运行镜像不匹配：$restoredImage"
      }
      $restoredImageId = Get-ContainerImageId $ContainerName
      if ($previousImageId -and $restoredImageId -ne $previousImageId) {
        throw "回滚后镜像 ID 不匹配：$restoredImageId"
      }
      if ($restoredRuntime.image -ne $previousImage) {
        throw "回滚后版本接口镜像不匹配：$($restoredRuntime.image)"
      }
      Write-Host "ROLLBACK PASS: $restoredImage imageId=$restoredImageId"
    } catch {
      throw "$failure；自动回滚失败：$($_.Exception.Message)"
    }
  }
  throw
} finally {
  Pop-Location
}
