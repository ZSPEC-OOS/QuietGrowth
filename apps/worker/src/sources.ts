import type { Pool } from "pg";
import { withOrg } from "@quietgrowth/database";
import type { SecretStore } from "@quietgrowth/secrets";
import { GscConnector, type GscRow } from "@quietgrowth/connector-gsc";
import { normalizeStripeEvent, type RevenueEvent } from "@quietgrowth/connector-billing";
import type { HttpClient } from "@quietgrowth/connectors-core";
import type { WorkerDeps } from "./ports.js";

export interface SourceDeps { pool: Pool; secrets: SecretStore; http: HttpClient; now: () => number }

/** Reads the org's stored credential by reference. Returns null when the integration is absent or unhealthy. */
async function credential(d: SourceDeps, orgId: string, provider: string): Promise<string | null> {
  const ref = await withOrg(d.pool, orgId, async (c) => (await c.query(
    `SELECT cr.secret_ref FROM credential_references cr JOIN integrations i ON i.id=cr.integration_id
      WHERE i.organization_id=$1 AND i.provider=$2 AND i.status='healthy' ORDER BY cr.created_at DESC LIMIT 1`, [orgId, provider])).rows[0]?.secret_ref as string | undefined);
  if (!ref) return null;
  try { return await d.secrets.get(orgId, ref); } catch { return null; }
}

async function markDegraded(d: SourceDeps, orgId: string, provider: string, detail: string): Promise<void> {
  await withOrg(d.pool, orgId, async (c) => {
    await c.query("UPDATE integrations SET status='degraded' WHERE organization_id=$1 AND provider=$2", [orgId, provider]);
    await c.query("INSERT INTO notifications (organization_id, kind, body) VALUES ($1,'connector_degraded',$2)", [orgId, { provider, detail }]);
  });
}

export function buildSources(d: SourceDeps): WorkerDeps["sources"] {
  return {
    async gscRows(orgId: string): Promise<GscRow[] | null> {
      const token = await credential(d, orgId, "gsc");
      if (!token) return null;
      const site = await withOrg(d.pool, orgId, async (c) => (await c.query("SELECT primary_url FROM products WHERE organization_id=$1 ORDER BY created_at LIMIT 1", [orgId])).rows[0]?.primary_url as string | undefined);
      if (!site) return null;
      const gsc = new GscConnector(d.http, async () => token);
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      try {
        const rows = await gsc.query({ siteUrl: site, startDate: day(d.now() - 28 * 86_400_000), endDate: day(d.now() - 2 * 86_400_000), dimensions: ["query", "page"], rowLimit: 1000 });
        await withOrg(d.pool, orgId, (c) => c.query("UPDATE integrations SET last_sync_at=now() WHERE organization_id=$1 AND provider='gsc'", [orgId]));
        return rows;
      } catch (e) {
        if (gsc.gate.current.status !== "healthy") await markDegraded(d, orgId, "gsc", gsc.gate.current.detail ?? "auth failed"); // stop using it until the owner reconnects
        return null;
      }
    },

    async billingEvents(orgId: string, since: Date): Promise<RevenueEvent[]> {
      const key = await credential(d, orgId, "stripe");
      if (!key) return [];
      const out: RevenueEvent[] = [];
      let after: string | undefined;
      for (let page = 0; page < 20; page++) {
        const q = new URLSearchParams({ limit: "100", "created[gte]": String(Math.floor(since.getTime() / 1000)) });
        for (const t of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_succeeded", "invoice.payment_failed", "charge.refunded"]) q.append("types[]", t);
        if (after) q.set("starting_after", after);
        const r = await d.http({ method: "GET", url: `https://api.stripe.com/v1/events?${q}`, headers: { authorization: `Bearer ${key}` } });
        if (r.status === 401 || r.status === 403) { await markDegraded(d, orgId, "stripe", `auth failed (${r.status})`); return out; }
        if (r.status !== 200) throw new Error(`stripe events failed: ${r.status}`); // retried by the queue; reconcile is idempotent
        const j = r.json as { data: { id: string; type: string; created: number; data: { object: Record<string, unknown> } }[]; has_more: boolean };
        for (const e of j.data) { const n = normalizeStripeEvent(e); if (n) out.push(n); }
        if (!j.has_more || j.data.length === 0) break;
        after = j.data[j.data.length - 1]!.id;
      }
      return out;
    },

    async plgFacts() { return null; },
  };
}
