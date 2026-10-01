import { describe, expect, it } from "vitest";
import { ZERO_SPEND_POLICY, type Policy } from "@quietgrowth/policy-engine";
import type { WriteReceipt } from "@quietgrowth/connectors-core";
import { EngineError, GrowthEngine, MemoryActionStore, type ActionRecord, type NewAction } from "./index.js";

const ORG = "org1";
const n = (o: Partial<NewAction> = {}): NewAction => ({
  orgId: ORG, domain: "acquisition", type: "metadata_change", targetMetric: "signups", guardrailMetrics: ["bounce"], rationale: "r", evidence: ["e1"],
  expectedIncrementalImpact: 0.2, confidence: 0.6, estimatedExternalCostUsd: 0, estimatedModelCostUsd: 0.01, idempotencyKey: `k-${Math.random()}`, payload: {}, ...o,
});
const receipt: WriteReceipt = { provider: "github", resourceId: "7", idempotencyKey: "k", at: 1 };

function setup(over: Partial<{ policy: Policy; verifyOk: boolean; execThrows: boolean; rollback: boolean }> = {}) {
  const store = new MemoryActionStore();
  let policy = over.policy ?? ZERO_SPEND_POLICY;
  const execCalls: { a: ActionRecord; token: string }[] = [];
  const engine = new GrowthEngine({
    store, authSecret: "s", now: () => 1000, scopeFor: (a) => `repo:o/r:branch:qg/${a.id}`,
    policies: { current: async () => policy },
    executor: { execute: async (a, token) => { if (over.execThrows) throw new Error("boom"); execCalls.push({ a, token }); return receipt; } },
    verifier: { verify: async () => ({ ok: over.verifyOk ?? true, checks: [{ name: "http_200", ok: over.verifyOk ?? true }] }) },
    outcomes: { evaluate: async () => ({ label: "observational", summary: { signupsDelta: 3 }, guardrailsHeld: true }) },
    rollback: over.rollback === undefined ? undefined : { rollback: async () => over.rollback! },
  });
  return { store, engine, execCalls, setPolicy: (p: Policy) => { policy = p; } };
}

