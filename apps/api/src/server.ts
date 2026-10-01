import pg from "pg";
import { LocalEncryptedSecretStore, PgBacking } from "@quietgrowth/secrets";
import { promises as dns } from "node:dns";
import { buildApp } from "./app.js";

const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };

const adminPool = new pg.Pool({ connectionString: need("DATABASE_URL") });
const app = await buildApp({
  adminPool, pool: adminPool,
  sessionSecret: need("SESSION_SECRET"), internalSecret: need("INTERNAL_SECRET"), authSecret: need("ACTION_AUTH_SECRET"),
  secrets: new LocalEncryptedSecretStore(need("SECRET_MASTER_KEY"), new PgBacking(adminPool)),
  resolver: async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address),
  fetchImpl: async (url) => { const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) }); return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: await r.text() }; },
  // Real connectors are wired by the worker deployment; the API only drives approvals and queues.
  executor: { execute: async () => { throw new Error("executor not configured in API process"); } },
  verifier: { verify: async () => ({ ok: false, checks: [{ name: "verifier_not_configured", ok: false }] }) },
  outcomes: { evaluate: async () => ({ label: "observational", summary: {}, guardrailsHeld: true }) },
  scopeFor: (a) => `action:${a.id}`,
  logger: true,
});
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3001) });
