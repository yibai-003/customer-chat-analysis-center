import { api } from "../api";
import type { CurrentSession, CurrentUser } from "./session";
import type { UserCapability } from "../../shared/types";

export interface AuthStatus {
  hasAdmin: boolean;
}

export interface AuthMe {
  user: CurrentUser | null;
  capabilities: UserCapability[];
}

export async function fetchMe(): Promise<AuthMe> {
  return api<AuthMe>("/api/auth/me");
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  return api<AuthStatus>("/api/auth/status");
}

export async function loginRequest(username: string, password: string): Promise<CurrentSession> {
  return api<CurrentSession>("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export async function logoutRequest(): Promise<boolean> {
  return api<boolean>("/api/auth/logout", { method: "POST" });
}