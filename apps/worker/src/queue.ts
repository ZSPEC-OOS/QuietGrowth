import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { WorkerDeps } from "./ports.js";
import { detectAndPropose, evaluateDue, executeReady, reconcileBilling } from "./handlers.js";

export const QUEUE = "quietgrowth-jobs";
export type JobName = "detect_and_propose" | "execute_ready" | "evaluate_due" | "reconcile_billing";
export interface JobData { orgId: string }

export const handlerFor = (d: WorkerDeps): Record<JobName, (orgId: string) => Promise<unknown>> => ({
  detect_and_propose: (o) => detectAndPropose(d, o),
  execute_ready: (o) => executeReady(d, o),
  evaluate_due: (o) => evaluateDue(d, o),
  reconcile_billing: (o) => reconcileBilling(d, o),
});

/** BullMQ wiring: retries with backoff, per-org+job dedupe so repeated ticks cannot stack. */
export function createQueue(connection: Redis): Queue<JobData, unknown, JobName> {
  return new Queue(QUEUE, { connection, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 } });
}
export async function enqueueTick(q: Queue<JobData, unknown, JobName>, orgIds: string[], bucket: string): Promise<number> {
  const names: JobName[] = ["reconcile_billing", "detect_and_propose", "execute_ready", "evaluate_due"];
  let n = 0;
  for (const orgId of orgIds) for (const name of names) { await q.add(name, { orgId }, { jobId: `${name}:${orgId}:${bucket}` }); n++; }
  return n;
}
export function createWorker(connection: Redis, d: WorkerDeps, concurrency = 4): Worker<JobData, unknown, JobName> {
  const h = handlerFor(d);
  return new Worker<JobData, unknown, JobName>(QUEUE, async (job: Job<JobData, unknown, JobName>) => h[job.name](job.data.orgId), { connection, concurrency });
}
