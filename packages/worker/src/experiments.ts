import type { PoolClient } from "pg";
import { withOrg } from "@quietgrowth/database";
import { evaluateExperiment, type Arm, type ExperimentSpec } from "@quietgrowth/experiments";
import type { WorkerDeps } from "./ports.js";
import { engineFor } from "./handlers.js";

async function armStats(c: PoolClient, orgId: string, expId: string, event: string): Promise<Record<"control" | "treatment", Arm>> {
  const r = await c.query(
    `SELECT a.variant, count(DISTINCT a.subject_id)::int AS n,
            count(DISTINCT a.subject_id) FILTER (WHERE EXISTS (SELECT 1 FROM conversion_events e WHERE e.organization_id=a.organization_id AND e.event=$3
               AND COALESCE(e.user_id, e.anonymous_id)=a.subject_id AND e.occurred_at >= a.assigned_at))::int AS conversions
       FROM experiment_assignments a WHERE a.organization_id=$1 AND a.experiment_id=$2 GROUP BY a.variant`, [orgId, expId, event]);
  const out = { control: { n: 0, conversions: 0 }, treatment: { n: 0, conversions: 0 } };
  for (const x of r.rows) out[x.variant as "control" | "treatment"] = { n: x.n, conversions: x.conversions };
  return out;
}

/**
 * Evaluates running experiments with fixed-window rules (MR §11). A winner is only ever a *proposal*:
 * adoption becomes an approval-gated action; pricing/entitlement experiments are never auto-applied.
 */
export async function evaluateExperiments(d: WorkerDeps, orgId: string): Promise<{ evaluated: number; decisions: Record<string, number> }> {
  return withOrg(d.pool, orgId, async (c) => {
    const decisions: Record<string, number> = {};
    const running = (await c.query("SELECT id, spec, start_at FROM experiments WHERE organization_id=$1 AND status='running'", [orgId])).rows;
    const recent = Number((await c.query("SELECT count(*)::int n FROM conversion_events WHERE organization_id=$1 AND received_at >= $2", [orgId, new Date(d.now() - 48 * 3600_000)])).rows[0].n);
    for (const e of running) {
      const spec = e.spec as ExperimentSpec;
      const primary = await armStats(c, orgId, e.id, spec.primaryMetric);
      const guardrails = [];
      for (const g of spec.guardrailMetrics) { const s = await armStats(c, orgId, e.id, g); guardrails.push({ name: g, control: s.control, treatment: s.treatment }); }
      const days = e.start_at ? (d.now() - new Date(e.start_at).getTime()) / 86_400_000 : 0;
      const dec = evaluateExperiment({ spec, daysElapsed: days, primary, guardrails, instrumentationHealthy: recent > 0 });
      decisions[dec.decision] = (decisions[dec.decision] ?? 0) + 1;
      if (dec.decision === "continue") continue;
      const status = dec.decision === "stop_guardrail" ? "stopped" : dec.decision === "freeze_instrumentation" ? "frozen" : "completed";
      await c.query("UPDATE experiments SET status=$3, decision=$4, result=$5, end_at=CASE WHEN $3='frozen' THEN end_at ELSE now() END WHERE organization_id=$1 AND id=$2", [orgId, e.id, status, dec.decision, { ...dec, primary, guardrails }]);
      if (dec.decision === "propose_winner") {
        const type = spec.touchesPricingOrEntitlements ? "pricing_change" : "onboarding_experiment";
        await engineFor(d, c).propose({
          orgId, domain: "conversion", type, targetMetric: spec.primaryMetric, guardrailMetrics: spec.guardrailMetrics,
          rationale: `Experiment "${spec.hypothesis}" favours the treatment (${dec.reason}). Result is experimental; adoption needs your approval.`,
          evidence: [{ experimentId: e.id, primary, guardrails }], expectedIncrementalImpact: 0.5, confidence: 0.7,
          estimatedExternalCostUsd: 0, estimatedModelCostUsd: 0, idempotencyKey: `exp:${e.id}:winner`, payload: { experimentId: e.id, adopt: "treatment" },
        });
      }
    }
    if (decisions["stop_guardrail"] || decisions["freeze_instrumentation"]) await d.notify?.(orgId, "experiment_attention", decisions);
    return { evaluated: running.length, decisions };
  });
}
