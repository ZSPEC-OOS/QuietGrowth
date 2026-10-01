import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { migrate, withOrg } from "@quietgrowth/database";
import { LocalEncryptedSecretStore } from "@quietgrowth/secrets";
import { ingestEvents } from "@quietgrowth/connector-product-events";
import { InMemoryIdempotencyStore, signAuthorization } from "@quietgrowth/policy-engine";
import { EmailConnector } from "@quietgrowth/connector-email";
import type { HttpClient, WriteReceipt } from "@quietgrowth/connectors-core";
import { runTick, TICK_JOBS } from "./tick.js";
import { CompositeExecutor, CompositeVerifier, LifecycleExecutor, LifecycleVerifier, buildSources, evaluateExperiments, handlerFor, lifecycleTick, scopeFor, type WorkerDeps } from "./index.js";

const url = process.env.DATABASE_URL;
const sch = `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!url)("experiments, lifecycle, sources, suspension", () => {
  let pool: pg.Pool; const secrets = new LocalEncryptedSecretStore(LocalEncryptedSecretStore.generateKey());
  let now = Date.parse("2026-10-01T12:00:00Z");
  const base = (): WorkerDeps => ({ pool, now: () => now, authSecret: "s", observationDays: 14, maxProposalsPerTick: 3, readiness: async () => ({ ready: true, rows: [], blocking: [] }),
    sources: { gscRows: async () => null, billingEvents: async () => [], plgFacts: async () => null }, drafter: { draft: async () => null },
    executor: { execute: async () => { throw new Error("n/a"); } }, verifier: { verify: async () => ({ ok: true, checks: [] }) }, outcomes: { evaluate: async () => ({ label: "observational", summary: {}, guardrailsHeld: true }) }, scopeFor });
  const mkOrg = async (name: string) => (await pool.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [name])).rows[0].id as string;
  const funnel = async (org: string) => { const p = (await pool.query("INSERT INTO products (organization_id, name, primary_url) VALUES ($1,'p','https://acme.example') RETURNING id", [org])).rows[0].id; await pool.query("INSERT INTO funnel_definitions (organization_id, product_id, version, definition, active) VALUES ($1,$2,1,$3,true)", [org, p, { events: { signup: "signup", activation: "activated", paid: "paid", churn: "cancel" }, retentionWindowDays: 30, billingSourceConnected: true }]); };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${sch},public` });
    await pool.query(`CREATE SCHEMA ${sch}`);
    await migrate(pool, fileURLToPath(new URL("../../../packages/database/migrations", import.meta.url)));
    await pool.query(`GRANT USAGE ON SCHEMA ${sch} TO qg_app`);
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA ${sch} CASCADE`); await pool.end(); });

  it("experiments: freeze on unhealthy instrumentation; propose winner as an approval-gated action; stop on guardrail; never auto-apply", async () => {
    const org = await mkOrg("X1");
    const spec = { hypothesis: "New onboarding lifts activation", targetCohort: "new", treatment: "t", controlOrBaseline: "c", primaryMetric: "activated", guardrailMetrics: ["refund"], minimumSamplePerVariant: 100, minimumObservationDays: 7, treatmentShare: 0.5, touchesPricingOrEntitlements: false };
    const exp = (await pool.query("INSERT INTO experiments (organization_id, hypothesis, spec, status, start_at) VALUES ($1,$2,$3,'running',$4) RETURNING id", [org, spec.hypothesis, spec, new Date(now - 14 * 86_400_000)])).rows[0].id;
    // no events received recently => frozen
    expect((await evaluateExperiments(base(), org)).decisions).toEqual({ freeze_instrumentation: 1 });
    expect((await pool.query("SELECT status FROM experiments WHERE id=$1", [exp])).rows[0].status).toBe("frozen");

    await pool.query("UPDATE experiments SET status='running', decision=NULL WHERE id=$1", [exp]);
    const evs: any[] = []; const at = new Date(now - 10 * 86_400_000);
    for (let i = 0; i < 1000; i++) {
      const variant = i % 2 === 0 ? "control" : "treatment";
      await pool.query("INSERT INTO experiment_assignments (organization_id, experiment_id, subject_id, variant, assigned_at) VALUES ($1,$2,$3,$4,$5)", [org, exp, `s${i}`, variant, at]);
      const converts = variant === "control" ? i % 20 === 0 : i % 10 === 1 || i % 10 === 3; // 10% vs 40% of subjects
      if (converts) evs.push({ userId: `s${i}`, event: "activated", timestamp: new Date(now - 5 * 86_400_000).toISOString() });
    }
    evs.push({ userId: "fresh", event: "signup", timestamp: new Date(now - 60_000).toISOString() });
    await withOrg(pool, org, (c) => ingestEvents(c, org, evs, now));
    const r = await evaluateExperiments(base(), org);
    expect(r.decisions).toEqual({ propose_winner: 1 });
    const act = (await pool.query("SELECT type, status, rationale FROM actions WHERE organization_id=$1", [org])).rows[0];
    expect(act.type).toBe("onboarding_experiment"); expect(act.status).toBe("NEEDS_APPROVAL"); expect(act.rationale).toContain("needs your approval");
    expect((await pool.query("SELECT status, decision FROM experiments WHERE id=$1", [exp])).rows[0]).toMatchObject({ status: "completed", decision: "propose_winner" });

    // pricing experiment: even a winner is only a pricing_change proposal that needs approval
    const spec2 = { ...spec, touchesPricingOrEntitlements: true, hypothesis: "Raise price" };
    const e2 = (await pool.query("INSERT INTO experiments (organization_id, hypothesis, spec, status, start_at) VALUES ($1,$2,$3,'running',$4) RETURNING id", [org, spec2.hypothesis, spec2, new Date(now - 14 * 86_400_000)])).rows[0].id;
    for (let i = 0; i < 1000; i++) await pool.query("INSERT INTO experiment_assignments (organization_id, experiment_id, subject_id, variant, assigned_at) VALUES ($1,$2,$3,$4,$5)", [org, e2, `s${i}`, i % 2 === 0 ? "control" : "treatment", at]);
    await evaluateExperiments(base(), org);
    expect((await pool.query("SELECT status FROM actions WHERE organization_id=$1 AND type='pricing_change'", [org])).rows[0].status).toBe("NEEDS_APPROVAL");
  });

  it("lifecycle: deterministic segments -> one campaign proposal per sizeable segment, idempotent per week; small segments skipped", async () => {
    const org = await mkOrg("L1"); await funnel(org);
    const ev: any[] = []; const day = 86_400_000;
    for (let i = 0; i < 6; i++) ev.push({ userId: `n${i}`, event: "signup", timestamp: new Date(now - 10 * day).toISOString(), properties: { email: `n${i}@x.com` } }); // not_activated
    for (let i = 0; i < 2; i++) ev.push({ userId: `t${i}`, event: "signup", timestamp: new Date(now - 10 * day).toISOString() }); // too small to message
    for (let i = 0; i < 5; i++) ev.push({ userId: `a${i}`, event: "signup", timestamp: new Date(now - 20 * day).toISOString() }, { userId: `a${i}`, event: "activated", timestamp: new Date(now - 19 * day).toISOString() }); // activated_not_paid
    await withOrg(pool, org, (c) => ingestEvents(c, org, ev, now));
    const r = await lifecycleTick(base(), org, "2026-W40");
    expect(r.segments).toMatchObject({ not_activated: 8, activated_not_paid: 5 }); expect(r.proposed).toBe(2);
    expect((await lifecycleTick(base(), org, "2026-W40")).proposed).toBe(0);
    const rows = (await pool.query("SELECT type, status FROM actions WHERE organization_id=$1", [org])).rows;
    expect(rows.every((x) => x.type === "lifecycle_email_existing_users" && x.status === "AUTO_APPROVED")).toBe(true);
  });

  it("lifecycle executor sends via the connector, honours suppression and caps, and verifies accounting", async () => {
    const org = await mkOrg("L2");
    const ev = ["a", "b", "c"].map((u) => ({ userId: u, event: "signup", timestamp: new Date(now - 1000).toISOString(), properties: { email: `${u}@x.com` } }));
    await withOrg(pool, org, (c) => ingestEvents(c, org, ev, now));
    const sent: string[] = []; const sup = new Set<string>(); const receipts = new Map<string, WriteReceipt>();
    const { hashEmail } = await import("@quietgrowth/connector-email"); sup.add(hashEmail("b@x.com"));
    const auth = { secret: "s", store: new InMemoryIdempotencyStore(), now: () => now };
    const conn = new EmailConnector({ send: async (m) => { sent.push(m.to); return { id: `m${sent.length}` }; } }, {
      isSuppressed: async (h) => sup.has(h), sendsInLast: async () => 0, sendsToday: async () => sent.length, receiptForKey: async (k) => receipts.get(k), record: async (_h, r) => { receipts.set(r.idempotencyKey, r); },
    }, { perRecipientPerWeek: 3, perDay: 100 }, auth);
    const action: any = { id: "00000000-0000-0000-0000-000000000001", orgId: org, type: "lifecycle_email_existing_users", policyVersion: "zero_spend.v1", idempotencyKey: "lc", payload: { segment: "new_signup", subjectIds: ["a", "b", "c"], subject: "S", text: "T" } };
    const exec = new LifecycleExecutor(pool, async () => conn, (a, h) => signAuthorization({ actionId: a.id, policyVersion: a.policyVersion, resourceScope: "email:new_signup", idempotencyKey: `${a.idempotencyKey}:${h}`, expiresAt: now + 60_000 }, "s"), () => "https://u/x");
    const receipt = await exec.execute(action, "ignored");
    expect(sent.sort()).toEqual(["a@x.com", "c@x.com"]); expect(receipt.detail).toMatchObject({ sent: 2, blocked: { suppressed: 1 }, candidates: 3 });
    expect((await new LifecycleVerifier().verify(action, receipt)).ok).toBe(true);
    expect((await new LifecycleVerifier().verify(action, { ...receipt, detail: { sent: 0, blocked: {}, candidates: 0 } })).ok).toBe(false); // empty campaign is surfaced as a failure
    const comp = new CompositeExecutor({ execute: async () => { throw new Error("seo"); } }, exec);
    await expect(comp.execute({ ...action, type: "pricing_change" }, "t")).rejects.toThrow("no executor registered");
    expect((await new CompositeVerifier({ verify: async () => ({ ok: true, checks: [] }) }, new LifecycleVerifier()).verify({ ...action, type: "pricing_change" }, receipt)).ok).toBe(false);
  });

  it("sources: GSC/Stripe use stored credentials by reference; auth failure degrades the integration and notifies", async () => {
    const org = await mkOrg("S1");
    await pool.query("INSERT INTO products (organization_id, name, primary_url) VALUES ($1,'p','https://acme.example/')", [org]);
    const seen: string[] = [];
    const http: HttpClient = async (r) => {
      seen.push(`${r.method} ${r.url.split("?")[0]} ${r.headers?.authorization}`);
      if (r.url.includes("webmasters")) return { status: 200, headers: {}, json: { rows: [{ keys: ["q", "https://acme.example/p"], clicks: 1, impressions: 500, ctr: 0.002, position: 4 }] }, text: "" };
      return { status: 401, headers: {}, json: null, text: "" };
    };
    const src = buildSources({ pool, secrets, http, now: () => now });
    expect(await src.gscRows(org)).toBeNull(); // not connected
    for (const [prov, cred] of [["gsc", "gsc-token-1"], ["stripe", "sk_live_abcdefghijk"]]) {
      const ref = await secrets.put(org, prov!, cred!);
      const i = (await pool.query("INSERT INTO integrations (organization_id, provider, status) VALUES ($1,$2,'healthy') RETURNING id", [org, prov])).rows[0].id;
      await pool.query("INSERT INTO credential_references (organization_id, integration_id, secret_ref) VALUES ($1,$2,$3)", [org, i, ref]);
    }
    expect((await src.gscRows(org))![0]).toMatchObject({ query: "q", impressions: 500 });
    expect(seen[0]).toContain("Bearer gsc-token-1");
    expect(await src.billingEvents(org, new Date(0))).toEqual([]);
    expect((await pool.query("SELECT status FROM integrations WHERE organization_id=$1 AND provider='stripe'", [org])).rows[0].status).toBe("degraded");
    expect((await pool.query("SELECT kind FROM notifications WHERE organization_id=$1", [org])).rows[0].kind).toBe("connector_degraded");
    expect(await src.billingEvents(org, new Date(0))).toEqual([]); // degraded integrations are not used again
    expect(seen.filter((s) => s.includes("stripe.com"))).toHaveLength(1);
  });

  it("runs real handlers for active tenants and skips suspended ones", async () => {
    const org = await mkOrg("TICK"); const sus = await mkOrg("TICKSUS");
    await pool.query("INSERT INTO subscriptions (organization_id, tier, status) VALUES ($1,'growth','suspended')", [sus]);
    const r = await runTick(base(), [org, sus], 60_000);
    expect(r.errors).toEqual([]); expect(r.jobsRun).toBe(2 * TICK_JOBS.length);
  });

  it("suspended tenants receive no background work; reinstating resumes", async () => {
    const org = await mkOrg("SUS");
    await pool.query("INSERT INTO subscriptions (organization_id, tier, status) VALUES ($1,'growth','suspended')", [org]);
    const h = handlerFor(base());
    expect(await h.detect_and_propose(org)).toEqual({ skipped: "tenant_suspended" });
    expect(await h.execute_ready(org)).toEqual({ skipped: "tenant_suspended" });
    await pool.query("UPDATE subscriptions SET status='active' WHERE organization_id=$1", [org]);
    expect(await h.evaluate_due(org)).toEqual({ evaluated: 0 });
  });
});


describe("runTick (serverless, queue-free)", () => {
  const fakeDeps = (calls: string[]) => ({ pool: { connect: async () => { throw new Error("db down"); } } } as unknown as WorkerDeps);
  it("isolates per-job failures, reports them, and keeps going", async () => {
    const r = await runTick(fakeDeps([]), ["o1", "o2"], 60_000);
    expect(r.orgs).toBe(2); expect(r.jobsRun).toBe(0); expect(r.errors).toHaveLength(2 * TICK_JOBS.length); expect(r.truncated).toBe(false);
  });
  it("stops starting new work when the time budget is spent", async () => {
    let t = 0; const r = await runTick(fakeDeps([]), ["o1", "o2", "o3"], 5, () => (t += 3));
    expect(r.truncated).toBe(true); expect(r.orgs).toBeLessThan(3);
  });
});
