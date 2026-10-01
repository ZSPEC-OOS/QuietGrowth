import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Redis } from "ioredis";
import { fileURLToPath } from "node:url";
import { migrate, withOrg } from "@quietgrowth/database";
import { ingestEvents } from "@quietgrowth/connector-product-events";
import type { GscRow } from "@quietgrowth/connector-gsc";
import type { RevenueEvent } from "@quietgrowth/connector-billing";
import { RuleBasedSeoDrafter, createQueue, handlerFor, detectAndPropose, enqueueTick, evaluateDue, executeReady, reconcileBilling, type WorkerDeps } from "./index.js";

const url = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const schema = `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const repo = { owner: "o", repo: "r", baseBranch: "main" };
const gsc: GscRow[] = [
  { query: "best crm", page: "https://x.com/crm", clicks: 2, impressions: 4000, ctr: 0.0005, position: 3 },
  { query: "crm tool", page: "https://x.com/tool", clicks: 5, impressions: 900, ctr: 0.005, position: 5 },
];

describe.skipIf(!url)("worker handlers (postgres)", () => {
  let pool: pg.Pool; let orgA = ""; let orgB = ""; let now = Date.parse("2026-10-01T00:00:00Z");
  let executed = 0; let failExec = false;
  const mk = (): WorkerDeps => ({
    pool, now: () => now, authSecret: "s", observationDays: 14, maxProposalsPerTick: 5,
    sources: { gscRows: async () => gsc, billingEvents: async () => billing, plgFacts: async () => null },
    drafter: new RuleBasedSeoDrafter(async () => repo, (u) => (u.endsWith("/crm") ? "content/crm.html" : null), (q) => `${q} - Acme`),
    executor: { execute: async () => { if (failExec) throw new Error("boom"); executed++; return { provider: "github", resourceId: "5", idempotencyKey: "k", at: now }; } },
    verifier: { verify: async () => ({ ok: true, checks: [{ name: "pr", ok: true }] }) },
    outcomes: { evaluate: async () => ({ label: "observational", summary: { signupsDelta: 2 }, guardrailsHeld: true }) },
    scopeFor: (a) => `action:${a.id}`,
    readiness: async () => ({ ready: true, rows: [], blocking: [] }),
  });
  const billing: RevenueEvent[] = [
    { providerEventId: "e1", kind: "subscription_started", customerId: "c1", subscriptionId: "s1", amountCents: 0, occurredAt: 1_000, mrrCents: 2900, plan: "pro" },
    { providerEventId: "e2", kind: "subscription_cancelled", customerId: "c1", subscriptionId: "s1", amountCents: 0, occurredAt: 2_000 },
    { providerEventId: "e3", kind: "subscription_started", customerId: "c2", subscriptionId: "s2", amountCents: 0, occurredAt: 3_000, mrrCents: 4900, plan: "team" },
  ];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool, fileURLToPath(new URL("../../../packages/database/migrations", import.meta.url)));
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO qg_app`);
    orgA = (await pool.query("INSERT INTO organizations (name) VALUES ('A') RETURNING id")).rows[0].id;
    orgB = (await pool.query("INSERT INTO organizations (name) VALUES ('B') RETURNING id")).rows[0].id;
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });

  it("detects, proposes only drafted opportunities, auto-approves low-risk metadata changes", async () => {
    const r = await detectAndPropose(mk(), orgA);
    expect(r.detected).toBeGreaterThanOrEqual(2);
    expect(r).toMatchObject({ proposed: 1, autoApproved: 1, blocked: 0 }); // only /crm maps to a file
    const rows = (await pool.query("SELECT type, status, payload FROM actions WHERE organization_id=$1", [orgA])).rows;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ type: "metadata_change", status: "AUTO_APPROVED" });
    expect(rows[0].payload.operation.title).toBe("best crm - Acme");
  });

  it("is idempotent: a second tick creates no duplicate opportunities or actions", async () => {
    const before = (await pool.query("SELECT count(*)::int n FROM opportunities WHERE organization_id=$1", [orgA])).rows[0].n;
    const r = await detectAndPropose(mk(), orgA);
    expect(r.proposed).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM opportunities WHERE organization_id=$1", [orgA])).rows[0].n).toBe(before);
    expect((await pool.query("SELECT count(*)::int n FROM actions WHERE organization_id=$1", [orgA])).rows[0].n).toBe(1);
  });

  it("tenants are isolated: org B gets its own actions, none of A's", async () => {
    await detectAndPropose(mk(), orgB);
    expect((await pool.query("SELECT count(*)::int n FROM actions WHERE organization_id=$1", [orgB])).rows[0].n).toBe(1);
    expect((await withOrg(pool, orgB, (c) => c.query("SELECT 1 FROM actions WHERE organization_id=$1", [orgA]))).rowCount).toBe(0);
  });

  it("executes ready actions, verifies, and moves them to OBSERVING; evaluates only after the window", async () => {
    const r = await executeReady(mk(), orgA);
    expect(r).toMatchObject({ ran: 1, succeeded: 1, failed: 0 }); expect(executed).toBe(1);
    expect((await pool.query("SELECT status FROM actions WHERE organization_id=$1", [orgA])).rows[0].status).toBe("OBSERVING");
    expect((await evaluateDue(mk(), orgA)).evaluated).toBe(0);
    now += 15 * 86_400_000;
    expect((await evaluateDue(mk(), orgA)).evaluated).toBe(1);
    expect((await pool.query("SELECT status FROM actions WHERE organization_id=$1", [orgA])).rows[0].status).toBe("EVALUATED");
  });

  it("blocks all writes until the Appendix B readiness checklist passes", async () => {
    const org = (await pool.query("INSERT INTO organizations (name) VALUES ('NR') RETURNING id")).rows[0].id;
    await detectAndPropose(mk(), org);
    const before = executed;
    const r = await executeReady({ ...mk(), readiness: async () => ({ ready: false, rows: [], blocking: ["Billing"] }) }, org);
    expect(r).toMatchObject({ ran: 0, notReady: ["Billing"] }); expect(executed).toBe(before);
    expect((await pool.query("SELECT status FROM actions WHERE organization_id=$1", [org])).rows[0].status).toBe("AUTO_APPROVED");
  });

  it("executor failures are recorded as FAILED and do not stop the batch", async () => {
    failExec = true;
    const r = await executeReady(mk(), orgB);
    expect(r).toMatchObject({ ran: 1, failed: 1 });
    expect((await pool.query("SELECT status FROM actions WHERE organization_id=$1", [orgB])).rows[0].status).toBe("FAILED");
    failExec = false;
  });

  it("pauses all background AI work when the model cap is reached", async () => {
    await pool.query("INSERT INTO model_usage (organization_id, rate_version, cached_input_tokens, uncached_input_tokens, output_tokens, cost_usd, at) VALUES ($1,'t',0,0,0,60,to_timestamp($2/1000.0))", [orgA, now]);
    const r = await detectAndPropose(mk(), orgA);
    expect(r.paused).toBe(true); expect(r.proposed).toBe(0);
    expect((await executeReady(mk(), orgA)).paused).toBe(true);
  });

  it("billing reconcile is idempotent and converges to correct MRR", async () => {
    await reconcileBilling(mk(), orgA); const r = await reconcileBilling(mk(), orgA);
    expect(r.subscriptions).toBe(2);
    const rows = (await pool.query("SELECT external_id, status, mrr_cents FROM subscriptions_observed WHERE organization_id=$1 ORDER BY external_id", [orgA])).rows;
    expect(rows.map((x) => [x.status, Number(x.mrr_cents)])).toEqual([["cancelled", 0], ["active", 4900]]);
    expect((await pool.query("SELECT count(*)::int n FROM revenue_events WHERE organization_id=$1", [orgA])).rows[0].n).toBe(3);
  });

  it("funnel bottleneck opportunities appear only when instrumentation is complete and reliable", async () => {
    const org = (await pool.query("INSERT INTO organizations (name) VALUES ('C') RETURNING id")).rows[0].id;
    const prod = (await pool.query("INSERT INTO products (organization_id, name, primary_url) VALUES ($1,'p','https://p') RETURNING id", [org])).rows[0].id;
    await pool.query("INSERT INTO funnel_definitions (organization_id, product_id, version, definition, active) VALUES ($1,$2,1,$3,true)", [org, prod, { events: { signup: "signup", activation: "activated", paid: "paid", retention: "active", churn: "cancel" }, retentionWindowDays: 30, billingSourceConnected: true }]);
    const noGsc = { ...mk(), sources: { ...mk().sources, gscRows: async () => null } };
    expect((await detectAndPropose(noGsc, org)).detected).toBe(0); // no events yet: nothing observed => unreliable
    const events: any[] = [];
    for (let i = 0; i < 100; i++) { events.push({ userId: `u${i}`, event: "landing_view", timestamp: "2026-09-20T00:00:00Z" }, { userId: `u${i}`, event: "signup", timestamp: "2026-09-21T00:00:00Z" }); if (i < 10) events.push({ userId: `u${i}`, event: "activated", timestamp: "2026-09-22T00:00:00Z" }); if (i < 5) events.push({ userId: `u${i}`, event: "paid", timestamp: "2026-09-23T00:00:00Z" }); }
    await withOrg(pool, org, (c) => ingestEvents(c, org, events));
    const r = await detectAndPropose(noGsc, org);
    expect(r.detected).toBeGreaterThan(0);
    const top = (await pool.query("SELECT kind FROM opportunities WHERE organization_id=$1 ORDER BY score DESC LIMIT 1", [org])).rows[0];
    expect(top.kind).toBe("activation_bottleneck");
  });
});

describe.skipIf(!redisUrl)("BullMQ wiring (redis)", () => {
  it("dedupes repeated ticks within a bucket and processes one job per org+job", async () => {
    const conn = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    await conn.flushdb();
    const q = createQueue(conn);
    const calls: string[] = [];
    const { Worker } = await import("bullmq");
    const w = new Worker("quietgrowth-jobs", async (job) => { calls.push(`${job.name}:${job.data.orgId}`); }, { connection: new Redis(redisUrl!, { maxRetriesPerRequest: null }) });
    await enqueueTick(q, ["o1", "o2"], "b1");
    await enqueueTick(q, ["o1", "o2"], "b1"); // same bucket: deduped by jobId
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (calls.length >= 12) { clearInterval(t); resolve(); } }, 50); setTimeout(() => { clearInterval(t); resolve(); }, 5000); });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(12);
    expect(new Set(calls).size).toBe(12);
    await w.close(); await q.close(); await conn.quit();
  });
  it("handlerFor maps every job name to a handler", () => {
    expect(Object.keys(handlerFor({} as WorkerDeps)).sort()).toEqual(["detect_and_propose", "evaluate_due", "evaluate_experiments", "execute_ready", "lifecycle_tick", "reconcile_billing"]);
  });
});
