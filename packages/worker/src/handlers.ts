import type { PoolClient } from "pg";
import { withOrg } from "@quietgrowth/database";
import { GrowthEngine, PgActionStore } from "@quietgrowth/growth-engine";
import { ZERO_SPEND_POLICY, type Policy } from "@quietgrowth/policy-engine";
import { detectSeoOpportunities } from "@quietgrowth/connector-gsc";
import { candidateFromSignal } from "@quietgrowth/acquisition";
import { detectFunnelBottleneck, detectPlgOpportunities, type DetectedOpportunity } from "@quietgrowth/opportunity-detectors";
import { funnelCounts } from "@quietgrowth/metrics";
import { resolvedEvents } from "@quietgrowth/connector-product-events";
import { normalizeStripeEvent, reconcileSubscriptions } from "@quietgrowth/connector-billing";
import { evaluateCompleteness, type FunnelDefinition } from "@quietgrowth/domain";
import type { WorkerDeps } from "./ports.js";

const isoWeek = (ms: number): string => { const d = new Date(ms); const j = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return `${d.getUTCFullYear()}-W${String(Math.ceil(((+d - +j) / 86400000 + j.getUTCDay() + 1) / 7)).padStart(2, "0")}`; };

export const currentPolicy = async (c: PoolClient, orgId: string): Promise<Policy> =>
  ((await c.query("SELECT policy FROM policy_versions WHERE organization_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1", [orgId])).rows[0]?.policy as Policy) ?? ZERO_SPEND_POLICY;

export const engineFor = (d: WorkerDeps, c: PoolClient) => new GrowthEngine({
  store: new PgActionStore(c), authSecret: d.authSecret, now: d.now, scopeFor: d.scopeFor,
  policies: { current: (o) => currentPolicy(c, o) }, executor: d.executor, verifier: d.verifier, outcomes: d.outcomes,
});

/** True when background AI work must pause (model cap reached, MR §27). */
export async function modelCapReached(c: PoolClient, orgId: string): Promise<boolean> {
  const p = await currentPolicy(c, orgId);
  const spent = Number((await c.query("SELECT COALESCE(sum(cost_usd),0) s FROM model_usage WHERE organization_id=$1 AND at >= date_trunc('month', now())", [orgId])).rows[0].s);
  return spent >= p.maxModelSpendUsd;
}

async function upsertOpportunity(c: PoolClient, orgId: string, o: DetectedOpportunity): Promise<{ id: string; created: boolean }> {
  const r = await c.query(
    `INSERT INTO opportunities (organization_id, domain, funnel_stage, kind, dedupe_key, evidence_json, score) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (organization_id, dedupe_key) DO UPDATE SET score = EXCLUDED.score, evidence_json = EXCLUDED.evidence_json
     RETURNING id, (xmax = 0) AS created`, [orgId, o.domain, o.funnelStage, o.kind, o.dedupeKey, o.evidence, o.score]);
  return { id: r.rows[0].id, created: r.rows[0].created };
}

/** Billing reconcile (MR §27): normalise provider events, persist idempotently, rebuild observed subscriptions. */
export async function reconcileBilling(d: WorkerDeps, orgId: string): Promise<{ events: number; subscriptions: number }> {
  const events = await d.sources.billingEvents(orgId, new Date(d.now() - 90 * 86_400_000));
  return withOrg(d.pool, orgId, async (c) => {
    for (const e of events)
      await c.query(`INSERT INTO revenue_events (organization_id, provider_event_id, kind, customer_id, amount_cents, occurred_at, raw) VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7) ON CONFLICT DO NOTHING`, [orgId, e.providerEventId, e.kind, e.customerId, e.amountCents, e.occurredAt, e]);
    const all = (await c.query("SELECT raw FROM revenue_events WHERE organization_id=$1", [orgId])).rows.map((r) => r.raw);
    const subs = reconcileSubscriptions(all);
    for (const s of subs.values())
      await c.query(`INSERT INTO subscriptions_observed (organization_id, external_id, customer_id, plan, status, mrr_cents, started_at, cancelled_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),to_timestamp($8/1000.0),now())
        ON CONFLICT (organization_id, external_id) DO UPDATE SET plan=EXCLUDED.plan, status=EXCLUDED.status, mrr_cents=EXCLUDED.mrr_cents, cancelled_at=EXCLUDED.cancelled_at, updated_at=now()`,
        [orgId, s.subscriptionId, s.customerId, s.plan ?? null, s.status, s.mrrCents, s.startedAt ?? null, s.cancelledAt ?? null]);
    return { events: events.length, subscriptions: subs.size };
  });
}
void normalizeStripeEvent;

