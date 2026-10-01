import { describe, expect, it } from "vitest";
import { evaluateCompleteness, type FunnelDefinition } from "./funnel.js";

const full: FunnelDefinition = {
  events: { signup: "account_created", activation: "first_project", paid: "subscription_started", retention: "core_action_completed", churn: "subscription_cancelled" },
  retentionWindowDays: 30,
  billingSourceConnected: true,
};
const seen = new Set(["account_created", "first_project", "subscription_started"]);

describe("evaluateCompleteness", () => {
  it("complete definition is write-ready", () => {
    const c = evaluateCompleteness(full, seen);
    expect(c.gaps).toEqual([]);
    expect(c.autopilotWritesReady && c.funnelReliable && c.mayReportSubscribers).toBe(true);
  });
  it("URL-only start: nothing defined, no subscriber claims", () => {
    const c = evaluateCompleteness({ events: {}, billingSourceConnected: false }, new Set());
    expect(c.mayReportSubscribers).toBe(false);
    expect(c.funnelReliable).toBe(false);
    expect(c.autopilotWritesReady).toBe(false);
    expect(c.gaps).toContain("activation_event_missing");
  });
  it("missing activation marks funnel unreliable", () => {
    const c = evaluateCompleteness({ ...full, events: { ...full.events, activation: undefined } }, seen);
    expect(c.funnelReliable).toBe(false);
  });
  it("mapped but never observed is a gap", () => {
    const c = evaluateCompleteness(full, new Set(["subscription_started"]));
    expect(c.gaps).toEqual(expect.arrayContaining(["signup_event_not_observed", "activation_event_not_observed"]));
  });
  it("client-only paid events never permit subscriber claims", () => {
    const c = evaluateCompleteness({ ...full, billingSourceConnected: false }, seen);
    expect(c.mayReportSubscribers).toBe(false);
    expect(c.gaps).toContain("billing_source_not_connected");
  });
  it("requires retention window", () => {
    expect(evaluateCompleteness({ ...full, retentionWindowDays: 0 }, seen).gaps).toContain("retention_window_missing");
  });
});
