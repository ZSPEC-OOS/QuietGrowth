"use client";
import { useActionState } from "react";
import { savePolicy } from "./actions";
export function PolicyForm({ maxModel, maxPerDay }: { maxModel: number; maxPerDay: number }) {
  const [s, action, pending] = useActionState(savePolicy, undefined);
  return (
    <form action={action} className="stack card">
      <label>Monthly model-cost cap (USD)<input name="maxModelSpendUsd" type="number" min={0} step="1" defaultValue={maxModel} required /></label>
      <label>Max automatic actions per day, per type<input name="maxActionsPerDay" type="number" min={0} step="1" defaultValue={maxPerDay} required /></label>
      <p className="sub">External spend is fixed at $0 in Zero-Spend mode. Saving creates a new policy version and voids pending approvals.</p>
      {s?.error && <div className="err" role="alert">{s.error}</div>}{s?.ok && <div role="status">Policy saved.</div>}
      <button className="primary" disabled={pending}>{pending ? "Saving…" : "Save policy"}</button>
    </form>
  );
}
