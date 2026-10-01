import type { Pool, PoolClient } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction as the non-bypass `qg_app` role with the tenant bound.
 * All application queries must go through this so RLS applies (MR §14.3).
 */
export async function withOrg<T>(pool: Pool, orgId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (!UUID.test(orgId)) throw new Error("invalid organization id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE qg_app");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
