"use client";
import { useActionState, useState } from "react";
import { authenticate } from "./actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(authenticate, undefined);
  const [mode, setMode] = useState<"login" | "signup">("login");
  return (
    <div className="login">
      <div className="brand">Quiet<b style={{ color: "var(--red-600)" }}>Growth</b></div>
      <p className="sub">Controlled automation for SaaS growth.</p>
      <form action={action} className="stack card">
        <input type="hidden" name="mode" value={mode} />
        {mode === "signup" && <label>Organization<input name="orgName" required maxLength={100} autoComplete="organization" /></label>}
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <label>Password<input name="password" type="password" required minLength={10} autoComplete={mode === "signup" ? "new-password" : "current-password"} /></label>
        {state?.error && <div className="err" role="alert">{state.error}</div>}
        <button className="primary" disabled={pending}>{pending ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}</button>
        <button type="button" className="ghost" onClick={() => setMode(mode === "login" ? "signup" : "login")}>{mode === "login" ? "Create an account" : "I already have an account"}</button>
      </form>
    </div>
  );
}
