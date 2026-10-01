import pg from "pg";
import { promises as dns } from "node:dns";
import type { FastifyInstance } from "fastify";
import { LocalEncryptedSecretStore, PgBacking } from "@quietgrowth/secrets";
import { buildWorkerDeps, runTick } from "@quietgrowth/worker/lib";
import { buildApp } from "./app.js";
import { secretsEqual } from "./auth.js";

/**
 * Production composition root, shared by every host: the standalone server (`server.ts`) and the single-project
 * Vercel deployment, where the Next.js app mounts this instance under /api.
 *
 * - Postgres: tiny pool by default (`PG_POOL_MAX`, 3). On serverless every concurrent instance holds its own
 *   connections, so point DATABASE_URL at a pooled (transaction-mode) endpoint; tenant isolation uses SET LOCAL inside
 *   transactions, which transaction pooling supports.
 * - Background work without a queue: `GET /cron/tick` (bearer CRON_SECRET, as sent by Vercel Cron) runs the same
 *   idempotent handlers as the BullMQ worker within a time budget.
 */
export interface ProductionApp { app: FastifyInstance; pool: pg.Pool }

const need = (env: Record<string, string | undefined>, k: string): string => { const v = env[k]; if (!v) throw new Error(`${k} is required`); return v; };

export async function createProductionApp(env: Record<string, string | undefined> = process.env): Promise<ProductionApp> {
  const pool = new pg.Pool({ connectionString: need(env, "DATABASE_URL"), max: Number(env.PG_POOL_MAX ?? 3), idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
  try {
    const app = await buildApp({
      adminPool: pool, pool,
      sessionSecret: need(env, "SESSION_SECRET"), internalSecret: need(env, "INTERNAL_SECRET"), authSecret: need(env, "ACTION_AUTH_SECRET"),
      secrets: new LocalEncryptedSecretStore(need(env, "SECRET_MASTER_KEY"), new PgBacking(pool)),
      resolver: async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address),
      fetchImpl: async (url) => { const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8_000) }); return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: await r.text() }; },
      // Repo/email executors need per-organisation connector wiring; until supplied they fail closed (STATUS.md).
      executor: { execute: async () => { throw new Error("executor not configured in this process"); } },
      verifier: { verify: async () => ({ ok: false, checks: [{ name: "verifier_not_configured", ok: false }] }) },
      outcomes: { evaluate: async () => ({ label: "observational", summary: {}, guardrailsHeld: true }) },
      scopeFor: (a) => `action:${a.id}`,
      logger: env.QG_LOG === "0" ? false : true,
    });

    const cronSecret = env.CRON_SECRET ?? "";
    app.get("/cron/tick", async (req, reply) => {
      const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (cronSecret.length < 24 || !t || !secretsEqual(t, cronSecret)) return reply.code(401).send({ error: "unauthorized" });
      const orgs = (await pool.query("SELECT id FROM organizations ORDER BY id")).rows.map((r) => r.id as string);
      return runTick(buildWorkerDeps(env, pool), orgs, Number(env.TICK_BUDGET_MS ?? 45_000));
    });

    await app.ready();
    return { app, pool };
  } catch (e) { await pool.end().catch(() => undefined); throw e; }
}
