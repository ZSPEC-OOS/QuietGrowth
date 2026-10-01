import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { migrate, withOrg } from "@quietgrowth/database";
import { ZERO_SPEND_POLICY } from "@quietgrowth/policy-engine";
import { GrowthEngine, PgActionStore, type NewAction } from "./index.js";

const url = process.env.DATABASE_URL;
const schema = `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!url)("GrowthEngine on Postgres", () => {
  let pool: pg.Pool; let orgA = "", orgB = "", user = "";
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool, fileURLToPath(new URL("../../database/migrations", import.meta.url)));
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO qg_app`);
    orgA = (await pool.query("INSERT INTO organizations (name) VALUES ('A') RETURNING id")).rows[0].id;
    orgB = (await pool.query("INSERT INTO organizations (name) VALUES ('B') RETURNING id")).rows[0].id;
    user = (await pool.query("INSERT INTO users (email) VALUES ('u@x.com') RETURNING id")).rows[0].id;
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });

  const mkEngine = (c: pg.PoolClient) => new GrowthEngine({
    store: new PgActionStore(c), authSecret: "s", now: () => 1000, scopeFor: (a) => `repo:x:${a.id}`,
    policies: { current: async () => ZERO_SPEND_POLICY },
    executor: { execute: async () => ({ provider: "github", resourceId: "7", idempotencyKey: "k", at: 1 }) },
    verifier: { verify: async () => ({ ok: true, checks: [{ name: "http_200", ok: true }] }) },
    outcomes: { evaluate: async () => ({ label: "observational", summary: {}, guardrailsHeld: true }) },
  });
  const act = (orgId: string, o: Partial<NewAction> = {}): NewAction => ({ orgId, domain: "acquisition", type: "metadata_change", targetMetric: "signups", guardrailMetrics: [], rationale: "r", evidence: ["e"], expectedIncrementalImpact: 0.1, confidence: 0.5, estimatedExternalCostUsd: 0, estimatedModelCostUsd: 0, idempotencyKey: `k${Math.random()}`, payload: { path: "a.md" }, ...o });

  it("persists the full lifecycle, receipts, verification and audit trail", async () => {
    await withOrg(pool, orgA, async (c) => {
      const e = mkEngine(c);
      const { action } = await e.propose(act(orgA));
      expect(action.status).toBe("AUTO_APPROVED"); expect(action.policyVersion).toBe("zero_spend.v1");
      expect((await e.runAutoApproved(orgA, action.id)).action.status).toBe("SUCCEEDED");
      await e.observe(orgA, action.id); await e.evaluateOutcome(orgA, action.id);
      const row = (await c.query("SELECT status, payload FROM actions WHERE id=$1", [action.id])).rows[0];
      expect(row.status).toBe("EVALUATED"); expect(row.payload).toEqual({ path: "a.md" });
      expect((await c.query("SELECT count(*)::int n FROM external_changes WHERE action_id=$1", [action.id])).rows[0].n).toBe(1);
      expect((await c.query("SELECT count(*)::int n FROM audit_logs WHERE subject_id=$1", [action.id])).rows[0].n).toBeGreaterThan(8);
    });
  });
  it("approval flow records the decision", async () => {
    await withOrg(pool, orgA, async (c) => {
      const e = mkEngine(c);
      const { action } = await e.propose(act(orgA, { type: "pricing_change" }));
      await e.approve(orgA, action.id, user);
      expect((await c.query("SELECT decision FROM approvals WHERE action_id=$1", [action.id])).rows[0].decision).toBe("approved");
      await e.queue(orgA, action.id);
    });
  });
  it("idempotency key dedupes at the database", async () => {
    await withOrg(pool, orgA, async (c) => {
      const e = mkEngine(c);
      const a = await e.propose(act(orgA, { idempotencyKey: "dup" })); const b = await e.propose(act(orgA, { idempotencyKey: "dup" }));
      expect(b.created).toBe(false); expect(b.action.id).toBe(a.action.id);
    });
  });
  it("another tenant cannot see or move the action", async () => {
    const id = await withOrg(pool, orgA, async (c) => (await mkEngine(c).propose(act(orgA))).action.id);
    await withOrg(pool, orgB, async (c) => { await expect(mkEngine(c).queue(orgB, id)).rejects.toThrow("not found"); });
  });
});
