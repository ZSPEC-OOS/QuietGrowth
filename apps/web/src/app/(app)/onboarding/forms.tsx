"use client";
import { useActionState } from "react";
import { analyze, defineFunnel } from "./actions";

export function AnalyzeForm() {
  const [s, a, p] = useActionState(analyze, undefined);
  return (<form action={a} className="stack card"><label>Product URL<input name="url" type="url" required placeholder="https://your-saas.com" /></label>{s?.error && <div className="err" role="alert">{s.error}</div>}<button className="primary" disabled={p}>{p ? "Analysing…" : "Analyse my product"}</button></form>);
}
export function FunnelForm() {
  const [s, a, p] = useActionState(defineFunnel, undefined);
  return (
    <form action={a} className="stack card">
      <label>Signup event<input name="signupEvent" required placeholder="account_created" /></label>
      <label>Activation (value) event<input name="activationEvent" required placeholder="first_project" /></label>
      <label>Paid conversion event<input name="primaryConversion" required placeholder="subscription_started" /></label>
      <label>Retention event (optional)<input name="retentionEvent" placeholder="core_action_completed" /></label>
      <label>Churn event (optional)<input name="churnEvent" placeholder="subscription_cancelled" /></label>
      <label>Retention window (days)<input name="retentionWindowDays" type="number" min={1} defaultValue={30} required /></label>
      <label>Billing source<select name="billingSource" defaultValue="stripe"><option>stripe</option><option>paddle</option><option>chargebee</option></select></label>
      <label>Guardrails (comma separated)<input name="guardrails" required defaultValue="refund_rate, churn" /></label>
      {s?.errors && <ul className="err">{s.errors.map((e) => <li key={e}>{e}</li>)}</ul>}{s?.error && <div className="err" role="alert">{s.error}</div>}
      <button className="primary" disabled={p}>Save funnel</button>
    </form>
  );
}
