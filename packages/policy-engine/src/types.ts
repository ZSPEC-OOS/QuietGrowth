// Policy types, MR §5.2 and §14.2.
export type Verdict = "DENY" | "NEEDS_APPROVAL" | "ALLOW";
export type Rule = "deny" | "require_approval" | "allow_with_limits";

/** Closed set of action types. Anything outside it is denied (fail closed). */
export const ACTION_TYPES = [
  "metadata_change",
  "internal_link_change",
  "content_refresh",
  "new_intent_page",
  "onboarding_experiment",
  "pricing_change",
  "entitlement_change",
  "auth_or_payment_flow_change",
  "cancellation_or_refund_flow_change",
  "analytics_schema_change",
  "delete_customer_data",
  "delete_production_content",
  "lifecycle_email_existing_users",
  "outbound_email_new_contacts",
  "cold_outreach",
  "paid_ad_campaign",
  "paid_ad_spend_increase",
  "paid_data_provider",
  "paid_directory_listing",
  "new_subscription",
  "social_media_post",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface Policy {
  version: string;
  mode: "zero_spend" | "controlled_growth";
  maxExternalSpendUsd: number;
  maxModelSpendUsd: number;
  rules: Readonly<Partial<Record<ActionType, Rule>>>;
  /** Per-action limit applied to `allow_with_limits` rules. */
  limits: { maxActionsPerDay: number };
}

export interface SpendState {
  externalSpendUsd: number;
  modelSpendUsd: number;
  actionsToday: Readonly<Partial<Record<ActionType, number>>>;
}

export interface ActionRequest {
  type: string;
  estimatedExternalCostUsd: number;
  estimatedModelCostUsd: number;
}

export interface Decision {
  verdict: Verdict;
  reasons: string[];
  policyVersion: string;
}
