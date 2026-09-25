import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

describe("local LAN HTTPS deployment", () => {
  it("publishes only the production HTTPS entry for the loopback-bound app", () => {
    const compose = read("deploy/docker-compose.lan-https.yml");
    const script = read("scripts/setup-local-lan-https.ps1");

    expect(compose).toContain("nginx:latest");
    expect(compose).toMatch(/LAN_HTTPS_PORT.*:443/);
    expect(compose).not.toMatch(/LAN_HTTP_PORT|:80/);
    expect(script).toContain("docker-compose.lan-https.yml");
    expect(script).toContain('"--no-build"');
    expect(script).not.toMatch(/\$HttpPort\b/);
    expect(script).not.toContain("LAN_HTTP_PORT");
    const nginxTemplate = read("deploy/nginx-lan.conf.example");
    expect(nginxTemplate).toContain("ssl_certificate");
    expect(nginxTemplate).toContain("proxy_pass http://app:8787");
    expect(nginxTemplate).toContain("__LAN_HOSTNAME__");
    expect(nginxTemplate).not.toContain("listen 80");
  });

  it("defines an isolated manual-start LAN test stack", () => {
    const compose = read("deploy/docker-compose.lan-test.yml");
    const env = read("deploy/.env.test.example");
    const nginx = read("deploy/nginx-lan-test.conf");

    expect(compose).toContain("customer-chat-analysis-test");
    expect(compose).toMatch(/8444:80/);
    expect(compose).toContain('restart: "no"');
    expect(compose).not.toMatch(/0\.0\.0\.0:8787|8787:8787/);
    expect(env).toContain("APP_PORT=8789");
    expect(env).toContain("DEPLOY_DATA_DIR=./test-data");
    expect(env).toContain("DEPLOY_KNOWLEDGE_DIR=./test-knowledge");
    expect(env).toContain("chat-test.example.invalid");
    expect(env).not.toContain("172.16.20.178");
    expect(env).not.toContain("chat-test.customer.lan");
    expect(env).toContain("SESSION_COOKIE_SECURE=false");
    expect(nginx).toContain("proxy_pass http://app:8787");
    expect(nginx).toContain("X-Forwarded-Proto http");
  });

  it("keeps local certificate and host setup outside the repository", () => {
    const script = read("scripts/setup-local-lan-https.ps1");

    expect(script).toContain("docker compose");
    expect(script).toContain("Export-PfxCertificate");
    expect(script).toContain("Export-Certificate");
    expect(script).toContain("openssl pkcs12");
    expect(script).not.toContain("-DnsName $Hostname");
    expect(script).not.toContain('$config = $config.Replace("__LAN_HTTPS_PORT__"');
    expect(script).toContain('certutil.exe -user -addstore -f Root');
    expect(script).toContain("System32\\drivers\\etc\\hosts");
    expect(script).toContain("New-NetFirewallRule");
    expect(script).toContain("[switch]$SkipHosts");
    expect(script).not.toContain('$HttpPort = 8080');
    expect(script).not.toContain("LAN_HTTP_PORT");
    expect(script).toContain('$HttpsPort = 8443');
    expect(script).toContain("[switch]$UseManagedKey");
    expect(script).toContain('Set-EnvValue $content "APP_IMAGE"');
    expect(script).toContain('Set-EnvValue $content "DEPLOY_DATA_DIR"');
    expect(script).toContain('Set-EnvValue $content "LAN_BIND_ADDRESS" $LanIp');
    expect(script).toContain('Set-EnvValue $content "SESSION_COOKIE_SECURE" "true"');
    expect(script).toContain('if ($UseManagedKey) { $content = Set-EnvValue $content "ENCRYPTION_KEY" "" }');
    expect(script).toContain("deploy/.env");

    const appCompose = read("deploy/docker-compose.yml");
    expect(appCompose).not.toMatch(/^\s+ENCRYPTION_KEY:/m);
  });
});
