import { randomUUID } from "node:crypto";
import type { ActionState } from "@quietgrowth/domain";
import type { SpendState } from "@quietgrowth/policy-engine";
import type { WriteReceipt } from "@quietgrowth/connectors-core";
import type { Verification } from "@quietgrowth/verification";
import type { ActionRecord, ActionStore, AuditEntry, NewAction } from "./types.js";

/** In-memory ActionStore for tests and local simulation. */
export class MemoryActionStore implements ActionStore {
  readonly actions = new Map<string, ActionRecord>();
  readonly auditLog: (AuditEntry & { orgId: string })[] = [];
  readonly receipts = new Map<string, WriteReceipt>();
  readonly verifications = new Map<string, Verification>();
  readonly approvals: { orgId: string; actionId: string; decision: "approved" | "rejected"; policyVersion: string }[] = [];
  spend: SpendState = { externalSpendUsd: 0, modelSpendUsd: 0, actionsToday: {} };

  async insert(n: NewAction) {
    for (const a of this.actions.values()) if (a.orgId === n.orgId && a.idempotencyKey === n.idempotencyKey) return { action: a, created: false };
    const action: ActionRecord = { ...n, id: randomUUID(), status: "DISCOVERED", requiresApproval: true, policyVersion: "" };
    this.actions.set(action.id, action);
    return { action, created: true };
  }
  async get(orgId: string, id: string) { const a = this.actions.get(id); return a && a.orgId === orgId ? { ...a } : null; }
  async setStatus(orgId: string, id: string, from: ActionState, to: ActionState, patch = {}) {
    const a = this.actions.get(id);
    if (!a || a.orgId !== orgId || a.status !== from) return false;
    Object.assign(a, patch, { status: to });
    return true;
  }
  async audit(orgId: string, e: AuditEntry) { this.auditLog.push({ ...e, orgId }); }
  async saveReceipt(_o: string, id: string, r: WriteReceipt) { this.receipts.set(id, r); }
  async saveVerification(_o: string, id: string, v: Verification) { this.verifications.set(id, v); }
  async recordApproval(orgId: string, actionId: string, a: { decision: "approved" | "rejected"; policyVersion: string }) { this.approvals.push({ orgId, actionId, decision: a.decision, policyVersion: a.policyVersion }); }
  async latestApproval(orgId: string, actionId: string) {
    const l = [...this.approvals].reverse().find((x) => x.orgId === orgId && x.actionId === actionId);
    return l ? { policyVersion: l.policyVersion, decision: l.decision } : null;
  }
  async spendState() { return this.spend; }
}
