param(
  [string]$Image = "customer-chat-analysis:acceptance",
  [int]$ProxyPort = 8443,
  [string]$HostName = "chat.example.lan",
  [string]$AdminPassword = "acceptance-admin-123",
  [string]$AdminUsername = "admin",
  [string]$ExternalEntry = "",
  [string]$ConnectHost = "",
  [string]$EvidencePath = "",
  [string]$ModelBaseUrl = "",
  [string]$ModelApiKey = "",
  [string]$ModelName = "",
  [string]$TextModelName = "",
  [string]$ModelSupportsVision = "true",
  [switch]$RequireRealModel,
  [switch]$SkipDnsCheck,
  [switch]$AllowSelfSigned,
  [switch]$Keep
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

function Fail([string]$Message) { Write-Host "FAIL: $Message"; exit 1 }
function Wait-Healthy([string]$Name) {
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Seconds 3
    $state = docker inspect --format "{{.State.Health.Status}}" $Name 2>$null
    if ($state -eq "healthy") { return $true }
    if ((docker inspect --format "{{.State.Running}}" $Name 2>$null) -ne "true") { return $false }
  }
  return $false
}
function Wait-Port([int]$Port, [int]$Attempts = 40) {
  for ($i = 0; $i -lt $Attempts; $i++) {
    try { $client = [System.Net.Sockets.TcpClient]::new("127.0.0.1", $Port); $client.Close(); return $true }
    catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}
function Wait-Tls([int]$Port, [string]$TargetHost, [int]$Attempts = 60) {
  for ($i = 0; $i -lt $Attempts; $i++) {
    $tcp = $null; $ssl = $null
    try {
      $tcp = [System.Net.Sockets.TcpClient]::new("127.0.0.1", $Port)
      $ssl = [System.Net.Security.SslStream]::new($tcp.GetStream(), $false, { param($sender, $cert, $chain, $errors) return $true })
      $ssl.AuthenticateAsClient($TargetHost)
      return $true
    } catch { Start-Sleep -Milliseconds 500 }
    finally { if ($ssl) { $ssl.Dispose() }; if ($tcp) { $tcp.Close() } }
  }
  return $false
}
function Invoke-ContainerCli([string]$Command) {
  $output = (docker exec $script:appContainer sh -c $Command 2>&1) -join "`n"
  if ($LASTEXITCODE -ne 0) { Fail "容器命令失败：$Command`n$output" }
  return $output
}
function Set-ModelEnv {
  $baseUrl = if ($ModelBaseUrl) { $ModelBaseUrl } else { $env:ACCEPTANCE_MODEL_BASE_URL }
  $apiKey = if ($ModelApiKey) { $ModelApiKey } else { $env:ACCEPTANCE_MODEL_API_KEY }
  $name = if ($ModelName) { $ModelName } else { $env:ACCEPTANCE_MODEL_NAME }
  $textName = if ($TextModelName) { $TextModelName } else { $env:ACCEPTANCE_TEXT_MODEL_NAME }
  if ($baseUrl -and $apiKey -and $name) {
    $resolvedText = if ($textName) { $textName } else { $name }
    $env:ACCEPTANCE_MODEL_BASE_URL = $baseUrl
    $env:ACCEPTANCE_MODEL_API_KEY = $apiKey
    $env:ACCEPTANCE_MODEL_NAME = $name
    $env:ACCEPTANCE_TEXT_MODEL_NAME = $resolvedText
    $env:ACCEPTANCE_MODEL_SUPPORTS_VISION = $ModelSupportsVision
    return [ordered]@{ configured = $true; baseUrl = $baseUrl; visionModel = $name; textModel = $resolvedText; supportsVision = ($ModelSupportsVision -ne "false") }
  }
  Remove-Item Env:ACCEPTANCE_MODEL_BASE_URL, Env:ACCEPTANCE_MODEL_API_KEY, Env:ACCEPTANCE_MODEL_NAME, Env:ACCEPTANCE_TEXT_MODEL_NAME, Env:ACCEPTANCE_MODEL_SUPPORTS_VISION -ErrorAction SilentlyContinue
  return [ordered]@{ configured = $false }
}
function Invoke-FieldAcceptance {
  $uri = [Uri]$ExternalEntry
  if ($uri.Scheme -ne "https") { Fail "ExternalEntry 必须使用 https://（真实内网证书入口）" }
  $hostName = $uri.Host
  $port = if ($uri.IsDefaultPort) { 443 } else { $uri.Port }
  $origin = if ($uri.IsDefaultPort) { "https://$hostName" } else { "https://${hostName}:$port" }
  $tlsVerify = -not $AllowSelfSigned

  $dnsRecords = @()
  if ($SkipDnsCheck) {
    Write-Host "WARN: 已跳过 DNS 检查（仅用于预演，不作为现场证据）"
  } else {
    try {
      $dnsRecords = @(Resolve-DnsName -Name $hostName -Type A -ErrorAction Stop | ForEach-Object {
        @{ name = $_.Name; type = $_.Type; address = $_.IPAddress }
      })
    } catch {
      Fail "内网 DNS 未解析 $hostName：$($_.Exception.Message)"
    }
  }

  $dockerVersion = ""
  try { $dockerVersion = (docker version --format "{{.Server.Version}}" 2>$null) } catch { $dockerVersion = "" }

  $evidence = [ordered]@{
    collectedAt = (Get-Date).ToString("o")
    mode = "field"
    entry = $ExternalEntry
    tlsVerified = $tlsVerify
    workstation = @{
      computer = $env:COMPUTERNAME
      user = $env:USERNAME
      os = [System.Environment]::OSVersion.VersionString
      docker = $dockerVersion
    }
    dns = $dnsRecords
  }

  $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  $connectHost = if ($ConnectHost) { $ConnectHost } else { $hostName }
  $env:ACCEPTANCE_HOST = $hostName
  $env:ACCEPTANCE_PORT = "$port"
  $env:ACCEPTANCE_ORIGIN = $origin
  $env:ACCEPTANCE_CONNECT_HOST = $connectHost
  $env:ACCEPTANCE_TLS_VERIFY = if ($tlsVerify) { "true" } else { "false" }
  $env:ACCEPTANCE_ADMIN_USERNAME = $AdminUsername
  $env:ACCEPTANCE_ADMIN_PASSWORD = $AdminPassword
  $env:ACCEPTANCE_SAMPLE = (Join-Path $repoRoot "sample-chat.xlsx")
  $modelInfo = Set-ModelEnv
  if ($RequireRealModel -and -not $modelInfo.configured) {
    Fail "现场签署要求 -RequireRealModel，但未提供真实模型凭据（-ModelBaseUrl/-ModelApiKey/-ModelName 或 ACCEPTANCE_MODEL_* 环境变量）"
  }
  $evidence.realModel = $modelInfo

  Write-Host "== 现场验收 $ExternalEntry（TLS 校验：$tlsVerify，真实模型：$($modelInfo.configured)）"
  $started = Get-Date
  $text = (node (Join-Path $repoRoot "scripts/lan-acceptance-client.mjs")) -join "`n"
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  $client = $text | ConvertFrom-Json
  if (-not $client) { Fail "验收客户端未输出结果：$text" }
  $client.steps | ForEach-Object { Write-Host ("   [{0}] {1}" -f ($(if ($_.ok) { "OK" } else { "FAIL" })), $_.name) }
  $evidence.acceptance = @{
    ok = $client.ok
    seconds = $seconds
    tlsVerified = $client.tlsVerified
    realModel = $client.realModel
    modelEvidence = $client.modelEvidence
    steps = $client.steps
    backupName = $client.backupName
    auditEventCount = $client.auditEventCount
  }
  $path = if ($EvidencePath) { $EvidencePath } else { Join-Path $env:TEMP "lan-field-acceptance-evidence.json" }
  [IO.File]::WriteAllText($path, ($evidence | ConvertTo-Json -Depth 8))
  Write-Host "证据文件：$path"
  if (-not $client.ok) { Fail "现场验收未通过（见证据文件）" }
  Write-Host "FIELD ACCEPTANCE OK"
}

if ($ExternalEntry) {
  Invoke-FieldAcceptance
  exit 0
}

docker info --format "{{.ServerVersion}}" | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "SKIP: 本机没有可用 Docker，无法执行局域网发布验收。"
  exit 2
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$root = Join-Path $env:TEMP ("lan-acceptance-" + [guid]::NewGuid().ToString("N"))
$dataDir = Join-Path $root "data"
$knowledgeDir = Join-Path $root "knowledge"
$tlsDir = Join-Path $root "tls"
$proxyConf = Join-Path $root "proxy.conf"
$appContainer = "lan-acceptance-app"
$proxyContainer = "lan-acceptance-proxy"
$network = "lan-acceptance-net"
New-Item -ItemType Directory -Force -Path $dataDir, $knowledgeDir, $tlsDir | Out-Null

$evidence = [ordered]@{
  startedAt = (Get-Date).ToString("o")
  host = @{
    os = [System.Environment]::OSVersion.VersionString
    cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)
    memoryGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
    docker = (docker version --format "{{.Server.Version}}")
  }
  image = $Image
  entry = "https://${HostName}:${ProxyPort}"
  dataDir = $dataDir
  knowledgeDir = $knowledgeDir
}

