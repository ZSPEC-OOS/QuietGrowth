import { authorizeWrite, HealthGate, type AuthContext, type WriteReceipt } from "@quietgrowth/connectors-core";

// Paid search guardrails (MR §10.8, §21.8). Write path only exists behind the gate + caps + stop-loss.
export interface PaidGate { attributionHealthy: boolean; activationEventDefined: boolean; paidConversionEventDefined: boolean; billingSourceConnected: boolean; maxDailySpend: number; ownerApproved: boolean }

export function paidGrowthGate(g: PaidGate): { open: boolean; failing: string[] } {
  const failing: string[] = [];
  if (!g.attributionHealthy) failing.push("attribution_healthy");
  if (!g.activationEventDefined) failing.push("activation_event_defined");
  if (!g.paidConversionEventDefined) failing.push("paid_conversion_event_defined");
  if (!g.billingSourceConnected) failing.push("billing_source_connected");
  if (!(g.maxDailySpend > 0)) failing.push("max_daily_spend");
  if (!g.ownerApproved) failing.push("owner_approved");
  return { open: failing.length === 0, failing };
}

export interface StopLossInput { spendWithoutActivationUsd: number; spendWithoutActivationThresholdUsd: number; cacUsd: number | null; cacHardCapUsd: number; minEvidencePaying: number; payingCustomers: number; churnGuardrailWorsened: boolean }
export type StopLossAction = "continue" | "pause_spend_without_activation" | "pause_cac_over_cap" | "stop_experiment_churn";

export function evaluateStopLoss(i: StopLossInput): StopLossAction {
  if (i.churnGuardrailWorsened) return "stop_experiment_churn";
  if (i.spendWithoutActivationUsd > i.spendWithoutActivationThresholdUsd) return "pause_spend_without_activation";
  if (i.payingCustomers >= i.minEvidencePaying && i.cacUsd !== null && i.cacUsd > i.cacHardCapUsd) return "pause_cac_over_cap";
  return "continue";
}

export interface SpendCaps { dailyUsd: number; monthlyUsd: number; maxBidChangeFraction: number }
export interface SpendState { todayUsd: number; monthUsd: number }
export class SpendCapError extends Error {}

export interface AdsApi { applyBudget(campaignId: string, dailyBudgetUsd: number, idempotencyKey: string): Promise<{ resourceName: string }> }

export class GoogleAdsConnector {
  readonly provider = "google_ads";
  readonly gate = new HealthGate();
  constructor(private readonly api: AdsApi, private readonly caps: SpendCaps, private readonly auth: AuthContext, private readonly paid: () => PaidGate, private readonly spend: () => SpendState) {}

  async setDailyBudget(a: { campaignId: string; currentDailyUsd: number; newDailyUsd: number; actionId: string; policyVersion: string }, token: string): Promise<WriteReceipt> {
    const g = paidGrowthGate(this.paid());
    if (!g.open) throw new SpendCapError(`paid growth gate closed: ${g.failing.join(",")}`);
    if (a.newDailyUsd > this.caps.dailyUsd) throw new SpendCapError("exceeds daily cap");
    const s = this.spend();
    if (s.monthUsd + a.newDailyUsd > this.caps.monthlyUsd) throw new SpendCapError("would exceed monthly cap");
    if (a.currentDailyUsd > 0 && Math.abs(a.newDailyUsd - a.currentDailyUsd) / a.currentDailyUsd > this.caps.maxBidChangeFraction) throw new SpendCapError("bid change exceeds cap");
    const auth = authorizeWrite(this.gate, this.auth, token, { actionId: a.actionId, policyVersion: a.policyVersion, resourceScope: `ads:campaign:${a.campaignId}` });
    const r = await this.api.applyBudget(a.campaignId, a.newDailyUsd, auth.idempotencyKey);
    return { provider: "google_ads", resourceId: r.resourceName, idempotencyKey: auth.idempotencyKey, at: this.auth.now() };
  }
}
