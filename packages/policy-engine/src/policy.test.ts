import { describe, expect, it } from "vitest";
import { ACTION_TYPES, ZERO_SPEND_POLICY as P, evaluate, type SpendState } from "./index.js";

const S: SpendState = { externalSpendUsd: 0, modelSpendUsd: 0, actionsToday: {} };
const req = (type: string, ext = 0, model = 0) => ({ type, estimatedExternalCostUsd: ext, estimatedModelCostUsd: model });

describe("zero-spend policy matrix", () => {
  it("every action type has an explicit rule", () => {
    for (const t of ACTION_TYPES) expect(P.rules[t], t).toBeDefined();
  });
  it.each([
    ["metadata_change", "ALLOW"],
    ["internal_link_change", "ALLOW"],
    ["lifecycle_email_existing_users", "ALLOW"],
    ["pricing_change", "NEEDS_APPROVAL"],
    ["entitlement_change", "NEEDS_APPROVAL"],
    ["cold_outreach", "NEEDS_APPROVAL"],
    ["outbound_email_new_contacts", "NEEDS_APPROVAL"],
    ["onboarding_experiment", "NEEDS_APPROVAL"],
    ["delete_customer_data", "DENY"],
    ["delete_production_content", "DENY"],
    ["paid_ad_campaign", "DENY"],
    ["paid_ad_spend_increase", "DENY"],
    ["paid_data_provider", "DENY"],
    ["paid_directory_listing", "DENY"],
    ["new_subscription", "DENY"],
    ["social_media_post", "DENY"],
  ])("%s -> %s", (type, verdict) => {
    expect(evaluate(req(type), P, S).verdict).toBe(verdict);
  });
});

describe("fail closed", () => {
  it("unknown action type", () => expect(evaluate(req("rm_rf"), P, S).verdict).toBe("DENY"));
  it("any external spend under zero-spend", () => expect(evaluate(req("metadata_change", 0.01), P, S).verdict).toBe("DENY"));
  it("approval cannot authorise spend over cap", () => expect(evaluate(req("pricing_change", 1), P, S).verdict).toBe("DENY"));
  it("model cap", () => expect(evaluate(req("metadata_change", 0, 1), P, { ...S, modelSpendUsd: 49.5 }).verdict).toBe("DENY"));
  it.each([NaN, -1, Infinity])("invalid cost %s", (n) => expect(evaluate(req("metadata_change", n), P, S).verdict).toBe("DENY"));
  it("missing rule", () => expect(evaluate(req("metadata_change"), { ...P, rules: {} }, S).verdict).toBe("DENY"));
  it("missing policy/state", () => {
    expect(evaluate(req("metadata_change"), undefined as never, S).verdict).toBe("DENY");
    expect(evaluate(req("metadata_change"), P, undefined as never).verdict).toBe("DENY");
  });
  it("daily limit escalates to approval", () => {
    expect(evaluate(req("metadata_change"), P, { ...S, actionsToday: { metadata_change: 10 } }).verdict).toBe("NEEDS_APPROVAL");
  });
  it("zero-spend policy has no path to spend", () => {
    for (const t of ACTION_TYPES) expect(evaluate(req(t, 0.01), P, S).verdict, t).toBe("DENY");
  });
});
