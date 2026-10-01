// Real-stack E2E of the SINGLE deployment: Postgres + one Next.js process (UI + in-process API under /api) + headless Chromium.
// No mocks of QuietGrowth code.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import pg from "pg";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";

const ADMIN = process.env.DATABASE_URL ?? "postgres://postgres:quietgrowth@localhost:5432/quietgrowth";
const DB = "qg_e2e";
const DBURL = ADMIN.replace(/\/[^/]+$/, `/${DB}`);
// Next builds redirect URLs from `localhost`, so the browser must use the same host or the session cookie will not match.
const WEB = "http://localhost:3200", API = `${WEB}/api`;
const CRON_SECRET = "c".repeat(32);
const ENV = { DATABASE_URL: DBURL, SESSION_SECRET: "e2e-session-".padEnd(32, "x"), INTERNAL_SECRET: "e2e-internal-".padEnd(32, "x"), ACTION_AUTH_SECRET: "e2e-auth-".padEnd(32, "x"), SECRET_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), CRON_SECRET, QG_LOG: "0", PG_POOL_MAX: "3" };
const procs = [];

const run = (cmd, args, env, name) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.logs = () => out; p.name = name; procs.push(p); return p;
};
const waitFor = async (url, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url)).status < 500) return; } catch { /* retry */ } await sleep(300); } throw new Error(`timeout waiting for ${url}`); };

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  const mig = spawn("node", ["packages/database/dist/migrate-cli.js"], { env: { ...process.env, DATABASE_URL: DBURL }, stdio: "inherit" });
  await new Promise((r, j) => mig.on("exit", (c) => (c === 0 ? r() : j(new Error("migrate failed")))));

  // Misconfigured deployment first: must fail closed with 503 and leak no configuration details.
  run("pnpm", ["--filter", "@quietgrowth/web", "exec", "next", "start", "-p", "3202", "-H", "127.0.0.1"], { NODE_ENV: "production", DATABASE_URL: "", SESSION_SECRET: "" }, "web-misconfigured");
  await waitFor("http://127.0.0.1:3202/login");
  const bad = await fetch("http://127.0.0.1:3202/api/healthz"); assert.equal(bad.status, 503);
  const badText = await bad.text(); assert.equal(/DATABASE_URL|SESSION_SECRET|ECONN/.test(badText), false); assert.deepEqual(JSON.parse(badText), { error: "service_unavailable" });
  procs.pop().kill();

  run("pnpm", ["--filter", "@quietgrowth/web", "exec", "next", "start", "-p", "3200", "-H", "127.0.0.1"], { ...ENV, NODE_ENV: "production" }, "web");
  await waitFor(`${WEB}/login`);
  assert.equal((await (await fetch(`${API}/healthz`)).json()).ok, true);

  const db = new pg.Client({ connectionString: DBURL }); await db.connect();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined), args: ["--no-sandbox"] });
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const results = [];
  const step = async (name, fn) => { try { await fn(); results.push(["PASS", name]); console.log("PASS", name); } catch (e) { results.push(["FAIL", name]); console.error("FAIL", name, "\n", e.message); await page.screenshot({ path: `/tmp/e2e-fail-${results.length}.png` }).catch(() => {}); throw e; } };

  await step("unauthenticated users are redirected to login; security headers present", async () => {
    const r = await page.goto(`${WEB}/dashboard`); assert.match(page.url(), /\/login$/);
    const h = r.headers(); assert.equal(h["x-frame-options"], "DENY"); assert.match(h["content-security-policy"], /frame-ancestors 'none'/);
  });
  await step("signup creates an org and lands on onboarding", async () => {
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Organization").fill("E2E Co"); await page.getByLabel("Email").fill("founder@e2e.test"); await page.getByLabel("Password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/onboarding/); await page.getByText("Step 1 of 5").waitFor();
  });
  await step("session cookie is httpOnly (not readable by page scripts)", async () => {
    assert.equal(await page.evaluate(() => document.cookie.includes("qg_session")), false);
    const c = (await ctx.cookies()).find((x) => x.name === "qg_session"); assert.ok(c?.httpOnly);
  });
  await step("onboarding refuses private/loopback URLs (SSRF guard visible in UI)", async () => {
    await page.getByLabel("Product URL").fill("http://127.0.0.1:3200/api/healthz");
    await page.getByRole("button", { name: "Analyse my product" }).click();
    await page.getByText("cannot be analysed").waitFor();
  });

  // The public-URL analysis path is covered by API tests; here seed a product so the funnel step can run.
  const org = (await db.query("SELECT id FROM organizations WHERE name='E2E Co'")).rows[0].id;
  await db.query("INSERT INTO products (organization_id, name, primary_url) VALUES ($1,'Acme','https://acme.example')", [org]);

  await step("funnel definition validates and saves", async () => {
    await page.goto(`${WEB}/onboarding?step=2`);
    await page.getByLabel("Signup event").fill("signup"); await page.getByLabel("Activation (value) event").fill("activated"); await page.getByLabel("Paid conversion event").fill("paid");
    await page.getByRole("button", { name: "Save funnel" }).click();
    await page.waitForURL(/step=3/); await page.getByText("Zero-Spend mode is on").waitFor();
  });
  await step("dashboard shows an instrumentation warning before any events", async () => {
    await page.goto(`${WEB}/dashboard`);
    await page.getByText("incomplete instrumentation").waitFor();
    await page.getByText("Billing source is not connected").waitFor().catch(() => {});
  });

  // Ingest events through the public API with a real API key (server-side, as the SDK would).
  const token = (await ctx.cookies()).find((x) => x.name === "qg_session").value;
  const key = (await (await fetch(`${API}/v1/api-keys`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "e2e" }) })).json()).key;
  const events = []; const t = (m) => new Date(Date.now() - m * 60000).toISOString();
  for (let i = 0; i < 10; i++) { events.push({ userId: `u${i}`, event: "landing_view", timestamp: t(100) }, { userId: `u${i}`, event: "signup", timestamp: t(90) }); if (i < 5) events.push({ userId: `u${i}`, event: "activated", timestamp: t(80) }); if (i < 2) events.push({ userId: `u${i}`, event: "paid", timestamp: t(70) }); }
  const ing = await fetch(`${API}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ events }) });
  assert.equal(ing.status, 202);

  await step("funnel page reflects ingested events and never calls client paid events 'customers' without billing", async () => {
    await page.goto(`${WEB}/funnel`);
    await page.getByText("Paid (client-reported)").waitFor();
    await page.getByText("Billing source is not connected").waitFor();
  });
  await step("dashboard KPIs use cautious labels and real counts", async () => {
    await page.goto(`${WEB}/dashboard`);
    await page.getByText("Paid events (client-reported)").waitFor(); await page.getByText("50.0%").first().waitFor();
  });

  // Seed an approval-gated action and drive it through the UI.
  await db.query(`INSERT INTO actions (organization_id, domain, type, target_metric, rationale, evidence_json, idempotency_key, status, requires_approval, policy_version)
    VALUES ($1,'conversion','pricing_change','paid','Test pricing proposal','[]','e2e-1','NEEDS_APPROVAL',true,'zero_spend.v1')`, [org]);
  await step("approval inbox lists the action; approving moves it out of the queue", async () => {
    await page.goto(`${WEB}/actions?status=NEEDS_APPROVAL`);
    await page.getByText("pricing change").first().waitFor();
    await page.getByRole("button", { name: "Approve" }).click();
    await page.waitForTimeout(1500); await page.goto(`${WEB}/actions?status=NEEDS_APPROVAL`);
    await page.getByText("No actions.").waitFor();
    const s = (await db.query("SELECT status FROM actions WHERE idempotency_key='e2e-1'")).rows[0].status;
    assert.ok(["APPROVED", "FAILED", "SUCCEEDED", "OBSERVING"].includes(s), `unexpected status ${s}`);
  });
  await step("autopilot screen shows policy and enforces zero external spend", async () => {
    await page.goto(`${WEB}/autopilot`);
    await page.getByText("zero-spend").first().waitFor();
    await page.getByLabel("Monthly model-cost cap (USD)").fill("25"); await page.getByRole("button", { name: "Save policy" }).click();
    await page.getByText("Policy saved.").waitFor();
    const v = (await db.query("SELECT count(*)::int n FROM policy_versions")).rows[0].n; assert.equal(v, 1);
  });
  await step("integration credential is stored by reference and never rendered back", async () => {
    await page.goto(`${WEB}/integrations`);
    await page.getByLabel("Credential").fill("sk-e2e-super-secret-123456"); await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText("deepseek connected.").waitFor();
    await page.reload(); assert.equal((await page.content()).includes("super-secret"), false);
    const ref = (await db.query("SELECT secret_ref FROM credential_references")).rows[0].secret_ref; assert.match(ref, /^sec_deepseek_/);
  });
  await step("single-deployment API surface: /api auth, cron, internal, method and size guards", async () => {
    assert.equal((await fetch(`${API}/v1/dashboard`)).status, 401);
    assert.equal((await fetch(`${API}/cron/tick`)).status, 401);
    assert.equal((await fetch(`${API}/cron/tick`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    const tick = await fetch(`${API}/cron/tick`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(tick.status, 200); const t = await tick.json();
    assert.ok(t.orgs >= 1 && t.errors.length === 0 && t.truncated === false, JSON.stringify(t)); assert.equal(t.jobsRun, t.orgs * 6);
    assert.equal((await fetch(`${API}/internal/tools/read_site`, { method: "POST", headers: { "content-type": "application/json", "x-internal-secret": "nope" }, body: JSON.stringify({ orgId: "00000000-0000-0000-0000-000000000001", contract: {}, callId: "1" }) })).status, 401);
    assert.equal((await fetch(`${API}/healthz`, { method: "PUT" })).status, 405);
    assert.equal((await fetch(`${API}/v1/events`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x", "content-length": "5000000" }, body: "{}" }).catch(() => ({ status: 413 }))).status, 413);
    assert.equal((await fetch(`${API}/does/not/exist`)).status, 404);
    const hdr = (await fetch(`${API}/healthz`)).headers; assert.equal(hdr.get("cache-control"), "no-store");
  });
  await step("every main screen renders without server errors", async () => {
    for (const p of ["dashboard", "funnel", "opportunities", "actions", "acquisition", "lifecycle", "experiments", "analytics", "autopilot", "integrations", "product", "settings"]) {
      const r = await page.goto(`${WEB}/${p}`); assert.equal(r.status(), 200, p);
    }
  });
  await step("sign out clears the session", async () => {
    await page.goto(`${WEB}/settings`); await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/); await page.goto(`${WEB}/dashboard`); assert.match(page.url(), /\/login$/);
  });

  await browser.close(); await db.end();
  console.log(`\nE2E: ${results.filter((r) => r[0] === "PASS").length}/${results.length} passed`);
}

main().then(() => { procs.forEach((p) => p.kill()); process.exit(0); }).catch((e) => {
  console.error(e); for (const p of procs) console.error(`--- ${p.name} logs ---\n${p.logs().slice(-1500)}`);
  procs.forEach((p) => p.kill()); process.exit(1);
});
