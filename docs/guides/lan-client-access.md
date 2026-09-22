# 局域网其他电脑访问使用手册

## 目的

本手册用于指导同一局域网中的其他 Windows 电脑访问客服解析中心。

当前服务端入口为：

```text
https://chat.customer.lan:8443
```

当前服务端内网地址为：

```text
172.16.20.178
```

每台客户端电脑都需要完成两项配置：

1. 信任项目的局域网根证书；
2. 将 `chat.customer.lan` 解析到服务端内网地址。

以下操作都在需要访问网站的客户端电脑上执行，不要在客户端运行
`scripts/setup-local-lan-https.ps1`。该脚本只用于配置运行服务的主电脑。

## 使用的文件

只需要从服务端复制以下文件：

```text
E:\客服解析中心\deploy\proxy-data\tls\root-ca.cer
```

例如，将它复制到客户端：

```text
C:\Temp\root-ca.cer
```

不要向客户端复制以下内容：

- `server.key`：服务器私钥，禁止外传；
- `server.crt`：客户端不需要单独安装服务器证书；
- `deploy/.env`：可能包含运行配置和敏感信息；
- 数据库、模型 API Key、备份或整个 `proxy-data` 目录。

## 前置条件

- 客户端和服务端连接到同一个可信局域网；
- 客户端不是处于访客 Wi-Fi 或开启了客户端隔离的无线网络；
- 服务端内网地址仍为 `172.16.20.178`；
- 服务端的应用和 HTTPS 代理容器正在运行；
- 客户端 Windows 时间和时区正确。

如果服务端 IP 发生变化，本文所有 `172.16.20.178` 都要替换为新的固定内网 IP，
并重新生成包含新 IP 的服务器证书。

## 实施顺序

### 1. 安装根证书

在客户端打开 PowerShell，执行：

```powershell
certutil.exe -user -addstore -f Root "C:\Temp\root-ca.cer"
```

看到导入成功后，可以使用以下命令检查：

```powershell
certutil.exe -user -store Root |
  Select-String "Customer Chat Analysis LAN Root CA"
```

也可以双击 `root-ca.cer`，选择：

```text
安装证书
→ 当前用户
→ 将所有证书放入下列存储
→ 受信任的根证书颁发机构
→ 完成
```

根证书只应安装在需要访问本系统的可信电脑上。

### 2. 以管理员身份打开 hosts 文件

1. 打开 Windows 开始菜单；
2. 输入 `PowerShell`；
3. 右键选择“以管理员身份运行”；
4. 在管理员 PowerShell 中执行：

```powershell
notepad C:\Windows\System32\drivers\etc\hosts
```

在文件最后添加：

```text
172.16.20.178 chat.customer.lan
```

保存并关闭记事本。

注意：

- 这一行前面不能有 `#`。以 `#` 开头的内容是注释，不会生效；
- 文件名必须是 `hosts`，不能保存成 `hosts.txt`；
- IP 和域名之间至少保留一个空格或一个 Tab；
- 不要修改或删除文件中其他软件已有的记录。

保存后可以检查记录：

```powershell
Get-Content "$env:SystemRoot\System32\drivers\etc\hosts" |
  Select-String "chat.customer.lan"
```

正确输出应包含：

```text
172.16.20.178 chat.customer.lan
```

### 3. 刷新域名解析

在客户端 PowerShell 中执行：

```powershell
ipconfig /flushdns
```

检查 Windows 是否能把域名解析为服务端地址：

```powershell
[System.Net.Dns]::GetHostAddresses("chat.customer.lan")
```

输出中应包含：

```text
172.16.20.178
```

### 4. 检查 HTTPS 端口

执行：

```powershell
Test-NetConnection chat.customer.lan -Port 8443
```

预期结果：

```text
RemoteAddress    : 172.16.20.178
RemotePort       : 8443
TcpTestSucceeded : True
```

PowerShell 中的 `PS C:\...>` 和 `>>` 是提示符，不是命令的一部分。复制命令时不要把
这些字符一起输入。如果 PowerShell 一直显示 `>>` 等待继续输入，可以按 `Ctrl+C`
取消，再重新输入完整命令。

### 5. 打开网站并登录

建议使用 Microsoft Edge 或 Google Chrome 打开：

```text
https://chat.customer.lan:8443
```

必须使用上面的域名访问，不要改用：

```text
https://172.16.20.178:8443
```

直接使用 IP 可能导致证书名称不匹配、Host 校验失败或登录 Cookie 异常。

首次安装根证书后，如果浏览器仍显示旧的证书状态，请完全关闭浏览器后重新打开。

## 验收

客户端满足以下条件即表示配置完成：

- 域名解析结果为 `172.16.20.178`；
- `Test-NetConnection` 显示 `TcpTestSucceeded : True`；
- 浏览器地址栏没有证书安全警告；
- 可以打开登录页并正常登录；
- 工作台、任务列表、图片和主要操作可以正常使用；
- 退出后会话正常失效，再次访问需要重新登录。

也可以执行健康检查：

```powershell
Invoke-RestMethod "https://chat.customer.lan:8443/api/health"
```

正常响应中的状态应为 `ok`。

## 常见问题

### `Name resolution of chat.customer.lan failed`

含义：客户端没有把域名解析到服务端 IP。

检查顺序：

1. 确认修改的是客户端自己的 `hosts` 文件；
2. 确认记录前面没有 `#`；
3. 确认文件不是 `hosts.txt`；
4. 确认已经保存文件；
5. 运行 `ipconfig /flushdns`；
6. 运行以下命令重新检查：

