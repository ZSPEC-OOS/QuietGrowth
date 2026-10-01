import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { WorkerDeps } from "./ports.js";
import { handlerFor, type JobName } from "./jobs.js";

export const QUEUE = "quietgrowth-jobs";
export interface JobData { orgId: string }

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
