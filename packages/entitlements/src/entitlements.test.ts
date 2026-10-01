import { describe, expect, it } from "vitest";
import { EntitlementError, TIER_LIMITS, assertCanAddProduct, assertFeature, assertModelCap, limitsFor } from "./index.js";

describe("entitlements", () => {
  it("gates paid search and controlled-growth mode to growth/team", () => {
    expect(() => assertFeature("hosted_starter", "paidSearch")).toThrow(EntitlementError);
    expect(() => assertFeature("self_host", "controlledGrowthMode")).toThrow(EntitlementError);
    expect(() => assertFeature("growth", "paidSearch")).not.toThrow();
    expect(() => assertFeature("team", "approvalRoles")).not.toThrow();
    expect(() => assertFeature("growth", "approvalRoles")).toThrow();
  });
  it("limits products by tier", () => {
    expect(() => assertCanAddProduct("hosted_starter", 0)).not.toThrow();
    expect(() => assertCanAddProduct("hosted_starter", 1)).toThrow("additional products");
    expect(() => assertCanAddProduct("team", 4)).not.toThrow(); expect(() => assertCanAddProduct("team", 5)).toThrow();
  });
  it("unknown tiers fall back to the most restrictive hosted plan", () => {
    expect(limitsFor("enterprise-typo")).toEqual(TIER_LIMITS.hosted_starter);
    expect(() => assertFeature("nope", "paidSearch")).toThrow();
  });
  it("model-cost cap is bounded by plan economics", () => {
    expect(() => assertModelCap("hosted_starter", 100)).not.toThrow(); expect(() => assertModelCap("hosted_starter", 101)).toThrow();
    expect(() => assertModelCap("self_host", 5000)).not.toThrow();
  });
  it("packaging is not metered by tokens or runs", () => {
    for (const l of Object.values(TIER_LIMITS)) expect(Object.keys(l).some((k) => /token|run/i.test(k))).toBe(false);
  });
});
