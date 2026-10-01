import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import type { DockerCellManager } from "@quietgrowth/cell-manager";

// Internal tenant/runtime operations (MR §17 apps/admin, §21.7). Not customer-facing: bearer token + private network only.
export interface AdminDeps { pool: Pool; cells: DockerCellManager; adminToken: string; now?: () => number; actor?: string }

const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function buildAdminApp(d: AdminDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const now = d.now ?? Date.now;

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { done(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }), undefined); }
  });

  app.addHook("onRequest", async (req, reply) => {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!d.adminToken || d.adminToken.length < 24 || !t || !same(t, d.adminToken)) return reply.code(401).send({ error: "unauthorized" });
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request" });
    const status = (err as { statusCode?: number }).statusCode;
    return reply.code(status && status < 500 ? status : 500).send({ error: status && status < 500 ? err.message : "internal_error" });
  });

  const audit = (orgId: string, event: string, detail: Record<string, unknown> = {}) =>
    d.pool.query("INSERT INTO audit_logs (organization_id, actor, event, detail) VALUES ($1,$2,$3,$4)", [orgId, d.actor ?? "admin", event, detail]);

  app.get("/admin/tenants", async () => {
    const r = await d.pool.query(`
      SELECT o.id, o.name, s.tier, s.status AS subscription_status,
             (SELECT count(*)::int FROM actions a WHERE a.organization_id=o.id AND a.status='FAILED' AND a.created_at > $1) AS failed_actions_24h,
             (SELECT count(*)::int FROM integrations i WHERE i.organization_id=o.id AND i.status<>'healthy') AS unhealthy_integrations
        FROM organizations o LEFT JOIN LATERAL (SELECT tier, status FROM subscriptions WHERE organization_id=o.id ORDER BY created_at DESC LIMIT 1) s ON true ORDER BY o.name`,
      [new Date(now() - 86_400_000)]);
    return { tenants: r.rows.map((x) => ({ ...x, cell: d.cells.get(x.id)?.status ?? "none" })) };
  });

  app.get("/admin/incidents", async () => {
    const since = new Date(now() - 86_400_000);
    const failed = (await d.pool.query("SELECT organization_id, id, type, created_at FROM actions WHERE status='FAILED' AND created_at > $1 ORDER BY created_at DESC LIMIT 200", [since])).rows;
    const integ = (await d.pool.query("SELECT organization_id, provider, status FROM integrations WHERE status<>'healthy'")).rows;
    const cells = d.cells.list().filter((c) => c.status === "unhealthy").map((c) => ({ orgId: c.orgId, instanceId: c.instanceId }));
    return { failedActions: failed, unhealthyIntegrations: integ, unhealthyCells: cells, versionDrift: d.cells.versionDrift().map((c) => ({ orgId: c.orgId, image: c.image })) };
  });

  app.post("/admin/cells/:orgId/restart", async (req, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    if (!d.cells.get(orgId)) return reply.code(404).send({ error: "no_cell" });
    const healthy = await d.cells.restartUnhealthy(orgId, 3);
    await audit(orgId, "admin:cell_restart", { healthy });
    return { healthy };
  });

  // Suspension stops dispatch for a tenant (worker skips non-active subscriptions); it never deletes data.
  app.post("/admin/tenants/:orgId/status", async (req, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const { status, reason } = z.object({ status: z.enum(["active", "suspended"]), reason: z.string().min(3).max(300) }).parse(req.body);
    const r = await d.pool.query("UPDATE subscriptions SET status=$2 WHERE organization_id=$1", [orgId, status]);
    if (!r.rowCount) return reply.code(404).send({ error: "no_subscription" });
    if (status === "suspended" && d.cells.get(orgId)) await d.cells.stop(orgId);
    await audit(orgId, `admin:tenant_${status}`, { reason });
    return { status };
  });

  return app;
}