```powershell
Get-Content "$env:SystemRoot\System32\drivers\etc\hosts" |
  Select-String "chat.customer.lan"
```

### `>>` 无法识别为 cmdlet

含义：把 PowerShell 的续行提示符也复制成了命令。

错误示例：

```text
>> >> Test-NetConnection chat.customer.lan -Port 8443
```

正确命令：

```powershell
Test-NetConnection chat.customer.lan -Port 8443
```

不要输入 `PS C:\...>` 或 `>>`。

### `TcpTestSucceeded : False`

含义：域名已经解析，但客户端无法连接服务端的 `8443` 端口。

依次检查：

1. 客户端是否连接到与服务端相同的局域网；
2. 是否使用访客 Wi-Fi，或者路由器是否启用了 AP/客户端隔离；
3. 服务端 IP 是否仍为 `172.16.20.178`；
4. 服务端 Docker Desktop 是否运行；
5. `customer-chat-analysis-proxy` 容器是否运行；
6. 服务端 Windows 防火墙是否允许当前局域网访问 `8443`；
7. 是否有其他程序占用了 `8443`。

在服务端执行：

```powershell
docker ps --filter "name=customer-chat-analysis-proxy"
Get-NetTCPConnection -State Listen -LocalPort 8443
Get-NetFirewallProfile | Select-Object Name, Enabled
Get-NetFirewallRule -DisplayName "客服解析中心 LAN HTTPS 8443" `
  -ErrorAction SilentlyContinue
```

如果服务端本机也无法打开网站，先恢复服务端容器；如果服务端本机正常而客户端端口测试
失败，重点检查防火墙、路由器隔离和客户端所在网段。

### 浏览器显示“连接不是私密连接”

常见原因：

- `root-ca.cer` 没有安装到“受信任的根证书颁发机构”；
- 证书安装到了另一位 Windows 用户；
- 浏览器在安装证书前已经打开，尚未重新启动；
- 使用了 IP 地址而不是 `chat.customer.lan`；
- 客户端系统时间不正确；
- 服务端 IP 改变后仍在使用旧证书。

重新安装根证书、关闭全部浏览器窗口，并使用域名访问。不要通过关闭浏览器证书校验来
绕过问题。

### 页面返回 403 或登录后立即退出

检查浏览器地址是否严格为：

```text
https://chat.customer.lan:8443
```

不要使用 HTTP、IP 地址、其他端口或其他域名。服务端的 `ALLOWED_HOSTS`、
`ALLOWED_ORIGINS` 和安全 Cookie 都按照该 HTTPS 地址配置。

### 页面能打开但操作超时

可能原因包括：

- 服务端应用容器异常；
- 大文件上传或模型请求仍在处理中；
- 模型供应商无法访问或限流；
- 客户端无线网络不稳定；
- 服务端磁盘空间不足。

先在客户端检查：

```powershell
Invoke-RestMethod "https://chat.customer.lan:8443/api/health"
```

再在服务端检查：

```powershell
docker ps
docker logs --since 15m lan-preview
docker logs --since 15m customer-chat-analysis-proxy
```

### 其他电脑可以访问，只有一台电脑不行

问题通常位于该客户端：

- `hosts` 配置错误；
- 根证书未安装到当前用户；
- 本机代理、VPN 或安全软件拦截；
- 浏览器缓存了旧证书；
- 连接到了不同的 Wi-Fi 或 VLAN。

可以暂时关闭客户端 VPN，并比较正常电脑与异常电脑的：

```powershell
ipconfig
Test-NetConnection chat.customer.lan -Port 8443
```

不要为了排查而长期关闭防病毒软件或防火墙。

## 多台电脑配置

每增加一台客户端，都需要重复：

1. 复制并安装同一个 `root-ca.cer`；
2. 配置该客户端自己的 `hosts`；
3. 刷新 DNS；
4. 测试 `8443`；
5. 使用浏览器登录。

如果客户端数量较多，可以在内网 DNS 中统一增加：

```text
chat.customer.lan -> 172.16.20.178
```

配置内网 DNS 后，客户端不再需要逐台修改 `hosts`，但仍需信任根证书。不要把该记录
配置到公网 DNS。

## 回退

不再允许某台客户端访问时：

1. 删除该电脑 `hosts` 文件中的：

   ```text
   172.16.20.178 chat.customer.lan
   ```

2. 执行：

   ```powershell
   ipconfig /flushdns
   ```

3. 如需同时撤销证书信任，运行 `certmgr.msc`，进入：

   ```text
   受信任的根证书颁发机构
   → 证书
   → Customer Chat Analysis LAN Root CA
   ```

   核对名称后删除该证书。

撤销某台客户端的网络访问不能代替停用其系统账号。如果该电脑或账号不再可信，还应由
管理员在系统中停用账号、重置密码并检查审计日志。

## 安全要求

- 服务仅供可信局域网使用，不做路由器端口映射或 DMZ；
- 不把 `8443`、`8080` 或应用端口 `8788` 暴露到公网；
- 根证书只分发给批准使用系统的电脑；
- `server.key` 不得离开服务端；
- 不在聊天、邮件或截图中传播密码、Cookie、模型 API Key 或加密密钥；
- 服务端 IP 应设置为固定地址或 DHCP 保留地址，避免重启路由器后变化；
- 客户端丢失或离职时，应删除证书、移除域名配置并停用系统账号。
