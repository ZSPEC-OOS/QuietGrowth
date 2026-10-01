import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const API_URL = process.env.API_URL ?? "http://127.0.0.1:3001";
export const COOKIE = "qg_session";

export class ApiError extends Error { constructor(readonly status: number, message: string, readonly body?: unknown) { super(message); } }

async function token(): Promise<string | undefined> { return (await cookies()).get(COOKIE)?.value; }

/** Server-side API call with the session token from the httpOnly cookie. The browser never sees the token. */
export async function api<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const t = await token();
  if (!t) redirect("/login");
  const res = await fetch(`${API_URL}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body), cache: "no-store" });
  if (res.status === 401) redirect("/login");
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string; message?: string })?.message ?? (json as { error?: string })?.error ?? `API ${res.status}`, json);
  return json as T;
}

export async function apiOrNull<T>(path: string): Promise<T | null> {
  try { return await api<T>(path); } catch (e) { if (e instanceof ApiError && e.status !== 401) return null; throw e; }
}
