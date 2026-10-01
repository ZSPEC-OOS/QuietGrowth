import type { Pool } from "pg";
import { LocalEncryptedSecretStore, PgBacking } from "@quietgrowth/secrets";
import { fetchClient } from "@quietgrowth/connectors-core";
import { loadReadiness } from "@quietgrowth/growth-engine";
import { buildSources } from "./sources.js";
import { CompositeExecutor, CompositeVerifier, LifecycleVerifier, scopeFor } from "./executors.js";
import type { WorkerDeps } from "./ports.js";

/**
 * Production wiring shared by the long-running worker and the serverless cron entrypoint.
 * Executors that need per-org connector construction fail closed until a deployment supplies them:
 * nothing is mutated and every attempt is recorded as a failed action.
 */
export function buildWorkerDeps(env: Record<string, string | undefined>, pool: Pool): WorkerDeps {
  const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`${k} is required`); return v; };
  const secrets = new LocalEncryptedSecretStore(need("SECRET_MASTER_KEY"), new PgBacking(pool));
  const notConfigured = { execute: async (): Promise<never> => { throw new Error("executor not configured for this deployment"); } };
  return {
    pool, now: Date.now, authSecret: need("ACTION_AUTH_SECRET"),
    sources: buildSources({ pool, secrets, http: fetchClient, now: Date.now }),
    drafter: { draft: async () => null },
    executor: new CompositeExecutor(notConfigured, notConfigured),
    verifier: new CompositeVerifier({ verify: async () => ({ ok: false, checks: [{ name: "seo_verifier_not_configured", ok: false }] }) }, new LifecycleVerifier()),
    outcomes: { evaluate: async () => ({ label: "observational", summary: {}, guardrailsHeld: true }) },
    scopeFor, observationDays: 14, maxProposalsPerTick: 3,
    readiness: (c, orgId) => loadReadiness(c, orgId, { now: Date.now, runtimeAttested: env.RUNTIME_ATTESTED === "1", verifierAvailable: false }),
  };
}
