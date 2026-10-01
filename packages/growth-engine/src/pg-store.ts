import type { PoolClient } from "pg";
import type { ActionState } from "@quietgrowth/domain";
import type { SpendState, ActionType } from "@quietgrowth/policy-engine";
import type { WriteReceipt } from "@quietgrowth/connectors-core";
import type { Verification } from "@quietgrowth/verification";
import type { ActionRecord, ActionStore, AuditEntry, NewAction } from "./types.js";

const toRecord = (r: any): ActionRecord => ({
  id: r.id, orgId: r.organization_id, opportunityId: r.opportunity_id ?? undefined, domain: r.domain, type: r.type, channel: r.channel ?? undefined,
  targetMetric: r.target_metric, guardrailMetrics: r.guardrail_metrics, rationale: r.rationale, evidence: r.evidence_json,
  expectedIncrementalImpact: Number(r.expected_incremental_impact ?? 0), confidence: Number(r.confidence_score ?? 0),
  estimatedExternalCostUsd: Number(r.estimated_external_cost_usd), estimatedModelCostUsd: Number(r.estimated_model_cost_usd),
  status: r.status, requiresApproval: r.requires_approval, policyVersion: r.policy_version ?? "", idempotencyKey: r.idempotency_key,
  payload: r.payload ?? null,
});

/**
 * Postgres ActionStore. Must be constructed with a client already bound to a tenant via
 * `withOrg`; every query additionally filters on organization_id (defence in depth over RLS).
 */
export class PgActionStore implements ActionStore {
  constructor(private readonly c: PoolClient) {}

  async insert(n: NewAction) {
    const r = await this.c.query(
      `INSERT INTO actions (organization_id, opportunity_id, domain, type, channel, target_metric, guardrail_metrics, rationale, evidence_json,
         expected_incremental_impact, confidence_score, estimated_external_cost_usd, estimated_model_cost_usd, idempotency_key, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING *`,
      [n.orgId, n.opportunityId ?? null, n.domain, n.type, n.channel ?? null, n.targetMetric, JSON.stringify(n.guardrailMetrics), n.rationale, JSON.stringify(n.evidence),
        n.expectedIncrementalImpact, n.confidence, n.estimatedExternalCostUsd, n.estimatedModelCostUsd, n.idempotencyKey, n.payload === undefined ? null : JSON.stringify(n.payload)],
    );
    if (r.rows[0]) return { action: toRecord(r.rows[0]), created: true };
    const e = await this.c.query("SELECT * FROM actions WHERE organization_id=$1 AND idempotency_key=$2", [n.orgId, n.idempotencyKey]);
    return { action: toRecord(e.rows[0]), created: false };
  }
  async get(orgId: string, id: string) {
    const r = await this.c.query("SELECT * FROM actions WHERE organization_id=$1 AND id=$2", [orgId, id]);
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }
  async setStatus(orgId: string, id: string, from: ActionState, to: ActionState, patch: Partial<Pick<ActionRecord, "requiresApproval" | "policyVersion">> = {}) {
    const r = await this.c.query(
      `UPDATE actions SET status=$4, requires_approval=COALESCE($5, requires_approval), policy_version=COALESCE($6, policy_version),
         approved_at = CASE WHEN $4='APPROVED' THEN now() ELSE approved_at END,
         executed_at = CASE WHEN $4='RUNNING' THEN now() ELSE executed_at END
       WHERE organization_id=$1 AND id=$2 AND status=$3`,
      [orgId, id, from, to, patch.requiresApproval ?? null, patch.policyVersion ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async audit(orgId: string, e: AuditEntry) {
    await this.c.query(`INSERT INTO audit_logs (organization_id, actor, event, subject_type, subject_id, detail) VALUES ($1,$2,$3,'action',$4,$5)`, [orgId, e.actor, e.event, e.subjectId ?? null, e.detail ?? {}]);
  }
  async saveReceipt(orgId: string, actionId: string, r: WriteReceipt) {
    await this.c.query(`INSERT INTO external_changes (organization_id, action_id, provider, resource_id, receipt) VALUES ($1,$2,$3,$4,$5)`, [orgId, actionId, r.provider, r.resourceId, r]);
  }
  async saveVerification(orgId: string, actionId: string, v: Verification) {
    await this.c.query(`INSERT INTO executions (organization_id, action_id, status, receipt, finished_at) VALUES ($1,$2,$3,$4,now())`, [orgId, actionId, v.ok ? "verified" : "verification_failed", v]);
  }
  async recordApproval(orgId: string, actionId: string, a: { decision: "approved" | "rejected"; userId: string; policyVersion: string; reason?: string }) {
    // decided_by references users; engine-driven approvals pass a user id that exists in the control plane.
    await this.c.query(`INSERT INTO approvals (organization_id, action_id, policy_version, decision, decided_by, reason) VALUES ($1,$2,$3,$4,$5,$6)`, [orgId, actionId, a.policyVersion, a.decision, a.userId, a.reason ?? null]);
  }
  async latestApproval(orgId: string, actionId: string) {
    const r = await this.c.query(`SELECT policy_version, decision FROM approvals WHERE organization_id=$1 AND action_id=$2 AND invalidated_at IS NULL ORDER BY decided_at DESC LIMIT 1`, [orgId, actionId]);
    return r.rows[0] ? { policyVersion: r.rows[0].policy_version, decision: r.rows[0].decision } : null;
  }
  async spendState(orgId: string): Promise<SpendState> {
    const ext = await this.c.query(`SELECT COALESCE(sum(amount_usd),0) AS s FROM external_spend_ledger WHERE organization_id=$1 AND at >= date_trunc('month', now())`, [orgId]);
    const mod = await this.c.query(`SELECT COALESCE(sum(cost_usd),0) AS s FROM model_usage WHERE organization_id=$1 AND at >= date_trunc('month', now())`, [orgId]);
    const today = await this.c.query(`SELECT type, count(*)::int AS n FROM actions WHERE organization_id=$1 AND created_at >= date_trunc('day', now()) GROUP BY type`, [orgId]);
    return { externalSpendUsd: Number(ext.rows[0].s), modelSpendUsd: Number(mod.rows[0].s), actionsToday: Object.fromEntries(today.rows.map((r) => [r.type as ActionType, r.n])) };
  }
}
