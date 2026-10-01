import { transition, type ActionState } from "@quietgrowth/domain";
import { evaluate, signAuthorization, type Decision } from "@quietgrowth/policy-engine";
import type { Verification } from "@quietgrowth/verification";
import type { ActionRecord, ActionStore, Executor, NewAction, OutcomeEvaluator, PolicyProvider, ProposeResult, RollbackHandler, Verifier } from "./types.js";

export class EngineError extends Error {}

export interface EngineDeps {
  store: ActionStore;
  policies: PolicyProvider;
  executor: Executor;
  verifier: Verifier;
  outcomes: OutcomeEvaluator;
  rollback?: RollbackHandler;
  authSecret: string;
  now: () => number;
  /** Builds the resource scope the executor will touch; also bound into the token. */
  scopeFor: (a: ActionRecord) => string;
  authTtlMs?: number;
}

/** Orchestrates MR §8 core loop. All state changes go through the domain state machine. */
export class GrowthEngine {
  constructor(private readonly d: EngineDeps) {}

  private async move(a: ActionRecord, to: ActionState, patch?: Parameters<ActionStore["setStatus"]>[4]): Promise<ActionRecord> {
    const next = transition(a.status, to); // throws on illegal transition
    const ok = await this.d.store.setStatus(a.orgId, a.id, a.status, next, patch);
    if (!ok) throw new EngineError(`concurrent modification of action ${a.id}`);
    await this.d.store.audit(a.orgId, { actor: "engine", event: `transition:${a.status}->${next}`, subjectId: a.id });
    return { ...a, status: next, ...patch };
  }

  /** DISCOVERED → SCORED → PROPOSED → POLICY_CHECK → {BLOCKED | NEEDS_APPROVAL | AUTO_APPROVED}. */
  async propose(n: NewAction): Promise<ProposeResult> {
    const { action: existing, created } = await this.d.store.insert(n);
    if (!created) return { action: existing, decision: { verdict: "DENY", reasons: ["duplicate idempotency key"], policyVersion: existing.policyVersion }, created };
    let a = await this.move(existing, "SCORED");
    a = await this.move(a, "PROPOSED");
    a = await this.move(a, "POLICY_CHECK");
    const policy = await this.d.policies.current(a.orgId);
    const decision = evaluate({ type: a.type, estimatedExternalCostUsd: a.estimatedExternalCostUsd, estimatedModelCostUsd: a.estimatedModelCostUsd }, policy, await this.d.store.spendState(a.orgId));
    await this.d.store.audit(a.orgId, { actor: "policy", event: `decision:${decision.verdict}`, subjectId: a.id, detail: { reasons: decision.reasons, policyVersion: decision.policyVersion } });
    const patch = (needs: boolean) => ({ requiresApproval: needs, policyVersion: decision.policyVersion });
    if (decision.verdict === "DENY") a = await this.move(a, "BLOCKED", patch(false));
    else if (decision.verdict === "NEEDS_APPROVAL") a = await this.move(a, "NEEDS_APPROVAL", patch(true));
    else a = await this.move(a, "AUTO_APPROVED", patch(false));
    return { action: a, decision, created };
  }

  async approve(orgId: string, actionId: string, userId: string, reason?: string): Promise<ActionRecord> {
    const a = await this.must(orgId, actionId);
    if (a.status !== "NEEDS_APPROVAL") throw new EngineError(`action is ${a.status}, not awaiting approval`);
    // Re-evaluate under the policy in force now; an approval cannot launder a now-denied action.
    const policy = await this.d.policies.current(orgId);
    const d = evaluate({ type: a.type, estimatedExternalCostUsd: a.estimatedExternalCostUsd, estimatedModelCostUsd: a.estimatedModelCostUsd }, policy, await this.d.store.spendState(orgId));
    if (d.verdict === "DENY") throw new EngineError(`approval refused: ${d.reasons.join("; ")}`);
    await this.d.store.recordApproval(orgId, actionId, { decision: "approved", userId, policyVersion: d.policyVersion, reason });
    return this.move(a, "APPROVED", { policyVersion: d.policyVersion });
  }

  async reject(orgId: string, actionId: string, userId: string, reason: string): Promise<ActionRecord> {
    const a = await this.must(orgId, actionId);
    if (a.status !== "NEEDS_APPROVAL") throw new EngineError(`action is ${a.status}, not awaiting approval`);
    await this.d.store.recordApproval(orgId, actionId, { decision: "rejected", userId, policyVersion: a.policyVersion, reason });
    return this.move(a, "BLOCKED");
  }

