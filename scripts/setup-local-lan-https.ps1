param(
  [string]$Hostname = "chat.customer.lan",
  [string]$LanIp = "",
  [string]$AllowedCidr = "LocalSubnet",
  [string]$EnvFile = "deploy/.env",
  [string]$AppImage = "",
  [string]$ContainerName = "",
  [string]$DataDir = "",
  [string]$KnowledgeDir = "",
  [int]$AppPort = 8788,
  [int]$HttpPort = 8080,
  [int]$HttpsPort = 8443,
  [switch]$ApplyFirewall,
  [switch]$InstallRoot,
  [switch]$Start,
  [switch]$SkipHosts,
  [switch]$UseManagedKey
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ResolvedEnvFile = if ([System.IO.Path]::IsPathRooted($EnvFile)) {
  $EnvFile
} else {
  Join-Path $ProjectRoot $EnvFile
}
$ComposeBase = Join-Path $ProjectRoot "deploy/docker-compose.yml"
$ComposeTls = Join-Path $ProjectRoot "deploy/docker-compose.lan-https.yml"
$ProxyDataDir = Join-Path $ProjectRoot "deploy/proxy-data"
$ProxyConfigDir = Join-Path $ProjectRoot "deploy/proxy-config"
$TlsDir = Join-Path $ProxyDataDir "tls"
$RootCert = Join-Path $TlsDir "root-ca.cer"
$ServerCert = Join-Path $TlsDir "server.crt"
$ServerKey = Join-Path $TlsDir "server.key"
$ProxyConfig = Join-Path $ProxyConfigDir "default.conf"

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "此操作需要管理员 PowerShell：hosts 和 Windows 防火墙规则需要管理员权限。"
  }
}

function Assert-Hostname([string]$Value) {
  if ($Value -notmatch "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$") {
    throw "Hostname 必须是完整的内网域名，例如 chat.customer.lan：$Value"
  }
}

function Assert-Port([int]$Value, [string]$Name) {
  if ($Value -lt 1 -or $Value -gt 65535) {
    throw "$Name 必须是 1-65535 之间的端口：$Value"
  }
}

function Resolve-LanIp {
  if ($LanIp) {
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($LanIp, [ref]$parsed) -or $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
      throw "LanIp 必须是 IPv4 地址：$LanIp"
    }
    return $LanIp
  }

  $candidates = @(
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        $_.PrefixOrigin -ne "WellKnown"
      } |
      ForEach-Object {
        $profile = Get-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
        if ($profile.NetworkCategory -eq "Private") {
          [pscustomobject]@{ IP = $_.IPAddress; Interface = $_.InterfaceAlias }
        }
      }
  )
  $candidate = $candidates | Where-Object { $_.Interface -notmatch "VMware|Virtual|vEthernet|WSL" } | Select-Object -First 1
  if (-not $candidate) { $candidate = $candidates | Select-Object -First 1 }
  if (-not $candidate) { throw "无法自动确定内网 IPv4，请使用 -LanIp 指定，例如 172.16.20.178" }
  return $candidate.IP
}

function New-RandomEncryptionKey {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes)
}

function Set-EnvValue([string]$Content, [string]$Name, [string]$Value) {
  $escaped = [regex]::Escape($Name)
  $line = "$Name=$Value"
  if ($Content -match "(?m)^$escaped=.*$") {
    return [regex]::Replace($Content, "(?m)^$escaped=.*$", [System.Text.RegularExpressions.MatchEvaluator]{ $line })
  }
  return "$($Content.TrimEnd())`r`n$line`r`n"
}

