import pg from "pg";
import { Redis } from "ioredis";
import { createQueue, createWorker, enqueueTick } from "./queue.js";
import type { WorkerDeps } from "./ports.js";

const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };

// Connector wiring (GSC/Stripe/GitHub per org, credentials from the secret store) is configured per deployment.
// This entrypoint fails closed: with no sources/executor configured it neither proposes nor mutates anything.
const pool = new pg.Pool({ connectionString: need("DATABASE_URL") });
const redis = new Redis(need("REDIS_URL"), { maxRetriesPerRequest: null });
const deps: WorkerDeps = {
  pool, now: Date.now, authSecret: need("ACTION_AUTH_SECRET"),
  sources: { gscRows: async () => null, billingEvents: async () => [], plgFacts: async () => null },
  drafter: { draft: async () => null },
  executor: { execute: async () => { throw new Error("executor not configured"); } },
  verifier: { verify: async () => ({ ok: false, checks: [{ name: "verifier_not_configured", ok: false }] }) },
  outcomes: { evaluate: async () => ({ label: "observational", summary: {}, guardrailsHeld: true }) },
  scopeFor: (a) => `action:${a.id}`, observationDays: 14, maxProposalsPerTick: 3,
};
createWorker(redis, deps);
const queue = createQueue(redis);
const tick = async () => {
  const orgs = (await pool.query("SELECT id FROM organizations")).rows.map((r) => r.id as string);
  await enqueueTick(queue, orgs, String(Math.floor(Date.now() / (15 * 60_000))));
};
await tick();
setInterval(() => void tick().catch((e) => console.error("tick failed", e)), 15 * 60_000);