  /** APPROVED|AUTO_APPROVED → QUEUED. */
  async queue(orgId: string, actionId: string): Promise<ActionRecord> {
    const a = await this.must(orgId, actionId);
    if (a.status !== "APPROVED" && a.status !== "AUTO_APPROVED") throw new EngineError(`action is ${a.status}, cannot queue`);
    if (a.status === "APPROVED") {
      // An approval bound to an older policy version is void: it must be re-requested.
      const ap = await this.d.store.latestApproval(orgId, actionId);
      const cur = (await this.d.policies.current(orgId)).version;
      if (!ap || ap.decision !== "approved" || ap.policyVersion !== cur) throw new EngineError("approval invalid for current policy version");
    }
    return this.move(a, "QUEUED");
  }

  /** QUEUED → RUNNING → VERIFYING → SUCCEEDED | FAILED (rollback attempted when safe and pre-authorized). */
  async run(orgId: string, actionId: string): Promise<{ action: ActionRecord; verification?: Verification }> {
    let a = await this.must(orgId, actionId);
    if (a.status !== "QUEUED") throw new EngineError(`action is ${a.status}, not queued`);
    a = await this.move(a, "RUNNING");
    const policy = await this.d.policies.current(orgId);
    if (policy.version !== a.policyVersion) { // policy changed between queue and run: fail closed
      await this.d.store.audit(orgId, { actor: "engine", event: "run_aborted:policy_changed", subjectId: a.id });
      a = await this.move(a, "VERIFYING");
      return { action: await this.move(a, "FAILED") };
    }
    const token = signAuthorization({ actionId: a.id, policyVersion: a.policyVersion, resourceScope: this.d.scopeFor(a), idempotencyKey: a.idempotencyKey, expiresAt: this.d.now() + (this.d.authTtlMs ?? 300_000) }, this.d.authSecret);
    let receipt;
    try {
      receipt = await this.d.executor.execute(a, token);
      await this.d.store.saveReceipt(orgId, a.id, receipt);
    } catch (e) {
      await this.d.store.audit(orgId, { actor: "executor", event: "execution_failed", subjectId: a.id, detail: { error: e instanceof Error ? e.message : String(e) } });
      a = await this.move(a, "VERIFYING");
      return { action: await this.move(a, "FAILED") };
    }
    a = await this.move(a, "VERIFYING");
    const verification = await this.d.verifier.verify(a, receipt).catch((e): Verification => ({ ok: false, checks: [{ name: "verifier_error", ok: false, detail: String(e) }] }));
    await this.d.store.saveVerification(orgId, a.id, verification);
    if (verification.ok) return { action: await this.move(a, "SUCCEEDED"), verification };
    let rolledBack = false;
    if (this.d.rollback) rolledBack = await this.d.rollback.rollback(a, receipt).catch(() => false);
    await this.d.store.audit(orgId, { actor: "engine", event: rolledBack ? "rolled_back" : "needs_attention", subjectId: a.id });
    return { action: await this.move(a, "FAILED"), verification };
  }

  /** SUCCEEDED → OBSERVING (observation scheduled by the worker). */
  async observe(orgId: string, actionId: string): Promise<ActionRecord> {
    const a = await this.must(orgId, actionId);
    return this.move(a, "OBSERVING");
  }

  /** OBSERVING → EVALUATED, recording whether the result is experimental or observational. */
  async evaluateOutcome(orgId: string, actionId: string) {
    const a = await this.must(orgId, actionId);
    if (a.status !== "OBSERVING") throw new EngineError(`action is ${a.status}, not observing`);
    const outcome = await this.d.outcomes.evaluate(a);
    await this.d.store.audit(orgId, { actor: "outcomes", event: "evaluated", subjectId: a.id, detail: outcome });
    return { action: await this.move(a, "EVALUATED"), outcome };
  }

  /** Convenience driver for auto-approved actions. */
  async runAutoApproved(orgId: string, actionId: string) {
    await this.queue(orgId, actionId);
    return this.run(orgId, actionId);
  }

  private async must(orgId: string, id: string): Promise<ActionRecord> {
    const a = await this.d.store.get(orgId, id);
    if (!a) throw new EngineError("action not found");
    return a;
  }
}

export type { Decision };
