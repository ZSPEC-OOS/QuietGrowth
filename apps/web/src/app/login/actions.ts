"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE } from "@/lib/api";
import { backend, isBackendUnavailable } from "@/server/backend";

export async function authenticate(_prev: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
  const mode = form.get("mode") === "signup" ? "signup" : "login";
  const body = { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? ""), ...(mode === "signup" ? { orgName: String(form.get("orgName") ?? "") } : {}) };
  let res;
  try { res = await backend({ method: "POST", path: `/v1/${mode}`, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch (e) { if (isBackendUnavailable(e)) return { error: "The service is temporarily unavailable. Try again shortly." }; throw e; }
  const j = (() => { try { return JSON.parse(res.text) as { token?: string; error?: string }; } catch { return {} as { token?: string; error?: string }; } })();
  if (res.status >= 300 || !j.token) return { error: j.error === "invalid_credentials" ? "Incorrect email or password." : j.error === "email_taken" ? "That email is already registered." : "Could not sign in. Check your details and try again." };
  (await cookies()).set(COOKIE, j.token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 12 * 3600 });
  redirect(mode === "signup" ? "/onboarding" : "/dashboard");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(COOKIE);
  redirect("/login");
}
