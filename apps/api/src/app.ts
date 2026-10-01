import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { withOrg } from "@quietgrowth/database";
import { redact, type SecretStore } from "@quietgrowth/secrets";
import { analyzeHtml, safeFetch, validateGrowthContract, UnsafeUrlError, type Resolver } from "@quietgrowth/saas-profile";
import { evaluateCompleteness, type FunnelDefinition } from "@quietgrowth/domain";
import { funnelCounts } from "@quietgrowth/metrics";
import { ingestEvents, resolvedEvents } from "@quietgrowth/connector-product-events";
import { GrowthEngine, PgActionStore, EngineError, type ActionRecord, type Executor, type OutcomeEvaluator, type Verifier } from "@quietgrowth/growth-engine";
import { ZERO_SPEND_POLICY, ACTION_TYPES, type Policy } from "@quietgrowth/policy-engine";
import { validateSpec, type ExperimentSpec } from "@quietgrowth/experiments";
import { runTool } from "./tools.js";
import { ToolDeniedError } from "@quietgrowth/runtime-manager";
import { hashApiKey, hashPassword, newApiKey, signSession, verifyPassword, verifySession, type Role, type Session } from "./auth.js";

export interface AppDeps {
  /** Owner-privileged pool: used only for signup/login and API-key lookup, never for tenant data. */
  adminPool: Pool;
  /** Pool whose connections can `SET ROLE qg_app`; all tenant data goes through withOrg. */
  pool: Pool;
  sessionSecret: string;
  internalSecret: string;
  authSecret: string; // action authorization signing
  secrets: SecretStore;
  resolver: Resolver;
  fetchImpl: (url: string) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  executor: Executor;
  verifier: Verifier;
  outcomes: OutcomeEvaluator;
  scopeFor: (a: ActionRecord) => string;
  now?: () => number;
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyRequest { session?: Session; orgIdFromKey?: string }
}

