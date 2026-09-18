param(
  [string]$Image = "customer-chat-analysis:verify",
  [int]$HostPort = 18787,
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

docker info --format "{{.ServerVersion}}" | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "SKIP: Docker 引擎不可用。Windows 服务等价运行的契约与限制见 docs/guides/lan-deployment.md。"
  exit 2
}

$root = Join-Path $env:TEMP ("lan-runtime-verify-" + [guid]::NewGuid().ToString("N"))
$dataDir = Join-Path $root "data"
$knowledgeDir = Join-Path $root "knowledge"
$container = "lan-runtime-verify-app"
New-Item -ItemType Directory -Force -Path $dataDir, $knowledgeDir | Out-Null

try {
  Write-Host "== 构建镜像 $Image"
  docker build -t $Image (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  if ($LASTEXITCODE -ne 0) { Fail "镜像构建失败" }

  Write-Host "== 首次启动容器（不注入 ENCRYPTION_KEY，验证托管密钥落盘）"
  docker rm -f $container 2>$null | Out-Null
  docker run -d --name $container -p "127.0.0.1:${HostPort}:8787" `
    -e "LISTEN_HOST=0.0.0.0" `
    -v "${dataDir}:/app/data" -v "${knowledgeDir}:/app/knowledge" $Image | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "容器启动失败" }
  if (-not (Wait-Healthy $container)) {
    docker logs $container 2>&1 | Select-Object -Last 40
    Fail "健康检查未通过"
  }

  Write-Host "== 健康端点不泄漏业务细节"
  $health = (docker exec $container node -e "fetch('http://127.0.0.1:8787/api/health').then(response => response.text()).then((text) => process.stdout.write(text))") -join ""
  if ($health -notmatch '"status":"ok"') { Fail "健康响应异常：$health" }
  if ($health -match 'app\.db|DATA_DIR|/app/data') { Fail "健康响应包含内部路径" }

  Write-Host "== 非 root 身份"
  $uid = (docker exec $container id -u) -join ""
  if ($uid.Trim() -eq "0") { Fail "容器以 root 运行" }

  Write-Host "== 首次运行生成数据库、托管密钥与知识快照"
  docker exec $container sh -c "echo keep > /app/data/persist-check.txt"
  docker exec $container sh -c "test -f /app/data/app.db && test -f /app/data/.secrets/app.db.key.json && test -f /app/knowledge/catalog.json"
  if ($LASTEXITCODE -ne 0) { Fail "首次运行未生成持久文件" }

  Write-Host "== 重建容器后持久化校验"
  docker rm -f $container | Out-Null
  docker run -d --name $container -p "127.0.0.1:${HostPort}:8787" `
    -e "LISTEN_HOST=0.0.0.0" `
    -v "${dataDir}:/app/data" -v "${knowledgeDir}:/app/knowledge" $Image | Out-Null
  if (-not (Wait-Healthy $container)) { Fail "重建后健康检查未通过" }
  docker exec $container sh -c "test -f /app/data/persist-check.txt && test -f /app/data/app.db && test -f /app/data/.secrets/app.db.key.json && test -f /app/data/logs/server.out.log && test -f /app/knowledge/catalog.json"
  if ($LASTEXITCODE -ne 0) { Fail "重建后持久数据缺失" }

  Write-Host "== 单实例保护（同容器内再次启动入口应被拒绝）"
  $second = (docker exec $container node --import tsx src/server/launcher.ts 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0) { Fail "第二个实例被错误地允许启动" }
  if ($second -notmatch "已有服务|占用") { Fail "单实例失败信息不明确：$second" }

  Write-Host "== Compose 配置校验"
  $envFile = Join-Path $root ".env"
  (Get-Content (Join-Path $PSScriptRoot "..\deploy\.env.example")) `
    -replace '^APP_IMAGE=.*', "APP_IMAGE=$Image" `
    -replace '^ENCRYPTION_KEY=$', "ENCRYPTION_KEY=verify-encryption-key" `
    -replace '^ALLOWED_HOSTS=.*', "ALLOWED_HOSTS=verify.example.lan" `
    -replace '^ALLOWED_ORIGINS=.*', "ALLOWED_ORIGINS=https://verify.example.lan" `
    -replace '^DEPLOY_DATA_DIR=.*', "DEPLOY_DATA_DIR=$($dataDir -replace '\\','/')" `
    -replace '^DEPLOY_KNOWLEDGE_DIR=.*', "DEPLOY_KNOWLEDGE_DIR=$($knowledgeDir -replace '\\','/')" `
    | Set-Content $envFile
  docker compose --env-file $envFile -f (Join-Path $PSScriptRoot "..\deploy\docker-compose.yml") config --quiet
  if ($LASTEXITCODE -ne 0) { Fail "Compose 配置无效" }

  Write-Host "PASS: 镜像构建、健康检查、非 root、持久化重建、单实例保护与 Compose 配置均通过"
  exit 0
} finally {
  docker rm -f $container 2>$null | Out-Null
  if ($Keep) { Write-Host "保留验证目录：$root" }
  else { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }
}
