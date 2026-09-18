import type { UserCapability, UserProfile } from "../../shared/types";

export type CurrentUser = UserProfile;

export interface CurrentSession {
  user: UserProfile;
  capabilities: UserCapability[];
}

type SessionListener = (session: CurrentSession | null) => void;
type AccessDeniedListener = (message: string) => void;

const sessionListeners = new Set<SessionListener>();
const deniedListeners = new Set<AccessDeniedListener>();
let currentSession: CurrentSession | null = null;

export function getCurrentSession(): CurrentSession | null {
  return currentSession;
}

export function setSession(session: CurrentSession | null) {
  currentSession = session;
  for (const listener of sessionListeners) listener(session);
}

/** Broadcasts a session loss (401) so privileged UI state can be cleared. */
export function notifyAuthLost() {
  if (currentSession !== null) setSession(null);
}

/** Broadcasts a server-side authorization denial (403) without ending the session. */
export function notifyAccessDenied(message: string) {
  for (const listener of deniedListeners) listener(message);
}

export function subscribeSession(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

export function subscribeAccessDenied(listener: AccessDeniedListener): () => void {
  deniedListeners.add(listener);
  return () => {
    deniedListeners.delete(listener);
  };
}

export function sessionCan(session: CurrentSession | null, capability: UserCapability): boolean {
  return session?.capabilities?.includes(capability) ?? false;
}