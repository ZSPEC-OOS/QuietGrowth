import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { migrate } from "@quietgrowth/database";
import { DockerCellManager, buildTenantConfig, type CommandRunner } from "@quietgrowth/cell-manager";
import { LocalEncryptedSecretStore } from "@quietgrowth/secrets";
import { buildAdminApp } from "./app.js";

const url = process.env.DATABASE_URL;
const TOKEN = "admin-token-that-is-long-enough-123";
describe.skipIf(!url)("admin app", () => {
  const sch = `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: pg.Pool; let app: FastifyInstance; let orgA = "", orgB = ""; const cmds: string[][] = [];
  let inspect = "exited|";
  const docker: CommandRunner = { run: async (_c, a) => { cmds.push(a); return { code: 0, stdout: a[0] === "inspect" ? inspect : "", stderr: "" }; } };
  const cells = new DockerCellManager(docker, 21000, undefined, ["reg/openclaw:1"]);
  const secrets = new LocalEncryptedSecretStore(LocalEncryptedSecretStore.generateKey());
  const H = (t = TOKEN) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${sch},public` });
    await pool.query(`CREATE SCHEMA ${sch}`);
    await migrate(pool, fileURLToPath(new URL("../../database/migrations", import.meta.url)));
    orgA = (await pool.query("INSERT INTO organizations (name) VALUES ('A') RETURNING id")).rows[0].id;
    orgB = (await pool.query("INSERT INTO organizations (name) VALUES ('B') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO subscriptions (organization_id, tier) VALUES ($1,'growth'), ($2,'team')", [orgA, orgB]);
    await pool.query("INSERT INTO integrations (organization_id, provider, status) VALUES ($1,'stripe','degraded')", [orgA]);
    await pool.query("INSERT INTO actions (organization_id, domain, type, target_metric, rationale, evidence_json, idempotency_key, status) VALUES ($1,'acquisition','metadata_change','m','r','[]','k','FAILED')", [orgA]);
    await cells.provision(buildTenantConfig({ orgId: orgA, openclawImage: "reg/openclaw:1", controlPlaneUrl: "https://api.test", secretRefs: { deepseekApiKey: "a", internalSecret: "b" }, tokenCeilingPerRun: 100 }));
    await cells.start(orgA);
    const ca = cells.get(orgA)!;
    await pool.query("INSERT INTO runtime_cells (organization_id, instance_id, image, status, port) VALUES ($1,$2,$3,$4,$5)", [orgA, ca.instanceId, ca.image, ca.status, ca.port]);
    app = await buildAdminApp({ pool, cells, adminToken: TOKEN, secrets, internalMaster: "int-master" });
  });
  afterAll(async () => { await app.close(); await pool.query(`DROP SCHEMA ${sch} CASCADE`); await pool.end(); });

  it("rejects missing/wrong tokens and refuses to run with a weak configured token", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/tenants" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/admin/tenants", headers: H("wrong") })).statusCode).toBe(401);
    const weak = await buildAdminApp({ pool, cells, adminToken: "short", secrets, internalMaster: "m" });
    expect((await weak.inject({ method: "GET", url: "/admin/tenants", headers: H("short") })).statusCode).toBe(401);
  });
  it("lists tenants with plan, cell state and health signals", async () => {
    const t = (await app.inject({ method: "GET", url: "/admin/tenants", headers: H() })).json().tenants;
    const a = t.find((x: any) => x.id === orgA);
    expect(a).toMatchObject({ tier: "growth", failed_actions_24h: 1, unhealthy_integrations: 1, cell: "running" });
    expect(t.find((x: any) => x.id === orgB).cell).toBe("none");
  });
  it("incident view surfaces failed actions, degraded connectors and unhealthy cells", async () => {
    await pool.query("UPDATE runtime_cells SET status='unhealthy' WHERE organization_id=$1", [orgA]); // as recorded by a health check
    const i = (await app.inject({ method: "GET", url: "/admin/incidents", headers: H() })).json();
    expect(i.failedActions).toHaveLength(1); expect(i.unhealthyIntegrations[0].provider).toBe("stripe"); expect(i.unhealthyCells).toHaveLength(1);
  });
  it("restart is bounded, audited, and 404s for tenants without a cell", async () => {
    inspect = "running|healthy";
    const r = await app.inject({ method: "POST", url: `/admin/cells/${orgA}/restart`, headers: H() });
    expect(r.json().healthy).toBe(true);
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE event='admin:cell_restart'")).rowCount).toBe(1);
    expect((await app.inject({ method: "POST", url: `/admin/cells/${orgB}/restart`, headers: H() })).statusCode).toBe(404);
  });
  it("provisioning validates config (no :latest), is idempotent, records the cell and audits", async () => {
    const body = { openclawImage: "reg/openclaw:1", controlPlaneUrl: "https://api.test", deepseekSecretRef: "sec_deepseek_x" };
    expect((await app.inject({ method: "POST", url: `/admin/cells/${orgB}/provision`, headers: H(), payload: JSON.stringify({ ...body, openclawImage: "reg/openclaw:latest" }) })).statusCode).toBe(422);
    const r1 = await app.inject({ method: "POST", url: `/admin/cells/${orgB}/provision`, headers: H(), payload: JSON.stringify(body) });
    const r2 = await app.inject({ method: "POST", url: `/admin/cells/${orgB}/provision`, headers: H(), payload: JSON.stringify(body) });
    expect(r1.statusCode).toBe(201); expect(r2.json().instanceId).toBe(r1.json().instanceId);
    expect((await pool.query("SELECT image, port FROM runtime_cells WHERE organization_id=$1", [orgB])).rows).toHaveLength(1);
    expect(cmds.filter((c) => c[0] === "create").length).toBe(2); // orgA in setup + orgB once
    const createCall = cmds.filter((c) => c[0] === "create").at(-1)!.join(" ");
    const cfg = JSON.parse(Buffer.from(/QG_TENANT_CONFIG=(\S+)/.exec(createCall)![1]!, "base64").toString());
    expect(cfg.secrets.internalSecret).toMatch(/^sec_internal_/); // a reference, never the value
    expect(createCall).not.toContain(createHmac("sha256", "int-master").update(`internal:${orgB}`).digest("base64url"));
    expect((await app.inject({ method: "POST", url: "/admin/cells/00000000-0000-0000-0000-000000000009/provision", headers: H(), payload: JSON.stringify(body) })).statusCode).toBe(404);
  });
  it("suspension updates the subscription, stops the cell, requires a reason, and is audited", async () => {
    expect((await app.inject({ method: "POST", url: `/admin/tenants/${orgA}/status`, headers: H(), payload: JSON.stringify({ status: "suspended", reason: "x" }) })).statusCode).toBe(400);
    const r = await app.inject({ method: "POST", url: `/admin/tenants/${orgA}/status`, headers: H(), payload: JSON.stringify({ status: "suspended", reason: "abuse investigation" }) });
    expect(r.statusCode).toBe(200);
    expect((await pool.query("SELECT status FROM subscriptions WHERE organization_id=$1", [orgA])).rows[0].status).toBe("suspended");
    expect(cells.get(orgA)!.status).toBe("stopped"); expect(cmds.some((c) => c[0] === "stop")).toBe(true);
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE event='admin:tenant_suspended'")).rowCount).toBe(1);
  });
});
