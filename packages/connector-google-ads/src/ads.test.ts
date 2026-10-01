import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore, signAuthorization } from "@quietgrowth/policy-engine";
import { GoogleAdsConnector, SpendCapError, evaluateStopLoss, paidGrowthGate, type PaidGate } from "./index.js";

const gateOk: PaidGate = { attributionHealthy: true, activationEventDefined: true, paidConversionEventDefined: true, billingSourceConnected: true, maxDailySpend: 50, ownerApproved: true };
const tok = (k: string, scope = "ads:campaign:c1") => signAuthorization({ actionId: "a", policyVersion: "v1", resourceScope: scope, idempotencyKey: k, expiresAt: 9e9 }, "s");
const mk = (gate = gateOk, spend = { todayUsd: 0, monthUsd: 0 }) => {
  let applied = 0;
  return { applied: () => applied, c: new GoogleAdsConnector({ applyBudget: async () => { applied++; return { resourceName: "r1" }; } }, { dailyUsd: 50, monthlyUsd: 1000, maxBidChangeFraction: 0.5 }, { secret: "s", store: new InMemoryIdempotencyStore(), now: () => 1 }, () => gate, () => spend) };
};
const args = { campaignId: "c1", currentDailyUsd: 20, newDailyUsd: 25, actionId: "a", policyVersion: "v1" };

describe("paid growth gate", () => {
  it("opens only when every condition holds and lists failures", () => {
    expect(paidGrowthGate(gateOk).open).toBe(true);
    const r = paidGrowthGate({ ...gateOk, attributionHealthy: false, ownerApproved: false, maxDailySpend: 0 });
    expect(r.open).toBe(false); expect(r.failing).toEqual(["attribution_healthy", "max_daily_spend", "owner_approved"]);
  });
});
describe("GoogleAdsConnector", () => {
  it("applies a within-caps change", async () => { const m = mk(); expect((await m.c.setDailyBudget(args, tok("k1"))).resourceId).toBe("r1"); expect(m.applied()).toBe(1); });
  it.each([
    ["gate closed", () => mk({ ...gateOk, ownerApproved: false }), args],
    ["daily cap", () => mk(), { ...args, newDailyUsd: 60 }],
    ["monthly cap", () => mk(gateOk, { todayUsd: 0, monthUsd: 990 }), args],
    ["bid change cap", () => mk(), { ...args, newDailyUsd: 40 }],
  ])("blocks on %s without calling the provider", async (_n, f, a) => {
    const m = (f as () => ReturnType<typeof mk>)(); await expect(m.c.setDailyBudget(a, tok("k2"))).rejects.toThrow(SpendCapError); expect(m.applied()).toBe(0);
  });
  it("requires authorization scoped to the campaign", async () => {
    const m = mk(); await expect(m.c.setDailyBudget(args, tok("k3", "ads:campaign:other"))).rejects.toThrow("not authorized"); expect(m.applied()).toBe(0);
  });
});
describe("stop-loss", () => {
  const base = { spendWithoutActivationUsd: 10, spendWithoutActivationThresholdUsd: 50, cacUsd: 20, cacHardCapUsd: 40, minEvidencePaying: 5, payingCustomers: 10, churnGuardrailWorsened: false };
  it("evaluates in priority order and respects minimum evidence", () => {
    expect(evaluateStopLoss(base)).toBe("continue");
    expect(evaluateStopLoss({ ...base, churnGuardrailWorsened: true })).toBe("stop_experiment_churn");
    expect(evaluateStopLoss({ ...base, spendWithoutActivationUsd: 60 })).toBe("pause_spend_without_activation");
    expect(evaluateStopLoss({ ...base, cacUsd: 80 })).toBe("pause_cac_over_cap");
    expect(evaluateStopLoss({ ...base, cacUsd: 80, payingCustomers: 2 })).toBe("continue");
  });
});
