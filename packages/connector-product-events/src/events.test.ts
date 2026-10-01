import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { migrate, withOrg } from "@quietgrowth/database";
import { ingestEvents, resolvedEvents, validateEvent } from "./index.js";

describe("validateEvent", () => {
  const ok = { userId: "u", event: "signup", timestamp: "2026-10-01T00:00:00Z" };
  it("accepts valid and rejects malformed input", () => {
    expect(validateEvent(ok).ok).toBe(true);
    for (const bad of [{ ...ok, event: "bad name!" }, { ...ok, userId: undefined }, { ...ok, timestamp: "nope" }, { ...ok, schemaVersion: 9 }, { ...ok, timestamp: "2999-01-01T00:00:00Z" }])
      expect(validateEvent(bad as never).ok).toBe(false);
  });
  it("upgrades v1 properties and derives stable idempotency keys", () => {
    const a = validateEvent({ ...ok, properties: { plan_name: "pro" } }) as any;
    expect(a.event.properties).toEqual({ plan: "pro" });
    expect((validateEvent(ok) as any).event.idempotencyKey).toBe((validateEvent(ok) as any).event.idempotencyKey);
    expect((validateEvent({ ...ok, messageId: "m1" }) as any).event.idempotencyKey).toBe("m1");
  });
});

const url = process.env.DATABASE_URL;
const schema = `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
describe.skipIf(!url)("ingestEvents (postgres)", () => {
  let pool: pg.Pool; let orgA = "", orgB = "";
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool, fileURLToPath(new URL("../../database/migrations", import.meta.url)));
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO qg_app`);
    orgA = (await pool.query("INSERT INTO organizations (name) VALUES ('A') RETURNING id")).rows[0].id;
    orgB = (await pool.query("INSERT INTO organizations (name) VALUES ('B') RETURNING id")).rows[0].id;
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });

  it("dedupes retries, reports rejects, and is tenant scoped", async () => {
    const batch = [
      { anonymousId: "anon1", event: "landing_view", timestamp: "2026-10-01T00:00:00Z" },
      { anonymousId: "anon1", event: "landing_view", timestamp: "2026-10-01T00:00:00Z" },
      { event: "bad", timestamp: "2026-10-01T00:00:00Z" },
    ];
    const r = await withOrg(pool, orgA, (c) => ingestEvents(c, orgA, batch as never));
    expect(r).toEqual({ accepted: 1, duplicates: 1, rejected: [{ index: 2, error: "anonymousId or userId required" }] });
    expect((await withOrg(pool, orgA, (c) => ingestEvents(c, orgA, batch.slice(0, 1) as never))).duplicates).toBe(1);
    expect((await withOrg(pool, orgB, (c) => c.query("SELECT 1 FROM conversion_events"))).rowCount).toBe(0);
  });
  it("tenant context cannot be spoofed via orgId argument", async () => {
    await expect(withOrg(pool, orgA, (c) => ingestEvents(c, orgB, [{ userId: "u", event: "x", timestamp: "2026-10-01T00:00:00Z" }]))).rejects.toThrow(/row-level security/);
  });
  it("merges identity: pre-signup anonymous events resolve to the user; first link wins", async () => {
    await withOrg(pool, orgA, async (c) => {
      await ingestEvents(c, orgA, [
        { anonymousId: "anon9", event: "landing_view", timestamp: "2026-10-01T01:00:00Z" },
        { anonymousId: "anon9", userId: "user9", event: "signup", timestamp: "2026-10-01T02:00:00Z" },
        { anonymousId: "anon9", userId: "other", event: "signup", timestamp: "2026-10-01T03:00:00Z" },
      ]);
      const ev = await resolvedEvents(c, orgA, new Date("2026-09-01"));
      const mine = ev.filter((e) => e.event === "landing_view" && e.subjectId === "user9");
      expect(mine).toHaveLength(1);
    });
  });
});
