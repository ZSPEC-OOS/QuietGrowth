import pg from "pg";
import { Redis } from "ioredis";
import { LocalEncryptedSecretStore, PgBacking } from "@quietgrowth/secrets";
import { fetchClient, type HttpClient } from "@quietgrowth/connectors-core";
import { loadReadiness } from "@quietgrowth/growth-engine";
import { createQueue, createWorker, enqueueTick } from "./queue.js";
import { buildSources } from "./sources.js";
import { CompositeExecutor, CompositeVerifier, LifecycleVerifier, scopeFor } from "./executors.js";
import type { WorkerDeps } from "./ports.js";

const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };

const pool = new pg.Pool({ connectionString: need("DATABASE_URL") });
const redis = new Redis(need("REDIS_URL"), { maxRetriesPerRequest: null });
const secrets = new LocalEncryptedSecretStore(need("SECRET_MASTER_KEY"), new PgBacking(pool));
const http: HttpClient = fetchClient;

// Executors for repo/email writes need per-org connector construction (credentials by reference). Until a deployment
// supplies them, these fail closed: nothing is mutated and every attempt is recorded as a failed action.
const notConfigured = { execute: async (): Promise<never> => { throw new Error("executor not configured for this deployment"); } };
const deps: WorkerDeps = {
  pool, now: Date.now, authSecret: need("ACTION_AUTH_SECRET"),
  sources: buildSources({ pool, secrets, http, now: Date.now }),
  drafter: { draft: async () => null },
  executor: new CompositeExecutor(notConfigured, notConfigured),
  verifier: new CompositeVerifier({ verify: async () => ({ ok: false, checks: [{ name: "seo_verifier_not_configured", ok: false }] }) }, new LifecycleVerifier()),
  outcomes: { evaluate: async () => ({ label: "observational", summary: {}, guardrailsHeld: true }) },
  scopeFor, observationDays: 14, maxProposalsPerTick: 3,
  readiness: (c, orgId) => loadReadiness(c, orgId, { now: Date.now, runtimeAttested: process.env.RUNTIME_ATTESTED === "1", verifierAvailable: false }),
};
createWorker(redis, deps);
const queue = createQueue(redis);
const tick = async () => {
  const orgs = (await pool.query("SELECT id FROM organizations")).rows.map((r) => r.id as string);
  await enqueueTick(queue, orgs, String(Math.floor(Date.now() / (15 * 60_000))));
};
await tick();
setInterval(() => void tick().catch((e) => console.error("tick failed", e)), 15 * 60_000);
