import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrate.js";
import { withOrg } from "./tenant.js";

const url = process.env.DATABASE_URL;
const dir = fileURLToPath(new URL("../migrations", import.meta.url));
const schema = `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let pool: pg.Pool;
let orgA = "", orgB = "", userA = "";

// Roles are cluster-wide, tables are per-schema: isolate each run in its own schema.
describe.skipIf(!url)("identity schema + RLS", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO PUBLIC`).catch(() => {});
    await migrate(pool, dir);
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO qg_app`);
    orgA = (await pool.query("INSERT INTO organizations (name) VALUES ('A') RETURNING id")).rows[0].id;
    orgB = (await pool.query("INSERT INTO organizations (name) VALUES ('B') RETURNING id")).rows[0].id;
    userA = (await pool.query("INSERT INTO users (email) VALUES ('a@example.com') RETURNING id")).rows[0].id;
    const userB = (await pool.query("INSERT INTO users (email) VALUES ('b@example.com') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO organization_members VALUES ($1,$2,'owner')", [orgA, userA]);
    await pool.query("INSERT INTO organization_members VALUES ($1,$2,'owner')", [orgB, userB]);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  it("migration is idempotent", async () => {
    expect(await migrate(pool, dir)).toEqual([]);
  });

  it("tenant sees only its own organization and members", async () => {
    const orgs = await withOrg(pool, orgA, (c) => c.query("SELECT id FROM organizations"));
    expect(orgs.rows.map((r) => r.id)).toEqual([orgA]);
    const members = await withOrg(pool, orgA, (c) => c.query("SELECT organization_id FROM organization_members"));
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].organization_id).toBe(orgA);
  });

  it("cross-org read by id is blocked", async () => {
    const r = await withOrg(pool, orgA, (c) => c.query("SELECT * FROM organizations WHERE id = $1", [orgB]));
    expect(r.rows).toEqual([]);
  });

  it("cross-org write is blocked", async () => {
    await expect(withOrg(pool, orgA, (c) => c.query("INSERT INTO organization_members VALUES ($1,$2,'member')", [orgB, userA]))).rejects.toThrow(/row-level security/);
    const upd = await withOrg(pool, orgA, (c) => c.query("UPDATE organizations SET name='x' WHERE id = $1", [orgB]));
    expect(upd.rowCount).toBe(0);
    const del = await withOrg(pool, orgA, (c) => c.query("DELETE FROM organization_members WHERE organization_id = $1", [orgB]));
    expect(del.rowCount).toBe(0);
  });

  it("fails closed when no tenant is bound", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE qg_app");
      expect((await client.query("SELECT * FROM organizations")).rows).toEqual([]);
      expect((await client.query("SELECT * FROM organization_members")).rows).toEqual([]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("rejects non-uuid org ids (no injection into set_config)", async () => {
    await expect(withOrg(pool, "x'; DROP TABLE organizations;--", async () => 1)).rejects.toThrow("invalid organization id");
  });

  it("app role cannot create organizations", async () => {
    await expect(withOrg(pool, orgA, (c) => c.query("INSERT INTO organizations (name) VALUES ('evil')"))).rejects.toThrow();
  });
});