/** Detect opportunities (SEO + funnel + PLG), persist them, and turn the top ones into policy-gated proposals. */
export async function detectAndPropose(d: WorkerDeps, orgId: string): Promise<{ detected: number; proposed: number; blocked: number; needsApproval: number; autoApproved: number; paused?: boolean }> {
  const gsc = await d.sources.gscRows(orgId);
  const plg = await d.sources.plgFacts(orgId);
  return withOrg(d.pool, orgId, async (c) => {
    const res = { detected: 0, proposed: 0, blocked: 0, needsApproval: 0, autoApproved: 0 };
    if (await modelCapReached(c, orgId)) return { ...res, paused: true };
    const week = isoWeek(d.now());
    const found: DetectedOpportunity[] = [];

    for (const s of gsc ? detectSeoOpportunities(gsc) : []) {
      const k = candidateFromSignal(s, orgId);
      found.push({ dedupeKey: k.dedupeKey, domain: "acquisition", funnelStage: "visitor_to_signup", kind: `seo_${k.kind}`, score: k.score, evidence: k.evidence as Record<string, unknown> });
    }
    const fdef = (await c.query("SELECT definition FROM funnel_definitions WHERE organization_id=$1 AND active LIMIT 1", [orgId])).rows[0]?.definition as FunnelDefinition | undefined;
    if (fdef?.events.signup && fdef.events.activation && fdef.events.paid) {
      const ev = await resolvedEvents(c, orgId, new Date(d.now() - 90 * 86_400_000));
      // Never rank funnel stages when instrumentation is incomplete: that would optimise noise (MR §3).
      const comp = evaluateCompleteness(fdef, new Set(ev.map((e) => e.event)));
      if (comp.funnelReliable) found.push(...detectFunnelBottleneck(funnelCounts(ev, { signup: fdef.events.signup, activation: fdef.events.activation, paid: fdef.events.paid, retention: fdef.events.retention }, fdef.retentionWindowDays ?? 30), week));
    }
    if (plg) found.push(...detectPlgOpportunities(plg, week));

    const saved: (DetectedOpportunity & { id: string; created: boolean })[] = [];
    for (const o of found) { const s = await upsertOpportunity(c, orgId, o); saved.push({ ...o, ...s }); }
    res.detected = saved.length;

    const engine = engineFor(d, c);
    const candidates = saved.filter((o) => !o.insufficientData && o.score > 0).sort((a, b) => b.score - a.score);
    for (const o of candidates) {
      if (res.proposed >= d.maxProposalsPerTick) break;
      const open = await c.query("SELECT 1 FROM actions WHERE organization_id=$1 AND opportunity_id=$2 AND status NOT IN ('FAILED','BLOCKED','EVALUATED') LIMIT 1", [orgId, o.id]);
      if (open.rowCount) continue; // one live action per opportunity
      const draft = await d.drafter.draft(orgId, o, c);
      if (!draft) continue;
      const { action, created } = await engine.propose({ ...draft, opportunityId: o.id });
      if (!created) continue;
      res.proposed++;
      if (action.status === "BLOCKED") res.blocked++; else if (action.status === "NEEDS_APPROVAL") res.needsApproval++; else res.autoApproved++;
    }
    if (res.needsApproval > 0) await d.notify?.(orgId, "approvals_pending", { count: res.needsApproval });
    return res;
  });
}

/** Execute AUTO_APPROVED and approved actions, respecting the model cap and policy version bindings. */
export async function executeReady(d: WorkerDeps, orgId: string): Promise<{ ran: number; succeeded: number; failed: number; paused?: boolean; notReady?: string[] }> {
  return withOrg(d.pool, orgId, async (c) => {
    if (await modelCapReached(c, orgId)) return { ran: 0, succeeded: 0, failed: 0, paused: true };
    const rd = await d.readiness(c, orgId);
    if (!rd.ready) return { ran: 0, succeeded: 0, failed: 0, notReady: rd.blocking }; // MR Appendix B: no writes until ready
    const engine = engineFor(d, c);
    const ready = (await c.query("SELECT id FROM actions WHERE organization_id=$1 AND status IN ('AUTO_APPROVED','APPROVED') ORDER BY created_at LIMIT 20", [orgId])).rows;
    const out = { ran: 0, succeeded: 0, failed: 0 };
    for (const r of ready) {
      try {
        await engine.queue(orgId, r.id);
        const res = await engine.run(orgId, r.id);
        out.ran++;
        if (res.action.status === "SUCCEEDED") { out.succeeded++; await engine.observe(orgId, r.id); } else out.failed++;
      } catch (e) {
        // A stale approval (policy changed) must not block the rest of the batch.
        await c.query("INSERT INTO audit_logs (organization_id, actor, event, subject_type, subject_id, detail) VALUES ($1,'worker','execute_skipped','action',$2,$3)", [orgId, r.id, { error: e instanceof Error ? e.message : String(e) }]);
      }
    }
    if (out.failed > 0) await d.notify?.(orgId, "actions_failed", { count: out.failed });
    return out;
  });
}

/** Evaluate outcomes for actions whose observation window has elapsed. */
export async function evaluateDue(d: WorkerDeps, orgId: string): Promise<{ evaluated: number }> {
  return withOrg(d.pool, orgId, async (c) => {
    const engine = engineFor(d, c);
    const due = (await c.query("SELECT id FROM actions WHERE organization_id=$1 AND status='OBSERVING' AND executed_at <= $2", [orgId, new Date(d.now() - d.observationDays * 86_400_000)])).rows;
    for (const r of due) await engine.evaluateOutcome(orgId, r.id);
    return { evaluated: due.length };
  });
}
