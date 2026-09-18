import { useEffect, useState } from "react";
import { fetchAuthStatus, fetchMe } from "./auth-api";
import { setSession, subscribeSession, type CurrentSession } from "./session";

export type SessionState =
  | { status: "loading" }
  | { status: "signedIn"; session: CurrentSession }
  | { status: "signedOut"; hasAdmin: boolean };

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const { user, capabilities } = await fetchMe();
        if (cancelled) return;
        if (user) {
          setSession({ user, capabilities });
          setState({ status: "signedIn", session: { user, capabilities } });
          return;
        }
        const { hasAdmin } = await fetchAuthStatus();
        if (cancelled) return;
        setState({ status: "signedOut", hasAdmin });
      } catch {
        if (cancelled) return;
        setState({ status: "signedOut", hasAdmin: false });
      }
    };
    void check();

    const unsubscribe = subscribeSession((session) => {
      if (cancelled) return;
      if (session) {
        setState({ status: "signedIn", session });
      } else {
        setState((current) => current.status === "signedIn"
          ? { status: "signedOut", hasAdmin: false }
          : current);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}