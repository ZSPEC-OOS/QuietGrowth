// Smoke test of the built Vercel function: loads the bundle exactly as the Node launcher would (CJS, module.exports = handler)
// behind a plain http server and exercises real requests against Postgres.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import pg from "pg";

const ADMIN = process.env.DATABASE_URL ?? "postgres://postgres:quietgrowth@localhost:5432/quietgrowth";
const DB = "qg_vercel_smoke", DBURL = ADMIN.replace(/\/[^/]+$/, `/${DB}`);
const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
const m = spawnSync("node", ["../../packages/database/dist/migrate-cli.js"], { env: { ...process.env, DATABASE_URL: DBURL }, encoding: "utf8" });
assert.equal(m.status, 0, m.stderr);

const bundle = new URL("../.vercel/output/functions/index.func/index.js", import.meta.url).pathname;
const run = async (env) => {
  Object.assign(process.env, env);
  delete createRequire(import.meta.url).cache[bundle];
  const handler = createRequire(import.meta.url)(bundle);
  assert.equal(typeof handler, "function", "bundle must export the handler as module.exports");
  const srv = createServer(handler); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
};
const good = { DATABASE_URL: DBURL, SESSION_SECRET: "s".repeat(32), INTERNAL_SECRET: "i".repeat(32), ACTION_AUTH_SECRET: "a".repeat(32), SECRET_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"), CRON_SECRET: "c".repeat(32), PG_POOL_MAX: "3" };

// 1. misconfigured deployment fails closed (503, no details leaked) and is retried rather than cached
for (const k of Object.keys(good)) delete process.env[k];
let s = await run({});
let r = await fetch(`${s.base}/healthz`); assert.equal(r.status, 503); assert.equal((await r.text()).includes("SESSION_SECRET"), false);
await s.close();

// 2. configured deployment
s = await run(good);
const J = (path, init = {}) => fetch(`${s.base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
assert.equal((await (await J("/healthz")).json()).ok, true);
const su = await J("/v1/signup", { method: "POST", body: JSON.stringify({ email: "v@vercel.test", password: "correct-horse-battery", orgName: "Vercel Co" }) });
assert.equal(su.status, 201); const { token } = await su.json();
const dash = await J("/v1/dashboard", { headers: { authorization: `Bearer ${token}` } });
assert.equal(dash.status, 200); assert.equal((await dash.json()).instrumentationWarning, true);
assert.equal((await J("/v1/dashboard")).status, 401);

// 3. cron: unauthenticated and wrong-secret calls are rejected; the real call runs a tick over all tenants
assert.equal((await J("/cron/tick")).status, 401);
assert.equal((await J("/cron/tick", { headers: { authorization: "Bearer wrong" } })).status, 401);
const tick = await J("/cron/tick", { headers: { authorization: `Bearer ${good.CRON_SECRET}` } });
assert.equal(tick.status, 200); const t = await tick.json();
assert.equal(t.orgs, 1); assert.equal(t.truncated, false); assert.deepEqual(t.errors, []); assert.equal(t.jobsRun, 6);
await s.close();
console.log("vercel function smoke: OK");
process.exit(0);
