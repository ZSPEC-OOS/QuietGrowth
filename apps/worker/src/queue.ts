import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { WorkerDeps } from "./ports.js";
import { detectAndPropose, evaluateDue, executeReady, reconcileBilling } from "./handlers.js";
import { evaluateExperiments } from "./experiments.js";
import { lifecycleTick } from "./lifecycle.js";
import { withOrg } from "@quietgrowth/database";

export const QUEUE = "quietgrowth-jobs";
export type JobName = "detect_and_propose" | "execute_ready" | "evaluate_due" | "reconcile_billing" | "evaluate_experiments" | "lifecycle_tick";
export interface JobData { orgId: string }

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

/** BullMQ wiring: retries with backoff, per-org+job dedupe so repeated ticks cannot stack. */
export function createQueue(connection: Redis): Queue<JobData, unknown, JobName> {
  return new Queue(QUEUE, { connection, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 } });
}
export async function enqueueTick(q: Queue<JobData, unknown, JobName>, orgIds: string[], bucket: string): Promise<number> {
  const names: JobName[] = ["reconcile_billing", "detect_and_propose", "lifecycle_tick", "execute_ready", "evaluate_experiments", "evaluate_due"];
  let n = 0;
  for (const orgId of orgIds) for (const name of names) { await q.add(name, { orgId }, { jobId: `${name}:${orgId}:${bucket}` }); n++; }
  return n;
}
export function createWorker(connection: Redis, d: WorkerDeps, concurrency = 4): Worker<JobData, unknown, JobName> {
  const h = handlerFor(d);
  return new Worker<JobData, unknown, JobName>(QUEUE, async (job: Job<JobData, unknown, JobName>) => h[job.name](job.data.orgId), { connection, concurrency });
}
