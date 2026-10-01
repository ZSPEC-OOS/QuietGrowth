import type { PoolClient } from "pg";
import { withOrg } from "@quietgrowth/database";
import { segmentsFor, type LifecycleSegment, type UserFacts } from "@quietgrowth/connector-email";
import type { FunnelDefinition } from "@quietgrowth/domain";
import type { WorkerDeps } from "./ports.js";
import { engineFor, modelCapReached } from "./handlers.js";

export const MIN_SEGMENT_SIZE = 5;

/** Baseline copy used when no agent draft is available; deterministic and claim-free. */
export const BASELINE_COPY: Record<LifecycleSegment, { subject: string; text: string }> = {
  new_signup: { subject: "Getting started", text: "Welcome! Here is the fastest way to reach your first success." },
  not_activated: { subject: "Need a hand getting set up?", text: "You signed up but haven't reached your first success yet. Reply and we will help." },
  activated_not_paid: { subject: "Ready for more?", text: "You have been getting value. See which plan fits how you use the product." },
  trial_ending: { subject: "Your trial ends soon", text: "Your trial ends in a few days. Here is what changes and how to continue." },
  dormant: { subject: "We miss you", text: "It has been a while. Here is what is new since you last visited." },
  churn_risk: { subject: "Is something not working?", text: "We noticed less activity. Tell us what would help." },
  cancelled: { subject: "Sorry to see you go", text: "Your subscription has ended. If it was something we can fix, tell us." },
  reactivated: { subject: "Welcome back", text: "Good to have you back. Here is what is new." },
};

async function userFacts(c: PoolClient, orgId: string, f: FunnelDefinition, since: Date): Promise<Map<string, UserFacts>> {
  const names = [f.events.signup, f.events.activation, f.events.paid, f.events.churn].filter(Boolean) as string[];
  const r = await c.query(
    `SELECT COALESCE(e.user_id, l.user_id, e.anonymous_id) AS subject, e.event, min(e.occurred_at) AS first_at, max(e.occurred_at) AS last_at
       FROM conversion_events e LEFT JOIN identity_links l ON l.organization_id=e.organization_id AND l.anonymous_id=e.anonymous_id
      WHERE e.organization_id=$1 AND e.occurred_at >= $2 GROUP BY 1, 2`, [orgId, since]);
  const m = new Map<string, UserFacts>();
  for (const x of r.rows) {
    const u = m.get(x.subject) ?? { signedUpAt: Number.POSITIVE_INFINITY };
    const first = new Date(x.first_at).getTime(), last = new Date(x.last_at).getTime();
    if (x.event === f.events.signup) u.signedUpAt = Math.min(u.signedUpAt, first);
    if (x.event === f.events.activation) u.activatedAt = Math.min(u.activatedAt ?? Infinity, first);
    if (x.event === f.events.paid) u.paidAt = Math.min(u.paidAt ?? Infinity, first);
    if (x.event === f.events.churn) u.cancelledAt = Math.max(u.cancelledAt ?? 0, last);
    u.lastActiveAt = Math.max(u.lastActiveAt ?? 0, last);
    m.set(x.subject, u);
  }
  void names;
  for (const [k, u] of m) if (!Number.isFinite(u.signedUpAt)) m.delete(k); // only known signups are messaged
  return m;
}

/** Deterministic segmentation then one campaign proposal per sizeable segment (existing users only). */
export async function lifecycleTick(d: WorkerDeps, orgId: string, week: string): Promise<{ segments: Record<string, number>; proposed: number }> {
  return withOrg(d.pool, orgId, async (c) => {
    if (await modelCapReached(c, orgId)) return { segments: {}, proposed: 0 };
    const f = (await c.query("SELECT definition FROM funnel_definitions WHERE organization_id=$1 AND active LIMIT 1", [orgId])).rows[0]?.definition as FunnelDefinition | undefined;
    if (!f?.events.signup) return { segments: {}, proposed: 0 };
    const facts = await userFacts(c, orgId, f, new Date(d.now() - 120 * 86_400_000));
    const bySeg = new Map<LifecycleSegment, string[]>();
    for (const [subject, u] of facts) for (const s of segmentsFor(u, d.now())) bySeg.set(s, [...(bySeg.get(s) ?? []), subject]);
    const out: Record<string, number> = {}; let proposed = 0;
    const engine = engineFor(d, c);
    for (const [seg, subjects] of bySeg) {
      out[seg] = subjects.length;
      if (subjects.length < MIN_SEGMENT_SIZE) continue; // small segments: no campaign (privacy and signal)
      const copy = BASELINE_COPY[seg];
      const { created } = await engine.propose({
        orgId, domain: seg === "not_activated" || seg === "new_signup" ? "activation" : seg === "activated_not_paid" || seg === "trial_ending" ? "conversion" : "retention",
        type: "lifecycle_email_existing_users", channel: "email", targetMetric: seg === "activated_not_paid" ? "paid_conversion" : seg === "not_activated" || seg === "new_signup" ? "activation_rate" : "retention",
        guardrailMetrics: ["unsubscribe_rate", "support_load"], rationale: `${subjects.length} existing users are in segment "${seg}" (rule-based). Baseline message prepared; success is measured by downstream outcomes, not opens.`,
        evidence: [{ segment: seg, size: subjects.length }], expectedIncrementalImpact: 0.3, confidence: 0.4, estimatedExternalCostUsd: 0, estimatedModelCostUsd: 0,
        idempotencyKey: `lifecycle:${seg}:${week}`, payload: { segment: seg, subjectIds: subjects, subject: copy.subject, text: copy.text },
      });
      if (created) proposed++;
    }
    return { segments: out, proposed };
  });
}
