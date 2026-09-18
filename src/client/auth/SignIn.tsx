import { useEffect, useState } from "react";
import { fetchAuthStatus, loginRequest } from "./auth-api";
import { setSession } from "./session";
import { BotanicalArt } from "../components/BotanicalArt";

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
      <main className="signin">
        <div className="signin-brand">
          <div className="signin-mark"><BotanicalArt variant="leaves" /><b>析</b></div>
          <h1>客服解析中心</h1>
          <p>CHAT INTELLIGENCE WORKSPACE</p>
        </div>
        {!hasAdmin && <div className="signin-hint" role="alert">系统尚未创建账号。请在主机上运行 <code>npm run bootstrap:admin</code> 完成首次管理员引导。</div>}
        <form className="signin-form" onSubmit={submit}>
          <label className="signin-field">
            <span>账号</span>
            <input aria-label="账号" value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label className="signin-field">
            <span>密码</span>
            <input aria-label="密码" type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <div className="signin-error" role="alert">{error}</div>}
          <button className="button primary large" type="submit" disabled={busy}>{busy ? "登录中..." : "登录"}</button>
        </form>
        <p className="signin-foot">仅限内部局域网已授权用户使用</p>
      </main>
    </div>
  );
}