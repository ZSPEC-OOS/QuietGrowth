import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import { createHmac } from "node:crypto";
import type { SecretStore } from "@quietgrowth/secrets";
import { buildTenantConfig, type DockerCellManager } from "@quietgrowth/cell-manager";

// Internal tenant/runtime operations (MR §17, §21.7), mounted into the main app under /admin (public path /api/admin/*).
// Not customer-facing: bearer ADMIN_TOKEN, and a separate BYPASSRLS database role (qg_admin) for cross-tenant reads.
export interface AdminDeps { pool: Pool; cells: DockerCellManager; adminToken: string; now?: () => number; actor?: string; secrets: SecretStore; /** Same master as the API's INTERNAL_SECRET; cells only ever receive the secret derived for their own org. */ internalMaster: string }

const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Encapsulated Fastify plugin: its auth hook and error handler apply only to the routes registered here. */
export function adminPlugin(d: AdminDeps): FastifyPluginAsync {
  return async (app) => {
  const now = d.now ?? Date.now;

  app.addHook("onRequest", async (req, reply) => {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!d.adminToken || d.adminToken.length < 24 || !t || !same(t, d.adminToken)) return reply.code(401).send({ error: "unauthorized" });
    // Serverless instances have no memory between requests: the cell registry is rebuilt from the database each time.
    d.cells.hydrate((await d.pool.query("SELECT organization_id, instance_id, image, port, status FROM runtime_cells")).rows.map((r) => ({ orgId: r.organization_id, instanceId: r.instance_id, image: r.image, port: r.port, status: r.status })));
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request" });
    if (err.name === "CellError") return reply.code(503).send({ error: "runtime_unavailable", message: err.message }); // e.g. no container runtime on this host
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
    const cells = d.cells.list().filter((c) => c.status === "unhealthy").map((c) => ({ orgId: c.orgId, instanceId: c.instanceId })); // status is persisted by cell operations
    return { failedActions: failed, unhealthyIntegrations: integ, unhealthyCells: cells, versionDrift: d.cells.versionDrift().map((c) => ({ orgId: c.orgId, image: c.image })) };
  });

  app.post("/admin/cells/:orgId/restart", async (req, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    if (!d.cells.get(orgId)) return reply.code(404).send({ error: "no_cell" });
    const healthy = await d.cells.restartUnhealthy(orgId, 3);
    await d.pool.query("UPDATE runtime_cells SET status=$2, updated_at=now() WHERE organization_id=$1", [orgId, d.cells.get(orgId)?.status ?? "unhealthy"]);
    await audit(orgId, "admin:cell_restart", { healthy });
    return { healthy };
  });

  // Provision (idempotent) a pinned, validated cell for a tenant. Secrets are passed as references only.
  app.post("/admin/cells/:orgId/provision", async (req, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const b = z.object({ openclawImage: z.string().min(3), controlPlaneUrl: z.string().url(), deepseekSecretRef: z.string().min(3), tokenCeilingPerRun: z.number().int().positive().default(20000) }).parse(req.body);
    if (!(await d.pool.query("SELECT 1 FROM organizations WHERE id=$1", [orgId])).rowCount) return reply.code(404).send({ error: "no_such_tenant" });
    // Mirror of the API's internalSecretFor: HMAC(master, "internal:" + orgId), stored sealed and handed to the cell by reference.
    const internalRef = await d.secrets.put(orgId, "internal", createHmac("sha256", d.internalMaster).update(`internal:${orgId}`).digest("base64url"));
    let cfg;
    try { cfg = buildTenantConfig({ orgId, openclawImage: b.openclawImage, controlPlaneUrl: b.controlPlaneUrl, secretRefs: { deepseekApiKey: b.deepseekSecretRef, internalSecret: internalRef }, tokenCeilingPerRun: b.tokenCeilingPerRun }); }
    catch (e) { await d.secrets.delete(orgId, internalRef); return reply.code(422).send({ error: "invalid_cell_config", message: (e as Error).message }); }
    const cell = await d.cells.provision(cfg);
    await d.pool.query("INSERT INTO runtime_cells (organization_id, instance_id, image, status, port) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organization_id) DO UPDATE SET instance_id=EXCLUDED.instance_id, image=EXCLUDED.image, status=EXCLUDED.status, port=EXCLUDED.port, updated_at=now()", [orgId, cell.instanceId, cell.image, cell.status, cell.port]);
    await audit(orgId, "admin:cell_provisioned", { image: cell.image, port: cell.port });
    return reply.code(201).send({ instanceId: cell.instanceId, port: cell.port });
  });

  // Suspension stops dispatch for a tenant (worker skips non-active subscriptions); it never deletes data.
  app.post("/admin/tenants/:orgId/status", async (req, reply) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const { status, reason } = z.object({ status: z.enum(["active", "suspended"]), reason: z.string().min(3).max(300) }).parse(req.body);
    const r = await d.pool.query("UPDATE subscriptions SET status=$2 WHERE organization_id=$1", [orgId, status]);
    if (!r.rowCount) return reply.code(404).send({ error: "no_subscription" });
    if (status === "suspended" && d.cells.get(orgId)) { await d.cells.stop(orgId); await d.pool.query("UPDATE runtime_cells SET status='stopped', updated_at=now() WHERE organization_id=$1", [orgId]); }
    await audit(orgId, `admin:tenant_${status}`, { reason });
    return { status };
  });

  };
}

/** Standalone instance (used by tests and any host that wants only the admin surface). */
export async function buildAdminApp(d: AdminDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { done(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }), undefined); }
  });
  await app.register(adminPlugin(d));
  return app;
}
