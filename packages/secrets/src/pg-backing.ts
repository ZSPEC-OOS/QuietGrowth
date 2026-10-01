import type { Pool } from "pg";
import { withOrg } from "@quietgrowth/database";
import type { Sealed, SealedBacking } from "./index.js";

/** Postgres-backed sealed storage, tenant-bound through row-level security. */
export class PgBacking implements SealedBacking {
  constructor(private readonly pool: Pool) {}
  async get(orgId: string, ref: string): Promise<Sealed | undefined> {
    const r = await withOrg(this.pool, orgId, (c) => c.query("SELECT iv, tag, data FROM secrets WHERE organization_id=$1 AND ref=$2", [orgId, ref]));
    return r.rows[0] ? { orgId, iv: r.rows[0].iv, tag: r.rows[0].tag, data: r.rows[0].data } : undefined;
  }
  async set(orgId: string, ref: string, s: Sealed): Promise<void> {
    await withOrg(this.pool, orgId, (c) => c.query("INSERT INTO secrets (organization_id, ref, iv, tag, data) VALUES ($1,$2,$3,$4,$5)", [orgId, ref, s.iv, s.tag, s.data]));
  }
  async delete(orgId: string, ref: string): Promise<void> {
    await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM secrets WHERE organization_id=$1 AND ref=$2", [orgId, ref]));
  }
}
