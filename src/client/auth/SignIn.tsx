import { useEffect, useState } from "react";
import { fetchAuthStatus, loginRequest } from "./auth-api";
import { setSession } from "./session";
import { BotanicalArt } from "../components/BotanicalArt";
import { LoginAnalysisCanvas } from "../components/LoginAnalysisCanvas";

export function SignIn({ hasAdmin: initialHasAdmin }: { hasAdmin: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hasAdmin, setHasAdmin] = useState(initialHasAdmin);

  useEffect(() => {
    let cancelled = false;
    void fetchAuthStatus()
      .then((status) => {
        if (!cancelled) setHasAdmin(status.hasAdmin);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await loginRequest(username.trim(), password);
      setSession(session);
    } catch (loginError) {
      const message = loginError instanceof Error ? loginError.message : "登录失败，请重试";
      setError(message);
      if (message.includes("bootstrap:admin")) setHasAdmin(false);
      setBusy(false);
    }
  };

  return (
    <div className="app signin-app">
      <main className="signin-layout">
        <section className="signin signin-panel signin-panel--right" aria-labelledby="signin-heading">
          <header className="signin-brand">
            <div className="signin-mark"><BotanicalArt variant="leaves" /><b>析</b></div>
            <div>
              <h1>客服解析中心</h1>
              <p>CHAT INTELLIGENCE WORKSPACE</p>
            </div>
          </header>

          <div className="signin-intro">
            <span>LOCAL ANALYSIS ACCESS</span>
            <h2 id="signin-heading">进入客服解析工作台</h2>
            <p>使用管理员创建的内部账号，继续处理导入、解析、复核与导出任务。</p>
          </div>

          {!hasAdmin && <div className="signin-hint" role="alert">系统尚未创建账号。请在主机上运行 <code>npm run bootstrap:admin</code> 完成首次管理员引导。</div>}
          <form className="signin-form" aria-busy={busy} onSubmit={submit}>
            <label className="signin-field">
              <span>账号</span>
              <input aria-label="账号" value={username} autoComplete="username" placeholder="请输入内部账号" onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label className="signin-field">
              <span>密码</span>
              <input aria-label="密码" type="password" value={password} autoComplete="current-password" placeholder="请输入账号密码" onChange={(event) => setPassword(event.target.value)} />
            </label>
            {error && <div className="signin-error" role="alert">{error}</div>}
            <button className="button primary large signin-submit" type="submit" disabled={busy}>
              <span>{busy ? "正在验证账号" : "登录工作台"}</span>
              <i aria-hidden="true">→</i>
            </button>
          </form>

          <footer className="signin-meta">
            <p className="signin-foot"><i />仅限内部局域网已授权用户使用</p>
            <small>LOCAL / AUTHORIZED USERS</small>
          </footer>
        </section>
        <LoginAnalysisCanvas />
      </main>
    </div>
  );
}
