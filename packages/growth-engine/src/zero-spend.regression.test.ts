import { describe, expect, it } from "vitest";
import { ACTION_TYPES, ZERO_SPEND_POLICY } from "@quietgrowth/policy-engine";
import { GrowthEngine, MemoryActionStore, type NewAction } from "./index.js";

// Permanent regression suite (MR §25, §28): Zero-Spend mode must have NO path to external spend.
const mk = () => {
  const store = new MemoryActionStore(); let executions = 0;
  const engine = new GrowthEngine({
    store, authSecret: "s", now: () => 1, scopeFor: (a) => a.id, policies: { current: async () => ZERO_SPEND_POLICY },
    executor: { execute: async () => { executions++; return { provider: "x", resourceId: "1", idempotencyKey: "k", at: 1 }; } },
    verifier: { verify: async () => ({ ok: true, checks: [] }) }, outcomes: { evaluate: async () => ({ label: "observational", summary: {}, guardrailsHeld: true }) },
  });
  return { engine, store, executions: () => executions };
};
const act = (type: string, external: number, i: number): NewAction => ({ orgId: "o", domain: "acquisition", type, targetMetric: "m", guardrailMetrics: [], rationale: "r", evidence: ["e"], expectedIncrementalImpact: 0.1, confidence: 0.5, estimatedExternalCostUsd: external, estimatedModelCostUsd: 0, idempotencyKey: `${type}-${external}-${i}`, payload: {} });

describe("Zero-Spend: no path to external spend", () => {
  it("every action type with any external cost is BLOCKED and never executed, even after an owner approval attempt", async () => {
    const { engine, executions } = mk();
    let i = 0;
    for (const type of ACTION_TYPES) for (const cost of [0.01, 1, 1e9]) {
      const { action } = await engine.propose(act(type, cost, i++));
      expect(action.status, `${type}@${cost}`).toBe("BLOCKED");
      await expect(engine.approve("o", action.id, "owner")).rejects.toThrow();
      await expect(engine.queue("o", action.id)).rejects.toThrow();
      await expect(engine.run("o", action.id)).rejects.toThrow();
    }
    expect(executions()).toBe(0);
  });
  it("inherently paid or forbidden types are blocked even at $0 estimated cost (mis-estimation cannot buy a path)", async () => {
    const { engine, executions } = mk();
    for (const type of ["paid_ad_campaign", "paid_ad_spend_increase", "paid_data_provider", "paid_directory_listing", "new_subscription", "social_media_post", "delete_customer_data", "delete_production_content"] as const) {
      const { action } = await engine.propose(act(type, 0, 0));
      expect(action.status, type).toBe("BLOCKED");
    }
    expect(executions()).toBe(0);
  });
  it("negative, NaN and infinite cost estimates cannot slip through", async () => {
    const { engine, executions } = mk();
    for (const [i, c] of [-5, NaN, Infinity].entries()) expect((await engine.propose(act("metadata_change", c, i))).action.status).toBe("BLOCKED");
    expect(executions()).toBe(0);
  });
});