function Ensure-EnvFile {
  if (-not (Test-Path $ResolvedEnvFile)) {
    Copy-Item (Join-Path $ProjectRoot "deploy/.env.example") $ResolvedEnvFile
  }
  $content = Get-Content -Raw $ResolvedEnvFile
  if ($AppImage) { $content = Set-EnvValue $content "APP_IMAGE" $AppImage }
  if ($ContainerName) { $content = Set-EnvValue $content "APP_CONTAINER_NAME" $ContainerName }
  if ($DataDir) { $content = Set-EnvValue $content "DEPLOY_DATA_DIR" $DataDir }
  if ($KnowledgeDir) { $content = Set-EnvValue $content "DEPLOY_KNOWLEDGE_DIR" $KnowledgeDir }
  if ($UseManagedKey) { $content = Set-EnvValue $content "ENCRYPTION_KEY" "" }
  $content = Set-EnvValue $content "APP_PORT" ([string]$AppPort)
  $content = Set-EnvValue $content "ALLOWED_HOSTS" $Hostname
  $origin = "https://{0}:{1}" -f $Hostname, $HttpsPort
  $content = Set-EnvValue $content "ALLOWED_ORIGINS" $origin
  $content = Set-EnvValue $content "SESSION_COOKIE_SECURE" "true"
  $content = Set-EnvValue $content "LAN_HOSTNAME" $Hostname
  $content = Set-EnvValue $content "LAN_ALLOWED_CIDR" $AllowedCidr
  $content = Set-EnvValue $content "LAN_BIND_ADDRESS" $LanIp
  $content = Set-EnvValue $content "LAN_HTTP_PORT" ([string]$HttpPort)
  $content = Set-EnvValue $content "LAN_HTTPS_PORT" ([string]$HttpsPort)
  Set-Content -LiteralPath $ResolvedEnvFile -Value $content -Encoding utf8
}

function Get-EnvValue([string]$Name, [string]$Fallback) {
  if (-not (Test-Path $ResolvedEnvFile)) { return $Fallback }
  $match = [regex]::Match((Get-Content -Raw $ResolvedEnvFile), "(?m)^$([regex]::Escape($Name))=(.*)$")
  if ($match.Success -and $match.Groups[2].Value.Trim()) { return $match.Groups[2].Value.Trim() }
  return $Fallback
}

function Ensure-TlsCertificates {
  New-Item -ItemType Directory -Force $TlsDir | Out-Null
  if ((Test-Path $RootCert) -and (Test-Path $ServerCert) -and (Test-Path $ServerKey)) {
    return
  }

  $root = New-SelfSignedCertificate `
    -Type Custom `
    -Subject "CN=Customer Chat Analysis LAN Root CA" `
    -KeyAlgorithm RSA `
    -KeyLength 4096 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -KeyUsage CertSign, CRLSign, DigitalSignature `
    -CertStoreLocation Cert:\CurrentUser\My `
    -NotAfter (Get-Date).AddYears(10)
  $san = "2.5.29.17={text}DNS=$Hostname&IPAddress=$LanIp"
  $leaf = New-SelfSignedCertificate `
    -Type Custom `
    -Subject "CN=$Hostname" `
    -Signer $root `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature, KeyEncipherment `
    -TextExtension @($san) `
    -CertStoreLocation Cert:\CurrentUser\My `
    -NotAfter (Get-Date).AddYears(2)

  Export-Certificate -Cert $root -FilePath $RootCert -Type CERT -Force | Out-Null
  $pfxPath = Join-Path $TlsDir "server.pfx"
  $password = New-RandomEncryptionKey
  $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
  Export-PfxCertificate -Cert $leaf -FilePath $pfxPath -Password $securePassword -ChainOption BuildChain -Force | Out-Null

  $mount = "type=bind,source=$TlsDir,target=/tls"
  & docker run --rm --mount $mount -e "PFX_PASSWORD=$password" nginx:latest sh -c `
    "openssl pkcs12 -in /tls/server.pfx -clcerts -nokeys -passin env:PFX_PASSWORD -out /tls/server.crt -nodes; openssl pkcs12 -in /tls/server.pfx -nocerts -nodes -passin env:PFX_PASSWORD -out /tls/server.key"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $ServerCert) -or -not (Test-Path $ServerKey)) {
    throw "无法将本地证书转换为 nginx PEM 文件"
  }
  Remove-Item -LiteralPath $pfxPath -Force
}

