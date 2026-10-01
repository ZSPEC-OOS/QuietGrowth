import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { backend } from "@/server/backend";

export const COOKIE = "qg_session";

export class ApiError extends Error { constructor(readonly status: number, message: string, readonly body?: unknown) { super(message); } }

async function token(): Promise<string | undefined> { return (await cookies()).get(COOKIE)?.value; }

/** Server-side API call with the session token from the httpOnly cookie. The browser never sees the token. */
export async function api<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const t = await token();
  if (!t) redirect("/login");
  const res = await backend({ method: init.method ?? "GET", path, headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  if (res.status === 401) redirect("/login");
  const json = res.text ? JSON.parse(res.text) : null;
  const ok = res.status >= 200 && res.status < 300;
  if (!ok) throw new ApiError(res.status, (json as { error?: string; message?: string })?.message ?? (json as { error?: string })?.error ?? `API ${res.status}`, json);
  return json as T;
}

export async function apiOrNull<T>(path: string): Promise<T | null> {
  try { return await api<T>(path); } catch (e) { if (e instanceof ApiError && e.status !== 401) return null; throw e; }
}
