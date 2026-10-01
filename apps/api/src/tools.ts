import type { PoolClient } from "pg";
import { z } from "zod";
import { WorkContract, Proposal, isMutationTool, type ToolName } from "@quietgrowth/agent-contracts";
import { gateToolCall, ToolDeniedError } from "@quietgrowth/runtime-manager";
import { funnelCounts } from "@quietgrowth/metrics";
import { resolvedEvents } from "@quietgrowth/connector-product-events";
import type { FunnelDefinition } from "@quietgrowth/domain";
import type { GrowthEngine } from "@quietgrowth/growth-engine";

// Control-plane tool router for the OpenClaw quietgrowth-tools plugin (MR §9.1).
// Agents never hold provider credentials: reads come from QuietGrowth state; writes are proposals only.
export const ProposeArgs = Proposal.extend({ payload: z.record(z.unknown()).optional() }).omit({ estimatedExternalCostUsd: true, estimatedModelCostUsd: true }).extend({
  estimatedExternalCostUsd: z.number().min(0).default(0), estimatedModelCostUsd: z.number().min(0).default(0), idempotencyKey: z.string().min(1).max(200),
});

export interface ToolContext { c: PoolClient; engine: GrowthEngine; orgId: string; now: () => number }

export async function runTool(rawContract: unknown, rawCall: unknown, ctx: ToolContext): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const contract = WorkContract.parse(rawContract);
  if (contract.orgId !== ctx.orgId) throw new ToolDeniedError("contract organization mismatch"); // tenant comes from the contract, never from tool args
  const call = gateToolCall(rawCall, contract);
  const tool = call.tool as ToolName;

  if (isMutationTool(tool))
    return { ok: false, status: 409, error: "mutations execute through the policy-gated action queue; submit propose_action" };

  switch (tool) {
    case "read_analytics": {
      const f = (await ctx.c.query("SELECT definition FROM funnel_definitions WHERE organization_id=$1 AND active LIMIT 1", [ctx.orgId])).rows[0]?.definition as FunnelDefinition | undefined;
      if (!f?.events.signup || !f.events.activation || !f.events.paid) return { ok: true, status: 200, data: { funnel: null, note: "funnel not defined" } };
      const ev = await resolvedEvents(ctx.c, ctx.orgId, new Date(ctx.now() - 90 * 86_400_000));
      return { ok: true, status: 200, data: { funnel: funnelCounts(ev, { signup: f.events.signup, activation: f.events.activation, paid: f.events.paid, retention: f.events.retention }, f.retentionWindowDays ?? 30) } };
    }
    case "read_billing": {
      const r = await ctx.c.query("SELECT status, count(*)::int n, COALESCE(sum(mrr_cents),0)::bigint mrr FROM subscriptions_observed WHERE organization_id=$1 GROUP BY status", [ctx.orgId]);
      return { ok: true, status: 200, data: { subscriptions: r.rows.map((x) => ({ status: x.status, count: x.n, mrrCents: Number(x.mrr) })) } };
    }
    case "read_search_console": {
      const r = await ctx.c.query("SELECT metric, dimension, value, at FROM metric_points WHERE organization_id=$1 AND source='gsc' ORDER BY at DESC LIMIT 500", [ctx.orgId]);
      return { ok: true, status: 200, data: { points: r.rows } };
    }
    case "read_site": {
      const r = await ctx.c.query("SELECT url, content_hash, captured_at FROM page_snapshots WHERE organization_id=$1 ORDER BY captured_at DESC LIMIT 200", [ctx.orgId]);
      return { ok: true, status: 200, data: { pages: r.rows } };
    }
    case "propose_action": {
      const a = ProposeArgs.parse(call.args);
      const { action, decision } = await ctx.engine.propose({
        orgId: ctx.orgId, domain: a.domain, type: a.type, targetMetric: a.targetMetric, guardrailMetrics: a.guardrailMetrics, rationale: a.rationale,
        evidence: a.evidenceRefs, expectedIncrementalImpact: a.expectedIncrementalImpact, confidence: a.confidence,
        estimatedExternalCostUsd: a.estimatedExternalCostUsd, estimatedModelCostUsd: a.estimatedModelCostUsd, idempotencyKey: a.idempotencyKey, payload: a.payload ?? null,
      });
      return { ok: true, status: 202, data: { actionId: action.id, status: action.status, verdict: decision.verdict, reasons: decision.reasons } };
    }
    default:
      return { ok: false, status: 501, error: `tool ${tool} is not available in this deployment` };
  }
}
