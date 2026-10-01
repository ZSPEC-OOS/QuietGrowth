"use client";
import { useActionState } from "react";
import { connect } from "./actions";
export function ConnectForm() {
  const [s, action, pending] = useActionState(connect, undefined);
  return (
    <form action={action} className="stack card" autoComplete="off">
      <label>Provider<select name="provider" defaultValue="deepseek">{["deepseek", "stripe", "ga4", "gsc", "github", "email", "google_ads"].map((p) => <option key={p}>{p}</option>)}</select></label>
      <label>Credential<input name="credential" type="password" required autoComplete="off" /></label>
      <p className="sub">Stored encrypted by reference. It is never shown again and never sent to agents.</p>
      {s?.error && <div className="err" role="alert">{s.error}</div>}{s?.ok && <div role="status">{s.ok}</div>}
      <button className="primary" disabled={pending}>{pending ? "Connecting…" : "Connect"}</button>
    </form>
  );
}