try {
  Write-Host "== 构建镜像 $Image"
  docker build -t $Image $repoRoot
  if ($LASTEXITCODE -ne 0) { Fail "镜像构建失败" }
  $evidence.imageId = (docker image inspect $Image --format "{{.Id}}")

  Write-Host "== 生成内网自签名证书（$HostName）"
  $cert = New-SelfSignedCertificate -DnsName $HostName -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter (Get-Date).AddDays(7) -Subject "CN=$HostName"
  try {
    [IO.File]::WriteAllText((Join-Path $tlsDir "server.crt"), $cert.ExportCertificatePem())
    [IO.File]::WriteAllText((Join-Path $tlsDir "server.key"), [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert).ExportPkcs8PrivateKeyPem())
  } finally {
    Remove-Item ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -ErrorAction SilentlyContinue
  }

  $proxyTemplate = @"
server {
    listen 443 ssl;
    server_name $HostName;
    ssl_certificate     /etc/nginx/tls/server.crt;
    ssl_certificate_key /etc/nginx/tls/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    client_max_body_size 2048m;
    proxy_read_timeout   7200s;
    location / {
        proxy_pass http://${appContainer}:8787;
        proxy_http_version 1.1;
        proxy_set_header Host `$host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_request_buffering off;
    }
}
"@
  [IO.File]::WriteAllText($proxyConf, $proxyTemplate)

  Write-Host "== 建立内部网络并启动应用容器"
  if ((docker network ls --format "{{.Name}}") -contains $network) { docker network rm $network | Out-Null }
  docker network create $network | Out-Null
  foreach ($name in @($appContainer, $proxyContainer)) {
    if ((docker ps -aq -f "name=^/${name}$")) { docker rm -f $name | Out-Null }
  }
  docker run -d --name $appContainer --network $network `
    -e "LISTEN_HOST=0.0.0.0" `
    -e "ALLOWED_HOSTS=$HostName" `
    -e "ALLOWED_ORIGINS=https://$HostName,https://${HostName}:$ProxyPort" `
    -e "SESSION_COOKIE_SECURE=true" `
    -e "FIRST_ADMIN_USERNAME=admin" `
    -e "FIRST_ADMIN_PASSWORD=$AdminPassword" `
    -e "FIRST_ADMIN_DISPLAY_NAME=验收管理员" `
    -v "${dataDir}:/app/data" -v "${knowledgeDir}:/app/knowledge" $Image | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "应用容器启动失败" }
  if (-not (Wait-Healthy $appContainer)) {
    docker logs $appContainer 2>&1 | Select-Object -Last 40
    Fail "应用容器健康检查未通过"
  }
  Write-Host "== 管理员已通过首次启动环境变量初始化"

  Write-Host "== 启动内网 HTTPS 反向代理"
  docker run -d --name $proxyContainer --network $network -p "127.0.0.1:${ProxyPort}:443" `
    -v "${tlsDir}:/etc/nginx/tls:ro" -v "${proxyConf}:/etc/nginx/conf.d/default.conf:ro" nginx:latest | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "反向代理启动失败" }
  if (-not (Wait-Port $ProxyPort)) {
    docker logs $proxyContainer 2>&1 | Select-Object -Last 40
    Fail "反向代理端口未就绪"
  }
  if (-not (Wait-Tls $ProxyPort $HostName)) {
    docker logs $proxyContainer 2>&1 | Select-Object -Last 40
    Fail "反向代理 TLS 未就绪"
  }

  Write-Host "== 执行五角色权限与审计验收（HTTPS）"
  $env:ACCEPTANCE_HOST = $HostName
  $env:ACCEPTANCE_PORT = "$ProxyPort"
  $env:ACCEPTANCE_ORIGIN = "https://$HostName"
  $env:ACCEPTANCE_CONNECT_HOST = "127.0.0.1"
  $env:ACCEPTANCE_TLS_VERIFY = "false"
  $env:ACCEPTANCE_ADMIN_USERNAME = "admin"
  $env:ACCEPTANCE_ADMIN_PASSWORD = $AdminPassword
  $env:ACCEPTANCE_SAMPLE = (Join-Path $repoRoot "sample-chat.xlsx")
  $modelInfo = Set-ModelEnv
  $evidence.realModel = $modelInfo
  $clientStarted = Get-Date
  $clientText = (node (Join-Path $repoRoot "scripts/lan-acceptance-client.mjs")) -join "`n"
  $clientSeconds = [math]::Round(((Get-Date) - $clientStarted).TotalSeconds, 1)
  $client = $clientText | ConvertFrom-Json
  if (-not $client) { Fail "验收客户端未输出结果：$clientText" }
  $client.steps | ForEach-Object { Write-Host ("   [{0}] {1}" -f ($(if ($_.ok) { "OK" } else { "FAIL" })), $_.name) }
  $evidence.acceptanceClient = @{ ok = $client.ok; seconds = $clientSeconds; realModel = $client.realModel; modelEvidence = $client.modelEvidence; steps = $client.steps; backupName = $client.backupName; auditEventCount = $client.auditEventCount }
  if (-not $client.ok) { throw "五角色验收未通过" }

  Write-Host "== 独立目录恢复与密钥校验"
  $restorePath = "/tmp/acceptance-restore"
  $restoreOutput = Invoke-ContainerCli "npm run --silent restore -- /app/data/backups/$($client.backupName) --to $restorePath"
  Invoke-ContainerCli "mkdir -p $restorePath/data/.secrets && cp /app/data/.secrets/app.db.key.json $restorePath/data/.secrets/" | Out-Null
  $verifyText = Invoke-ContainerCli "npm run --silent restore:verify -- $restorePath"
  $verify = $verifyText | ConvertFrom-Json
  if (-not $verify.ok) { Fail "恢复校验失败：$verifyText" }
  $evidence.restore = @{ backup = $client.backupName; checks = $verify.checks; verified = $true }

  Write-Host "== 镜像升级预演与持久数据校验"
  docker rm -f $appContainer | Out-Null
  $upgradeTag = "$Image-upgraded"
  docker tag $Image $upgradeTag
  docker run -d --name $appContainer --network $network `
    -e "LISTEN_HOST=0.0.0.0" `
    -e "ALLOWED_HOSTS=$HostName" `
    -e "ALLOWED_ORIGINS=https://$HostName,https://${HostName}:$ProxyPort" `
    -e "SESSION_COOKIE_SECURE=true" `
    -v "${dataDir}:/app/data" -v "${knowledgeDir}:/app/knowledge" $upgradeTag | Out-Null
  if (-not (Wait-Healthy $appContainer)) { Fail "升级预演后健康检查未通过" }
  $jobCount = (Invoke-ContainerCli "node -e `"const D=require('/app/node_modules/better-sqlite3');const db=new D('/app/data/app.db',{readonly:true});process.stdout.write(String(db.prepare('SELECT COUNT(*) n FROM jobs').get().n));db.close();`"").Trim()
  Invoke-ContainerCli "test -f /app/data/.secrets/app.db.key.json" | Out-Null
  if ([int]$jobCount -lt 1) { Fail "升级预演后任务数据缺失" }
  $evidence.persistence = @{ jobsAfterUpgrade = [int]$jobCount; managedKey = $true }

  Write-Host "== 镜像回滚预演（切回原标签）"
  docker rm -f $appContainer | Out-Null
  docker run -d --name $appContainer --network $network `
    -e "LISTEN_HOST=0.0.0.0" `
    -e "ALLOWED_HOSTS=$HostName" `
    -e "ALLOWED_ORIGINS=https://$HostName,https://${HostName}:$ProxyPort" `
    -e "SESSION_COOKIE_SECURE=true" `
    -v "${dataDir}:/app/data" -v "${knowledgeDir}:/app/knowledge" $Image | Out-Null
  if (-not (Wait-Healthy $appContainer)) { Fail "镜像回滚后健康检查未通过" }
  $jobCountRollback = (Invoke-ContainerCli "node -e `"const D=require('/app/node_modules/better-sqlite3');const db=new D('/app/data/app.db',{readonly:true});process.stdout.write(String(db.prepare('SELECT COUNT(*) n FROM jobs').get().n));db.close();`"").Trim()
  if ([int]$jobCountRollback -lt 1) { Fail "镜像回滚后任务数据缺失" }
  $evidence.rollback = @{ jobsAfterRollback = [int]$jobCountRollback; image = $Image }

  Write-Host "== 单实例保护"
  $second = (docker exec $appContainer node --import tsx src/server/launcher.ts 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0) { Fail "第二个实例被错误地允许启动" }
  if ($second -notmatch "已有服务|占用") { Fail "单实例失败信息不明确：$second" }
  $evidence.singleInstance = @{ rejected = $true }

  $evidence.finishedAt = (Get-Date).ToString("o")
  $evidencePath = Join-Path $root "acceptance-evidence.json"
  [IO.File]::WriteAllText($evidencePath, ($evidence | ConvertTo-Json -Depth 8))
  Write-Host ""
  Write-Host "ACCEPTANCE OK"
  Write-Host "证据文件：$evidencePath"
  Write-Host ($evidence | ConvertTo-Json -Depth 4)
  if (-not $Keep) { Copy-Item $evidencePath (Join-Path $env:TEMP "lan-acceptance-evidence.json") -Force }
} catch {
  foreach ($name in @($appContainer, $proxyContainer)) {
    if ((docker ps -aq -f "name=^/${name}$")) { docker logs $name 2>&1 | Select-Object -Last 20 }
  }
  Write-Host "FAIL: $($_.Exception.Message)"
  exit 1
} finally {
  if (-not $Keep) {
    foreach ($name in @($appContainer, $proxyContainer)) {
      if ((docker ps -aq -f "name=^/${name}$")) { docker rm -f $name | Out-Null }
    }
    if ((docker network ls --format "{{.Name}}") -contains $network) { docker network rm $network | Out-Null }
    docker rmi "$Image-upgraded" 2>$null | Out-Null
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
  } else {
    Write-Host "保留容器、网络与验收目录：$root"
  }
}
