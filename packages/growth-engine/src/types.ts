import type { ActionState } from "@quietgrowth/domain";
import type { Decision } from "@quietgrowth/policy-engine";
import type { WriteReceipt } from "@quietgrowth/connectors-core";
import type { Verification } from "@quietgrowth/verification";

export interface ActionRecord {
  id: string;
  orgId: string;
  opportunityId?: string;
  domain: string;
  type: string;
  channel?: string;
  targetMetric: string;
  guardrailMetrics: string[];
  rationale: string;
  evidence: unknown;
  expectedIncrementalImpact: number;
  confidence: number;
  estimatedExternalCostUsd: number;
  estimatedModelCostUsd: number;
  status: ActionState;
  requiresApproval: boolean;
  policyVersion: string;
  idempotencyKey: string;
  payload: unknown;
}

export interface NewAction extends Omit<ActionRecord, "id" | "status" | "requiresApproval" | "policyVersion"> {}

export interface AuditEntry { actor: string; event: string; subjectId?: string; detail?: Record<string, unknown> }

/** Persistence port. The Postgres implementation is tenant-bound by construction. */
export interface ActionStore {
  /** Idempotent on (org, idempotencyKey): returns the existing record when present. */
  insert(a: NewAction): Promise<{ action: ActionRecord; created: boolean }>;
  get(orgId: string, id: string): Promise<ActionRecord | null>;
  /** Compare-and-set status; false if the current status is not `from`. */
  setStatus(orgId: string, id: string, from: ActionState, to: ActionState, patch?: Partial<Pick<ActionRecord, "requiresApproval" | "policyVersion">>): Promise<boolean>;
  audit(orgId: string, e: AuditEntry): Promise<void>;
  saveReceipt(orgId: string, actionId: string, receipt: WriteReceipt): Promise<void>;
  saveVerification(orgId: string, actionId: string, v: Verification): Promise<void>;
  recordApproval(orgId: string, actionId: string, a: { decision: "approved" | "rejected"; userId: string; policyVersion: string; reason?: string }): Promise<void>;
  /** Latest valid (non-invalidated) approval for the action. */
  latestApproval(orgId: string, actionId: string): Promise<{ policyVersion: string; decision: "approved" | "rejected" } | null>;
  spendState(orgId: string): Promise<import("@quietgrowth/policy-engine").SpendState>;
}

export interface PolicyProvider { current(orgId: string): Promise<import("@quietgrowth/policy-engine").Policy> }

/** Executes one bounded mutation. Must only act using the supplied authorization token. */
export interface Executor { execute(a: ActionRecord, authorizationToken: string): Promise<WriteReceipt> }
export interface Verifier { verify(a: ActionRecord, receipt: WriteReceipt): Promise<Verification> }
/** Safe, pre-authorized rollback (e.g. closing an unmerged PR). Absent => escalate. */
export interface RollbackHandler { rollback(a: ActionRecord, receipt: WriteReceipt): Promise<boolean> }

export interface OutcomeEvaluator { evaluate(a: ActionRecord): Promise<{ label: "experimental" | "observational"; summary: Record<string, unknown>; guardrailsHeld: boolean }> }

export type ProposeResult = { action: ActionRecord; decision: Decision; created: boolean };
