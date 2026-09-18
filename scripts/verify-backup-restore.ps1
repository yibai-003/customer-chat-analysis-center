param(
  [string]$Image = "customer-chat-analysis:drill",
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
  Write-Host "SKIP: 本机没有可用 Docker，无法执行容器化备份/恢复演练。"
  exit 2
}

$root = Join-Path $env:TEMP ("lan-backup-drill-" + [guid]::NewGuid().ToString("N"))
$dataDir = Join-Path $root "data"
$knowledgeDir = Join-Path $root "knowledge"
$container = "lan-backup-drill-app"
$restoreDir = "/tmp/backup-drill-restore"
New-Item -ItemType Directory -Force -Path $dataDir, $knowledgeDir | Out-Null

$seedScript = @'
import fs from "node:fs";
const { initDb } = await import("/app/src/server/db/client.ts");
const { addRecords, createJob, listRecords } = await import("/app/src/server/db/repositories.ts");
initDb();
fs.writeFileSync("/app/data/drill-image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const job = createJob("drill.xlsx", "/app/data/drill-image.png", { id: "refund", name: "退货分析" });
addRecords(job.id, [{ sheetName: "Sheet1", rowNumber: 1, anchor: {}, sourceFields: { 客服: "演练" }, imagePath: "/app/data/drill-image.png" }]);
console.log(JSON.stringify({ job: job.id, record: listRecords(job.id)[0].id }));
'@

try {
  Write-Host "== 构建镜像 $Image"
  docker build -t $Image (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  if ($LASTEXITCODE -ne 0) { Fail "镜像构建失败" }

  Write-Host "== 启动容器并等待健康"
  if ((docker ps -aq -f "name=^/${container}$")) { docker rm -f $container | Out-Null }
  docker run -d --name $container -e "LISTEN_HOST=0.0.0.0" `
    -v "${dataDir}:/app/data" -v "${knowledgeDir}:/app/knowledge" $Image | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "容器启动失败" }
  if (-not (Wait-Healthy $container)) {
    docker logs $container 2>&1 | Select-Object -Last 40
    Fail "容器健康检查未通过"
  }

  Write-Host "== 写入一条带图片引用的演练数据"
  $seed = (docker exec $container node --import tsx --input-type=module -e $seedScript) -join ""
  if ($LASTEXITCODE -ne 0) { Fail "演练数据写入失败：$seed" }
  Write-Host "   $seed"

  Write-Host "== 容器内创建备份"
  $backupStarted = Get-Date
  $backupText = (docker exec $container npm run --silent backup) -join "`n"
  $backupSeconds = [math]::Round(((Get-Date) - $backupStarted).TotalSeconds, 1)
  if ($LASTEXITCODE -ne 0) { Fail "备份失败：$backupText" }
  $backup = $backupText | ConvertFrom-Json
  $backupName = Split-Path $backup.directory -Leaf
  Write-Host "   目录 $backupName（$($backup.files) 个文件、$($backup.references) 个引用，用时 ${backupSeconds}s）"

  Write-Host "== 恢复到独立目录并放置托管密钥"
  $restoreStarted = Get-Date
  $restoreText = (docker exec $container npm run --silent restore -- $backup.directory --to $restoreDir) -join "`n"
  $restoreSeconds = [math]::Round(((Get-Date) - $restoreStarted).TotalSeconds, 1)
  if ($LASTEXITCODE -ne 0) { Fail "恢复失败：$restoreText" }
  docker exec $container sh -c "mkdir -p $restoreDir/data/.secrets && cp /app/data/.secrets/app.db.key.json $restoreDir/data/.secrets/app.db.key.json" | Out-Null

  Write-Host "== 校验恢复环境"
  $verifyStarted = Get-Date
  $verifyText = (docker exec $container npm run --silent restore:verify -- $restoreDir) -join "`n"
  $verifySeconds = [math]::Round(((Get-Date) - $verifyStarted).TotalSeconds, 1)
  $verify = $verifyText | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $verify.ok) { Fail "恢复校验失败：$verifyText" }

  Write-Host "== 独立恢复文件抽查"
  $imagePath = (docker exec $container node -e "const Database=require('/app/node_modules/better-sqlite3'); const db=new Database('$restoreDir/data/app.db',{readonly:true}); process.stdout.write(db.prepare('SELECT image_path FROM records').get().image_path); db.close();") -join ""
  docker exec $container test -f $imagePath
  if ($LASTEXITCODE -ne 0) { Fail "恢复后的图片引用不存在：$imagePath" }
  docker exec $container test -f "$restoreDir/RESTORED.json"
  if ($LASTEXITCODE -ne 0) { Fail "缺少 RESTORED.json" }
  Write-Host "   图片引用 $imagePath 可读"

  Write-Host ""
  Write-Host "DRILL OK"
  Write-Host (ConvertTo-Json @{
    image = $Image
    backupDirectory = $backupName
    backupSeconds = $backupSeconds
    restoreSeconds = $restoreSeconds
    verifySeconds = $verifySeconds
    files = $backup.files
    references = $backup.references
    verifiedChecks = ($verify.checks | ForEach-Object { $_.name })
  } -Depth 4)
} finally {
  if (-not $Keep) {
    if ((docker ps -aq -f "name=^/${container}$")) { docker rm -f $container | Out-Null }
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
  } else {
    Write-Host "保留容器 $container 与数据目录 $root"
  }
}