function Ensure-ProxyConfig {
  New-Item -ItemType Directory -Force $ProxyConfigDir | Out-Null
  $template = Get-Content -Raw (Join-Path $ProjectRoot "deploy/nginx-lan.conf.example")
  $maxUpload = Get-EnvValue "MAX_UPLOAD_MB" "2048"
  $config = $template.Replace("__LAN_HOSTNAME__", $Hostname)
  $config = $config.Replace("__LAN_HTTPS_PORT__", [string]$HttpsPort)
  $config = $config.Replace("__MAX_UPLOAD_MB__", $maxUpload)
  Set-Content -LiteralPath $ProxyConfig -Value $config -Encoding ascii
}

function Ensure-HostsEntry([string]$Address, [string]$Name) {
  $hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
  $escaped = [regex]::Escape($Name)
  $lines = @(
    Get-Content -LiteralPath $hostsPath |
      Where-Object { $_ -notmatch "(?i)(^|\s)$escaped(\s|$)" -and $_ -notmatch "# customer-chat-analysis LAN HTTPS" }
  )
  $lines += "$Address`t$Name`t# customer-chat-analysis LAN HTTPS"
  Set-Content -LiteralPath $hostsPath -Value $lines -Encoding ascii
}

function Ensure-FirewallRules {
  $prefix = "客服解析中心 LAN HTTPS"
  Get-NetFirewallRule -DisplayName "$prefix *" -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
    foreach ($port in @($HttpPort, $HttpsPort)) {
    New-NetFirewallRule `
      -DisplayName "$prefix $port" `
      -Direction Inbound `
      -Action Allow `
      -Protocol TCP `
      -LocalPort $port `
      -RemoteAddress $AllowedCidr `
      -Profile Private `
      -Description "仅允许批准的局域网访问客服解析中心 HTTPS 入口" | Out-Null
  }
}

function Invoke-Compose([string[]]$Arguments) {
  & docker compose --env-file $ResolvedEnvFile -f $ComposeBase -f $ComposeTls @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Docker Compose 执行失败：docker compose $($Arguments -join ' ')" }
}

Assert-Hostname $Hostname
Assert-Port $HttpPort "HttpPort"
Assert-Port $HttpsPort "HttpsPort"
$LanIp = Resolve-LanIp
if (-not $SkipHosts -or $ApplyFirewall) {
  Assert-Administrator
}
Ensure-EnvFile
if ($SkipHosts) {
  Write-Host "跳过本机 hosts 修改；请在本机或局域网 DNS 中将 $Hostname 解析到 $LanIp。"
} else {
  Ensure-HostsEntry $LanIp $Hostname
}

if ($ApplyFirewall) {
  Ensure-FirewallRules
}

if ($Start -or $InstallRoot) {
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop 未运行。请先启动 Docker Desktop，再重新执行本脚本。"
  }
}

if ($Start -or $InstallRoot) {
  Ensure-TlsCertificates
  Ensure-ProxyConfig
}

if ($Start) {
  Invoke-Compose @("up", "-d", "--no-build", "app", "proxy")
}

if ($InstallRoot) {
  if (-not (Test-Path $RootCert)) {
    throw "找不到根证书：$RootCert。请先使用 -Start 启动代理，或提供已有证书文件。"
  }
  & certutil.exe -user -addstore -f Root $RootCert | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "无法将内网根证书安装到当前用户的受信任根存储"
  }
}

Write-Host ""
Write-Host "LAN HTTPS 配置完成"
Write-Host "入口：https://${Hostname}:$HttpsPort"
Write-Host "内网 IP：$LanIp"
Write-Host "根证书：$RootCert"
Write-Host "客户端：安装 root-ca.cer 到受信任的根证书，并将 $Hostname 解析到 $LanIp"
if (-not $ApplyFirewall) { Write-Host "提示：尚未修改 Windows 防火墙；正式使用请加 -ApplyFirewall。" }
if (-not $Start) { Write-Host "提示：尚未启动 Docker 服务；正式使用请加 -Start。" }