const Email = z.string().email().max(254).transform((s) => s.toLowerCase());
const Password = z.string().min(10).max(200);

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const now = d.now ?? Date.now;
  const app = Fastify({ logger: d.logger ? { redact: ["req.headers.authorization"] } : false, bodyLimit: 1_000_000 });

  // Command endpoints (approve/run) legitimately carry no body.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { done(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }), undefined); }
  });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    if (err instanceof EngineError) return reply.code(409).send({ error: "conflict", message: err.message });
    if (err instanceof ToolDeniedError) return reply.code(403).send({ error: "tool_denied", message: err.message });
    if (err instanceof UnsafeUrlError) return reply.code(422).send({ error: "unsafe_url", message: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: err.message });
    app.log.error(redact({ err: err.message }));
    return reply.code(500).send({ error: "internal_error" }); // never leak internals
  });

  // ---- auth helpers ----
  const bearer = (req: FastifyRequest) => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const requireSession = async (req: FastifyRequest, minRole: Role = "member") => {
    const tok = bearer(req);
    const s = tok ? verifySession(tok, d.sessionSecret, now()) : null;
    if (!s) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    const rank = { member: 0, admin: 1, owner: 2 };
    if (rank[s.role] < rank[minRole]) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    req.session = s;
    return s;
  };
  const requireInternal = (req: FastifyRequest) => {
    if (req.headers["x-internal-secret"] !== d.internalSecret) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
  };
  const tenant = <T>(s: Session, fn: (c: PoolClient) => Promise<T>) => withOrg(d.pool, s.orgId, fn);

  const currentPolicy = async (c: PoolClient, orgId: string): Promise<Policy> => {
    const r = await c.query("SELECT policy FROM policy_versions WHERE organization_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1", [orgId]);
    return (r.rows[0]?.policy as Policy) ?? ZERO_SPEND_POLICY;
  };
  const engineFor = (c: PoolClient, orgId: string) => new GrowthEngine({
    store: new PgActionStore(c), authSecret: d.authSecret, now, scopeFor: d.scopeFor,
    policies: { current: (o) => currentPolicy(c, o) }, executor: d.executor, verifier: d.verifier, outcomes: d.outcomes,
  });

  // ---- public ----
  app.get("/healthz", async () => ({ ok: true }));

  app.post("/v1/signup", async (req, reply) => {
    const b = z.object({ email: Email, password: Password, orgName: z.string().min(1).max(100) }).parse(req.body);
    const hash = await hashPassword(b.password);
    const c = await d.adminPool.connect();
    try {
      await c.query("BEGIN");
      const u = await c.query("INSERT INTO users (email, password_hash) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING RETURNING id", [b.email, hash]);
      if (!u.rows[0]) { await c.query("ROLLBACK"); return reply.code(409).send({ error: "email_taken" }); }
      const o = await c.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [b.orgName]);
      await c.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'owner')", [o.rows[0].id, u.rows[0].id]);
      await c.query("COMMIT");
      const s: Session = { userId: u.rows[0].id, orgId: o.rows[0].id, role: "owner", exp: now() + 12 * 3600_000 };
      return reply.code(201).send({ token: signSession(s, d.sessionSecret), orgId: s.orgId });
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  });

  app.post("/v1/login", async (req, reply) => {
    const b = z.object({ email: Email, password: z.string().max(200) }).parse(req.body);
    const u = (await d.adminPool.query("SELECT id, password_hash FROM users WHERE email=$1", [b.email])).rows[0];
    const ok = await verifyPassword(b.password, u?.password_hash ?? null);
    if (!u || !ok) return reply.code(401).send({ error: "invalid_credentials" });
    const m = (await d.adminPool.query("SELECT organization_id, role FROM organization_members WHERE user_id=$1 ORDER BY created_at LIMIT 1", [u.id])).rows[0];
    if (!m) return reply.code(403).send({ error: "no_organization" });
    return { token: signSession({ userId: u.id, orgId: m.organization_id, role: m.role, exp: now() + 12 * 3600_000 }, d.sessionSecret), orgId: m.organization_id };
  });

  // ---- onboarding / funnel ----
  app.post("/v1/onboarding/analyze", async (req, reply) => {
    const s = await requireSession(req, "admin");
    const b = z.object({ url: z.string().url(), name: z.string().max(100).optional() }).parse(req.body);
    const page = await safeFetch(b.url, { resolve: d.resolver, fetchImpl: d.fetchImpl });
    const profile = analyzeHtml(page.body);
    const out = await tenant(s, async (c) => {
      const p = await c.query("INSERT INTO products (organization_id, name, primary_url) VALUES ($1,$2,$3) RETURNING id", [s.orgId, b.name ?? profile.name ?? new URL(page.finalUrl).hostname, page.finalUrl]);
      const v = (await c.query("SELECT COALESCE(max(version),0)+1 AS v FROM product_profiles WHERE product_id=$1", [p.rows[0].id])).rows[0].v;
      await c.query("INSERT INTO product_profiles (organization_id, product_id, version, profile, evidence) VALUES ($1,$2,$3,$4,$5)", [s.orgId, p.rows[0].id, v, profile, JSON.stringify(profile.evidence)]);
      return { productId: p.rows[0].id as string };
    });
    return reply.code(201).send({ ...out, profile, status: "draft" });
  });

  const FunnelBody = z.object({
    productId: z.string().uuid(),
    primaryConversion: z.string(), activationEvent: z.string(), signupEvent: z.string(), churnEvent: z.string().optional(), retentionEvent: z.string().optional(),
    retentionWindowDays: z.number(), billingSource: z.string(), acquisitionObjective: z.string(), guardrails: z.array(z.string()),
    billingSourceConnected: z.boolean().default(false),
  });
  app.post("/v1/funnel/define", async (req, reply) => {
    const s = await requireSession(req, "admin");
    const b = FunnelBody.parse(req.body);
    const v = validateGrowthContract(b);
    if (!v.ok) return reply.code(422).send({ error: "invalid_growth_contract", errors: v.errors });
    const def: FunnelDefinition & Record<string, unknown> = {
      events: { signup: b.signupEvent, activation: b.activationEvent, paid: b.primaryConversion, retention: b.retentionEvent, churn: b.churnEvent },
      retentionWindowDays: b.retentionWindowDays, billingSourceConnected: b.billingSourceConnected,
      billingSource: b.billingSource, acquisitionObjective: b.acquisitionObjective, guardrails: b.guardrails,
    };
    const version = await tenant(s, async (c) => {
      const exists = await c.query("SELECT 1 FROM products WHERE id=$1", [b.productId]);
      if (!exists.rowCount) throw Object.assign(new Error("product not found"), { statusCode: 404 });
      await c.query("UPDATE funnel_definitions SET active=false WHERE product_id=$1 AND active", [b.productId]);
      const n = (await c.query("SELECT COALESCE(max(version),0)+1 AS v FROM funnel_definitions WHERE product_id=$1", [b.productId])).rows[0].v;
      await c.query("INSERT INTO funnel_definitions (organization_id, product_id, version, definition, active) VALUES ($1,$2,$3,$4,true)", [s.orgId, b.productId, n, def]);
      return n as number;
    });
    return reply.code(201).send({ version });
  });

  // ---- events (API key) ----
  app.post("/v1/events", async (req, reply) => {
    const tok = bearer(req);
    if (!tok) return reply.code(401).send({ error: "unauthorized" });
    const orgId = (await d.pool.query("SELECT qg_org_for_api_key($1) AS id", [hashApiKey(tok)])).rows[0]?.id as string | null;
    if (!orgId) return reply.code(401).send({ error: "unauthorized" });
    const { events } = z.object({ events: z.array(z.record(z.unknown())).min(1).max(500) }).parse(req.body);
    const res = await withOrg(d.pool, orgId, (c) => ingestEvents(c, orgId, events as never, now()));
    return reply.code(res.accepted + res.duplicates > 0 ? 202 : 422).send(res);
  });

  app.post("/v1/api-keys", async (req, reply) => {
    const s = await requireSession(req, "admin");
    const { name } = z.object({ name: z.string().min(1).max(60) }).parse(req.body);
    const k = newApiKey();
    await tenant(s, (c) => c.query("INSERT INTO api_keys (organization_id, name, key_hash, prefix) VALUES ($1,$2,$3,$4)", [s.orgId, name, k.hash, k.prefix]));
    return reply.code(201).send({ key: k.key, prefix: k.prefix }); // shown once; only the hash is stored
  });

  // ---- reads ----
  const loadFunnel = async (c: PoolClient, orgId: string) => {
    const f = (await c.query("SELECT definition FROM funnel_definitions WHERE organization_id=$1 AND active LIMIT 1", [orgId])).rows[0]?.definition as (FunnelDefinition) | undefined;
    const since = new Date(now() - 90 * 86_400_000);
    const ev = await resolvedEvents(c, orgId, since);
    const observed = new Set(ev.map((e) => e.event));
    const completeness = f ? evaluateCompleteness(f, observed) : null;
    const counts = f?.events.signup && f.events.activation && f.events.paid
      ? funnelCounts(ev, { signup: f.events.signup, activation: f.events.activation, paid: f.events.paid, retention: f.events.retention }, f.retentionWindowDays ?? 30)
      : null;
    return { definition: f ?? null, completeness, counts };
  };

  app.get("/v1/funnel", async (req) => {
    const s = await requireSession(req);
    return tenant(s, async (c) => {
      const r = await loadFunnel(c, s.orgId);
      // Subscriber claims are only made when billing truth exists (MR §3).
      return { ...r, subscribersReportable: r.completeness?.mayReportSubscribers ?? false };
    });
  });

  app.get("/v1/dashboard", async (req) => {
    const s = await requireSession(req);
    return tenant(s, async (c) => {
      const f = await loadFunnel(c, s.orgId);
      const actions = (await c.query("SELECT status, count(*)::int n FROM actions WHERE organization_id=$1 GROUP BY status", [s.orgId])).rows;
      const cost = (await c.query("SELECT COALESCE(sum(cost_usd),0) AS m FROM model_usage WHERE organization_id=$1 AND at >= date_trunc('month', now())", [s.orgId])).rows[0].m;
      const ext = (await c.query("SELECT COALESCE(sum(amount_usd),0) AS m FROM external_spend_ledger WHERE organization_id=$1 AND at >= date_trunc('month', now())", [s.orgId])).rows[0].m;
      return {
        funnel: f.counts, completeness: f.completeness, instrumentationWarning: !f.completeness || f.completeness.gaps.length > 0,
        actionsByStatus: Object.fromEntries(actions.map((a) => [a.status, a.n])), awaitingApproval: actions.find((a) => a.status === "NEEDS_APPROVAL")?.n ?? 0,
        economics: { modelCostUsdMonth: Number(cost), externalSpendUsdMonth: Number(ext) },
      };
    });
  });

  app.get("/v1/opportunities", async (req) => {
    const s = await requireSession(req);
    return tenant(s, async (c) => ({ opportunities: (await c.query("SELECT id, domain, funnel_stage, kind, score, status, evidence_json FROM opportunities WHERE organization_id=$1 ORDER BY score DESC NULLS LAST LIMIT 100", [s.orgId])).rows }));
  });

  app.get("/v1/actions", async (req) => {
    const s = await requireSession(req);
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return tenant(s, async (c) => ({ actions: (await c.query(
      `SELECT id, domain, type, target_metric, rationale, status, requires_approval, risk_level, estimated_external_cost_usd, estimated_model_cost_usd, created_at
         FROM actions WHERE organization_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $3`, [s.orgId, q.status ?? null, q.limit])).rows }));
  });

  app.get("/v1/experiments", async (req) => {
    const s = await requireSession(req);
    return tenant(s, async (c) => ({ experiments: (await c.query("SELECT id, hypothesis, status, decision, start_at, end_at FROM experiments WHERE organization_id=$1 ORDER BY start_at DESC NULLS LAST, id DESC LIMIT 100", [s.orgId])).rows }));
  });

  app.get("/v1/product", async (req) => {
    const s = await requireSession(req);
    return tenant(s, async (c) => {
      const p = (await c.query("SELECT p.id, p.name, p.primary_url, p.mode, pp.profile, pp.status AS profile_status FROM products p LEFT JOIN LATERAL (SELECT profile, status FROM product_profiles WHERE product_id=p.id ORDER BY version DESC LIMIT 1) pp ON true WHERE p.organization_id=$1 ORDER BY p.created_at LIMIT 1", [s.orgId])).rows[0] ?? null;
      const f = await loadFunnel(c, s.orgId);
      return { product: p, funnelDefinition: f.definition, completeness: f.completeness };
    });
  });

  app.get("/v1/autopilot/policy", async (req) => {
    const s = await requireSession(req);
    return tenant(s, async (c) => ({ policy: await currentPolicy(c, s.orgId) }));
  });

  app.get("/v1/model-cost", async (req) => {
    const s = await requireSession(req);
    return tenant(s, async (c) => {
      const r = await c.query("SELECT to_char(date_trunc('month', at),'YYYY-MM') AS month, sum(cost_usd) AS cost_usd, sum(cached_input_tokens+uncached_input_tokens+output_tokens) AS tokens FROM model_usage WHERE organization_id=$1 GROUP BY 1 ORDER BY 1 DESC LIMIT 12", [s.orgId]);
      return { months: r.rows.map((x) => ({ month: x.month, costUsd: Number(x.cost_usd), tokens: Number(x.tokens) })) };
    });
  });

  // ---- actions ----
  app.get("/v1/actions/:id", async (req, reply) => {
    const s = await requireSession(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return tenant(s, async (c) => {
      const a = (await c.query("SELECT * FROM actions WHERE organization_id=$1 AND id=$2", [s.orgId, id])).rows[0];
      if (!a) return reply.code(404).send({ error: "not_found" });
      const receipts = (await c.query("SELECT provider, resource_id, receipt FROM external_changes WHERE action_id=$1", [id])).rows;
      const execs = (await c.query("SELECT status, receipt, finished_at FROM executions WHERE action_id=$1 ORDER BY started_at", [id])).rows;
      const audit = (await c.query("SELECT actor, event, at FROM audit_logs WHERE subject_id=$1 ORDER BY id", [id])).rows;
      return { action: { ...a, payload: undefined }, receipts, verifications: execs, audit };
    });
  });

  const actionCmd = (path: string, minRole: Role, fn: (e: GrowthEngine, s: Session, id: string, body: any) => Promise<unknown>) =>
    app.post(path, async (req) => {
      const s = await requireSession(req, minRole);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return tenant(s, async (c) => fn(engineFor(c, s.orgId), s, id, req.body ?? {}));
    });
  actionCmd("/v1/actions/:id/approve", "admin", async (e, s, id) => ({ status: (await e.approve(s.orgId, id, s.userId)).status }));
  actionCmd("/v1/actions/:id/reject", "admin", async (e, s, id, b) => ({ status: (await e.reject(s.orgId, id, s.userId, z.object({ reason: z.string().min(1) }).parse(b).reason)).status }));
  actionCmd("/v1/actions/:id/run", "admin", async (e, s, id) => { await e.queue(s.orgId, id); const r = await e.run(s.orgId, id); return { status: r.action.status, verification: r.verification }; });

  // ---- policy ----
  app.post("/v1/autopilot/policy", async (req, reply) => {
    const s = await requireSession(req, "owner");
    const b = z.object({
      maxModelSpendUsd: z.number().min(0).max(100_000), maxExternalSpendUsd: z.number().min(0).max(1_000_000).default(0),
      mode: z.enum(["zero_spend", "controlled_growth"]).default("zero_spend"),
      rules: z.record(z.enum(["deny", "require_approval", "allow_with_limits"])).default({}),
      maxActionsPerDay: z.number().int().min(0).max(1000).default(10),
    }).parse(req.body);
    for (const k of Object.keys(b.rules)) if (!(ACTION_TYPES as readonly string[]).includes(k)) return reply.code(422).send({ error: "unknown_action_type", type: k });
    if (b.mode === "zero_spend" && b.maxExternalSpendUsd !== 0) return reply.code(422).send({ error: "zero_spend_requires_zero_external_cap" });
    // Rules may only be tightened relative to the baseline unless the mode is controlled_growth.
    const loosening = Object.entries(b.rules).filter(([k, r]) => ZERO_SPEND_POLICY.rules[k as keyof Policy["rules"]] === "deny" && r !== "deny");
    if (b.mode === "zero_spend" && loosening.length) return reply.code(422).send({ error: "zero_spend_cannot_loosen_denials", types: loosening.map(([k]) => k) });
    const policy: Policy = { ...ZERO_SPEND_POLICY, mode: b.mode, maxExternalSpendUsd: b.maxExternalSpendUsd, maxModelSpendUsd: b.maxModelSpendUsd, limits: { maxActionsPerDay: b.maxActionsPerDay }, rules: { ...ZERO_SPEND_POLICY.rules, ...b.rules } };
    const version = await tenant(s, async (c) => {
      const n = (await c.query("SELECT count(*)::int+1 AS n FROM policy_versions WHERE organization_id=$1", [s.orgId])).rows[0].n;
      const label = `${b.mode}.v${n}`;
      await c.query("INSERT INTO policy_versions (organization_id, version, policy) VALUES ($1,$2,$3)", [s.orgId, label, { ...policy, version: label }]);
      // Pending approvals bound to the old version are void (MR §14.1).
      await c.query("UPDATE approvals SET invalidated_at=now() WHERE organization_id=$1 AND invalidated_at IS NULL", [s.orgId]);
      await c.query("INSERT INTO audit_logs (organization_id, actor, event, detail) VALUES ($1,$2,'policy_updated',$3)", [s.orgId, s.userId, { version: label }]);
      return label;
    });
    return reply.code(201).send({ version });
  });

  // ---- experiments ----
  app.post("/v1/experiments", async (req, reply) => {
    const s = await requireSession(req, "admin");
    const spec = z.object({
      hypothesis: z.string(), targetCohort: z.string(), treatment: z.string(), controlOrBaseline: z.string(), primaryMetric: z.string(),
      guardrailMetrics: z.array(z.string()), minimumSamplePerVariant: z.number(), minimumObservationDays: z.number(), treatmentShare: z.number(),
      touchesPricingOrEntitlements: z.boolean().default(false),
    }).parse(req.body) as ExperimentSpec;
    const errs = validateSpec(spec);
    if (errs.length) return reply.code(422).send({ error: "invalid_experiment", errors: errs });
    const id = await tenant(s, async (c) => (await c.query("INSERT INTO experiments (organization_id, hypothesis, spec) VALUES ($1,$2,$3) RETURNING id", [s.orgId, spec.hypothesis, spec])).rows[0].id);
    return reply.code(201).send({ id });
  });
  app.get("/v1/experiments/:id", async (req, reply) => {
    const s = await requireSession(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await tenant(s, (c) => c.query("SELECT id, hypothesis, spec, status, result, decision FROM experiments WHERE organization_id=$1 AND id=$2", [s.orgId, id]));
    return r.rows[0] ?? reply.code(404).send({ error: "not_found" });
  });

  // ---- integrations ----
  app.post("/v1/integrations/:provider/connect", async (req, reply) => {
    const s = await requireSession(req, "admin");
    const { provider } = z.object({ provider: z.enum(["stripe", "ga4", "gsc", "github", "email", "google_ads", "deepseek"]) }).parse(req.params);
    const b = z.object({ credential: z.string().min(1).max(10_000), scopes: z.array(z.string()).default([]) }).parse(req.body);
    const ref = await d.secrets.put(s.orgId, provider, b.credential);
    await tenant(s, async (c) => {
      const i = await c.query(`INSERT INTO integrations (organization_id, provider, status, scopes) VALUES ($1,$2,'healthy',$3)
        ON CONFLICT (organization_id, provider) DO UPDATE SET status='healthy', scopes=EXCLUDED.scopes RETURNING id`, [s.orgId, provider, JSON.stringify(b.scopes)]);
      await c.query("INSERT INTO credential_references (organization_id, integration_id, secret_ref) VALUES ($1,$2,$3)", [s.orgId, i.rows[0].id, ref]);
    });
    return reply.code(201).send({ provider, status: "healthy" }); // credential never echoed
  });
  app.get("/v1/integrations", async (req) => {
    const s = await requireSession(req);
    return tenant(s, async (c) => ({ integrations: (await c.query("SELECT provider, status, scopes, last_sync_at FROM integrations WHERE organization_id=$1 ORDER BY provider", [s.orgId])).rows }));
  });

  // ---- internal ----
  app.post("/internal/openclaw/events", async (req, reply) => {
    requireInternal(req);
    const b = z.object({ orgId: z.string().uuid(), actionId: z.string().uuid().optional(), type: z.string().max(80), payload: z.record(z.unknown()).default({}) }).parse(req.body);
    await withOrg(d.pool, b.orgId, (c) => c.query("INSERT INTO audit_logs (organization_id, actor, event, subject_type, subject_id, detail) VALUES ($1,'openclaw',$2,'action',$3,$4)", [b.orgId, b.type, b.actionId ?? null, redact(b.payload)]));
    return reply.code(202).send({ ok: true });
  });
  app.post("/internal/tools/:tool", async (req, reply) => {
    requireInternal(req);
    const { tool } = z.object({ tool: z.string().max(60) }).parse(req.params);
    const b = z.object({ orgId: z.string().uuid(), contract: z.unknown(), args: z.record(z.unknown()).default({}), callId: z.string().min(1).max(100) }).parse(req.body);
    const r = await withOrg(d.pool, b.orgId, (c) => runTool(b.contract, { callId: b.callId, tool, args: b.args }, { c, engine: engineFor(c, b.orgId), orgId: b.orgId, now }));
    return reply.code(r.status).send({ callId: b.callId, ok: r.ok, data: r.data, error: r.error });
  });

  app.post("/internal/verify/:actionId", async (req) => {
    requireInternal(req);
    const { actionId } = z.object({ actionId: z.string().uuid() }).parse(req.params);
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.body);
    return withOrg(d.pool, orgId, async (c) => {
      const a = await new PgActionStore(c).get(orgId, actionId);
      if (!a) throw Object.assign(new Error("not found"), { statusCode: 404 });
      const receipt = (await c.query("SELECT receipt FROM external_changes WHERE action_id=$1 ORDER BY created_at DESC LIMIT 1", [actionId])).rows[0]?.receipt;
      if (!receipt) throw Object.assign(new Error("no receipt"), { statusCode: 409 });
      return d.verifier.verify(a, receipt);
    });
  });

  return app;
}
