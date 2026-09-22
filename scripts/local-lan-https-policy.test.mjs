import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

describe("local LAN HTTPS deployment", () => {
  it("provides an HTTPS proxy overlay for the loopback-bound app", () => {
    const compose = read("deploy/docker-compose.lan-https.yml");
    const script = read("scripts/setup-local-lan-https.ps1");

    expect(compose).toContain("nginx:latest");
    expect(compose).toMatch(/LAN_HTTP_PORT.*:80/);
    expect(compose).toMatch(/LAN_HTTPS_PORT.*:443/);
    expect(compose).toMatch(/LAN_BIND_ADDRESS.*LAN_HTTP_PORT/);
    expect(script).toContain("docker-compose.lan-https.yml");
    expect(script).toContain('"--no-build"');
    const nginxTemplate = read("deploy/nginx-lan.conf.example");
    expect(nginxTemplate).toContain("ssl_certificate");
    expect(nginxTemplate).toContain("proxy_pass http://app:8787");
    expect(nginxTemplate).toContain("__LAN_HOSTNAME__");
  });

  it("keeps local certificate and host setup outside the repository", () => {
    const script = read("scripts/setup-local-lan-https.ps1");

    expect(script).toContain("docker compose");
    expect(script).toContain("Export-PfxCertificate");
    expect(script).toContain("Export-Certificate");
    expect(script).toContain("openssl pkcs12");
    expect(script).not.toContain("-DnsName $Hostname");
    expect(script).toContain('$config = $config.Replace("__LAN_HTTPS_PORT__"');
    expect(script).toContain('certutil.exe -user -addstore -f Root');
    expect(script).toContain("System32\\drivers\\etc\\hosts");
    expect(script).toContain("New-NetFirewallRule");
    expect(script).toContain("[switch]$SkipHosts");
    expect(script).toContain('$HttpPort = 8080');
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
