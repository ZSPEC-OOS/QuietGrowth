import { handlerFor, type JobName } from "./queue.js";
import type { WorkerDeps } from "./ports.js";

export const TICK_JOBS: JobName[] = ["reconcile_billing", "detect_and_propose", "lifecycle_tick", "execute_ready", "evaluate_experiments", "evaluate_due"];

export interface TickResult { orgs: number; jobsRun: number; errors: { orgId: string; job: string; error: string }[]; truncated: boolean }

/**
 * Queue-free tick for serverless hosts (cron-triggered). Runs the same handlers as the BullMQ worker, sequentially,
 * and stops starting new work once the time budget is spent; the next invocation resumes from the top.
 * Handlers are idempotent, so partial ticks are safe. A failing job never blocks the remaining ones.
 */
export async function runTick(d: WorkerDeps, orgIds: string[], budgetMs: number, clock: () => number = Date.now): Promise<TickResult> {
  const start = clock(); const h = handlerFor(d);
  const res: TickResult = { orgs: 0, jobsRun: 0, errors: [], truncated: false };
  for (const orgId of orgIds) {
    if (clock() - start >= budgetMs) { res.truncated = true; break; }
    res.orgs++;
    for (const job of TICK_JOBS) {
      if (clock() - start >= budgetMs) { res.truncated = true; break; }
      try { await h[job](orgId); res.jobsRun++; }
      catch (e) { res.errors.push({ orgId, job, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  return res;
}
