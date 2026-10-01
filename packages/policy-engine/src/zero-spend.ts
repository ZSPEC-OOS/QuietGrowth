import type { Policy } from "./types.js";

/** Default Zero-Spend policy (MR §5.2 + §14.2). */
export const ZERO_SPEND_POLICY: Policy = {
  version: "zero_spend.v1",
  mode: "zero_spend",
  maxExternalSpendUsd: 0,
  maxModelSpendUsd: 50,
  limits: { maxActionsPerDay: 10 },
  rules: {
    metadata_change: "allow_with_limits",
    internal_link_change: "allow_with_limits",
    content_refresh: "allow_with_limits",
    new_intent_page: "require_approval",
    onboarding_experiment: "require_approval",
    pricing_change: "require_approval",
    entitlement_change: "require_approval",
    auth_or_payment_flow_change: "require_approval",
    cancellation_or_refund_flow_change: "require_approval",
    analytics_schema_change: "require_approval",
    delete_customer_data: "deny",
    delete_production_content: "deny",
    lifecycle_email_existing_users: "allow_with_limits",
    outbound_email_new_contacts: "require_approval",
    cold_outreach: "require_approval",
    paid_ad_campaign: "deny",
    paid_ad_spend_increase: "deny",
    paid_data_provider: "deny",
    paid_directory_listing: "deny",
    new_subscription: "deny",
    social_media_post: "deny",
  },
};