describe("GrowthEngine", () => {
  it("auto-approved low-risk action runs the whole loop to EVALUATED", async () => {
    const { engine, store, execCalls } = setup();
    const { action, decision } = await engine.propose(n());
    expect(decision.verdict).toBe("ALLOW"); expect(action.status).toBe("AUTO_APPROVED");
    const run = await engine.runAutoApproved(ORG, action.id);
    expect(run.action.status).toBe("SUCCEEDED");
    expect(execCalls).toHaveLength(1);
    expect(store.receipts.get(action.id)).toEqual(receipt);
    await engine.observe(ORG, action.id);
    const ev = await engine.evaluateOutcome(ORG, action.id);
    expect(ev.action.status).toBe("EVALUATED"); expect(ev.outcome.label).toBe("observational");
    expect(store.auditLog.some((e) => e.event === "transition:OBSERVING->EVALUATED")).toBe(true);
  });

  it("forbidden actions are BLOCKED and cannot be queued or run", async () => {
    const { engine, execCalls } = setup();
    const { action } = await engine.propose(n({ type: "paid_ad_campaign" }));
    expect(action.status).toBe("BLOCKED");
    await expect(engine.queue(ORG, action.id)).rejects.toThrow(EngineError);
    await expect(engine.run(ORG, action.id)).rejects.toThrow(EngineError);
    expect(execCalls).toHaveLength(0);
  });

  it("any external cost under zero-spend is blocked even for an otherwise allowed action", async () => {
    const { engine } = setup();
    expect((await engine.propose(n({ estimatedExternalCostUsd: 5 }))).action.status).toBe("BLOCKED");
  });

  it("approval-required actions wait, then run only after approval", async () => {
    const { engine, execCalls } = setup();
    const { action } = await engine.propose(n({ type: "pricing_change" }));
    expect(action.status).toBe("NEEDS_APPROVAL");
    await expect(engine.queue(ORG, action.id)).rejects.toThrow(EngineError);
    await engine.approve(ORG, action.id, "user1");
    await engine.queue(ORG, action.id);
    expect((await engine.run(ORG, action.id)).action.status).toBe("SUCCEEDED");
    expect(execCalls).toHaveLength(1);
  });

  it("rejection blocks the action", async () => {
    const { engine } = setup();
    const { action } = await engine.propose(n({ type: "cold_outreach" }));
    expect((await engine.reject(ORG, action.id, "u", "no")).status).toBe("BLOCKED");
  });

  it("approval cannot launder an action the current policy denies", async () => {
    const { engine, setPolicy } = setup();
    const { action } = await engine.propose(n({ type: "pricing_change" }));
    setPolicy({ ...ZERO_SPEND_POLICY, version: "v2", rules: { ...ZERO_SPEND_POLICY.rules, pricing_change: "deny" } });
    await expect(engine.approve(ORG, action.id, "u")).rejects.toThrow("approval refused");
  });

  it("policy change after approval voids the approval at queue time", async () => {
    const { engine, setPolicy } = setup();
    const { action } = await engine.propose(n({ type: "pricing_change" }));
    await engine.approve(ORG, action.id, "u");
    setPolicy({ ...ZERO_SPEND_POLICY, version: "v2" });
    await expect(engine.queue(ORG, action.id)).rejects.toThrow("approval invalid");
  });

  it("policy change between queue and run fails closed without executing", async () => {
    const { engine, setPolicy, execCalls } = setup();
    const { action } = await engine.propose(n());
    await engine.queue(ORG, action.id);
    setPolicy({ ...ZERO_SPEND_POLICY, version: "v2" });
    expect((await engine.run(ORG, action.id)).action.status).toBe("FAILED");
    expect(execCalls).toHaveLength(0);
  });

  it("executor receives a signed token bound to the action, scope and policy version", async () => {
    const { engine, execCalls } = setup();
    const { action } = await engine.propose(n());
    await engine.runAutoApproved(ORG, action.id);
    const { verifyAuthorization, InMemoryIdempotencyStore } = await import("@quietgrowth/policy-engine");
    const r = verifyAuthorization(execCalls[0]!.token, "s", { actionId: action.id, policyVersion: "zero_spend.v1", resourceScope: `repo:o/r:branch:qg/${action.id}`, now: 1000 }, new InMemoryIdempotencyStore());
    expect(r.ok).toBe(true);
  });

  it("failed verification => FAILED, with rollback attempted when available", async () => {
    const a = setup({ verifyOk: false, rollback: true });
    const p = await a.engine.propose(n());
    const r = await a.engine.runAutoApproved(ORG, p.action.id);
    expect(r.action.status).toBe("FAILED"); expect(r.verification!.ok).toBe(false);
    expect(a.store.auditLog.some((e) => e.event === "rolled_back")).toBe(true);
    const b = setup({ verifyOk: false });
    const q = await b.engine.propose(n());
    await b.engine.runAutoApproved(ORG, q.action.id);
    expect(b.store.auditLog.some((e) => e.event === "needs_attention")).toBe(true);
  });

  it("executor failure => FAILED, no verification, error audited", async () => {
    const { engine, store } = setup({ execThrows: true });
    const { action } = await engine.propose(n());
    const r = await engine.runAutoApproved(ORG, action.id);
    expect(r.action.status).toBe("FAILED");
    expect(store.auditLog.some((e) => e.event === "execution_failed")).toBe(true);
  });

  it("duplicate idempotency key does not create or re-run an action", async () => {
    const { engine } = setup();
    const first = await engine.propose(n({ idempotencyKey: "same" }));
    const again = await engine.propose(n({ idempotencyKey: "same" }));
    expect(again.created).toBe(false); expect(again.action.id).toBe(first.action.id);
  });

  it("tenant isolation: another org cannot see or drive the action", async () => {
    const { engine } = setup();
    const { action } = await engine.propose(n());
    await expect(engine.queue("org2", action.id)).rejects.toThrow("not found");
  });

  it("only legal transitions are possible (cannot observe before success)", async () => {
    const { engine } = setup();
    const { action } = await engine.propose(n());
    await expect(engine.observe(ORG, action.id)).rejects.toThrow();
  });
});
