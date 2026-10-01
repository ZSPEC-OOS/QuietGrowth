import pg from "pg";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as dns } from "node:dns";
import { LocalEncryptedSecretStore, PgBacking } from "@quietgrowth/secrets";
import { buildWorkerDeps, runTick } from "@quietgrowth/worker";
import { buildApp } from "./app.js";
import { secretsEqual } from "./auth.js";

/**
 * Vercel serverless entrypoint (Node runtime). One Fastify instance per warm container.
 *
 * - Postgres: use a pooled (transaction-mode) connection string; the pool is deliberately tiny because every
 *   concurrent invocation holds its own connections. Tenant isolation uses SET LOCAL inside transactions, which is
 *   compatible with transaction pooling.
 * - Background work: Vercel has no long-running processes, so Vercel Cron calls GET /cron/tick (authenticated with
 *   CRON_SECRET). It runs the same idempotent handlers as the BullMQ worker, within a time budget.
 */
const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };

async function init() {
  const pool = new pg.Pool({
    connectionString: need("DATABASE_URL"), max: Number(process.env.PG_POOL_MAX ?? 3),
    idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000,
  });
  const app = await buildApp({
    adminPool: pool, pool,
    sessionSecret: need("SESSION_SECRET"), internalSecret: need("INTERNAL_SECRET"), authSecret: need("ACTION_AUTH_SECRET"),
    secrets: new LocalEncryptedSecretStore(need("SECRET_MASTER_KEY"), new PgBacking(pool)),
    resolver: async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address),
    fetchImpl: async (url) => { const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8_000) }); return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: await r.text() }; },
    executor: { execute: async () => { throw new Error("executor not configured in API process"); } },
    verifier: { verify: async () => ({ ok: false, checks: [{ name: "verifier_not_configured", ok: false }] }) },
    outcomes: { evaluate: async () => ({ label: "observational", summary: {}, guardrailsHeld: true }) },
    scopeFor: (a) => `action:${a.id}`,
    logger: true,
  });

  const cronSecret = process.env.CRON_SECRET ?? "";
  app.get("/cron/tick", async (req, reply) => {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (cronSecret.length < 24 || !t || !secretsEqual(t, cronSecret)) return reply.code(401).send({ error: "unauthorized" });
    const orgs = (await pool.query("SELECT id FROM organizations ORDER BY id")).rows.map((r) => r.id as string);
    return runTick(buildWorkerDeps(process.env, pool), orgs, Number(process.env.TICK_BUDGET_MS ?? 45_000));
  });

  await app.ready();
  return app;
}

let booted: ReturnType<typeof init> | undefined;
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const app = await (booted ??= init().catch((e) => { booted = undefined; throw e; })); // a failed boot is retried, not cached
    app.server.emit("request", req, res);
  } catch (e) {
    console.error("boot failed", e instanceof Error ? e.message : e); // never leak configuration details to the client
    res.statusCode = 503; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "service_unavailable" }));
  }
}
