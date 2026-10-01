import { withOrg } from "@quietgrowth/database";
import { detectAndPropose, evaluateDue, executeReady, reconcileBilling } from "./handlers.js";
import { evaluateExperiments } from "./experiments.js";
import { lifecycleTick } from "./lifecycle.js";
import type { WorkerDeps } from "./ports.js";

export type JobName = "detect_and_propose" | "execute_ready" | "evaluate_due" | "reconcile_billing" | "evaluate_experiments" | "lifecycle_tick";

const weekOf = (ms: number): string => { const d = new Date(ms); const j = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return `${d.getUTCFullYear()}-W${String(Math.ceil(((+d - +j) / 86400000 + j.getUTCDay() + 1) / 7)).padStart(2, "0")}`; };

/** Suspended tenants (admin action or lapsed plan) get no background work at all. */
export async function tenantActive(d: WorkerDeps, orgId: string): Promise<boolean> {
  const r = await withOrg(d.pool, orgId, (c) => c.query("SELECT status FROM subscriptions WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1", [orgId]));
  return (r.rows[0]?.status ?? "active") === "active";
}

export const handlerFor = (d: WorkerDeps): Record<JobName, (orgId: string) => Promise<unknown>> => {
  const raw: Record<JobName, (orgId: string) => Promise<unknown>> = {
    detect_and_propose: (o) => detectAndPropose(d, o),
    execute_ready: (o) => executeReady(d, o),
    evaluate_due: (o) => evaluateDue(d, o),
    reconcile_billing: (o) => reconcileBilling(d, o),
    evaluate_experiments: (o) => evaluateExperiments(d, o),
    lifecycle_tick: (o) => lifecycleTick(d, o, weekOf(d.now())),
  };
  return Object.fromEntries(Object.entries(raw).map(([k, f]) => [k, async (o: string) => ((await tenantActive(d, o)) ? f(o) : { skipped: "tenant_suspended" })])) as typeof raw;
};

