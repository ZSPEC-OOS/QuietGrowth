import { describe, expect, it } from "vitest";
import { attribute, dayNActive, dropAnomaly, economics, funnelCounts, resolveIdentity, retainedCustomerValue, weeklySignupCohorts, type FunnelEvent } from "./index.js";

const D = 86_400_000;
const map = { signup: "signup", activation: "activated", paid: "paid", retention: "active" };
const ev = (subjectId: string, event: string, at: number): FunnelEvent => ({ subjectId, event, at });

const events: FunnelEvent[] = [
  ev("a", "landing_view", 0), ev("b", "landing_view", 0), ev("c", "landing_view", 0), ev("d", "landing_view", 0),
  ev("a", "signup", 1), ev("b", "signup", 1), ev("c", "signup", 1),
  ev("a", "activated", 2), ev("b", "activated", 2),
  ev("a", "paid", 3), ev("b", "paid", 3),
  ev("a", "active", 3 + 31 * D),
  ev("z", "paid", 5), // paid without signup must not count
];

describe("funnelCounts", () => {
  const c = funnelCounts(events, map, 30);
  it("counts strictly sequentially", () => {
    expect([c.visitors, c.signups, c.activated, c.paid, c.retained]).toEqual([4, 3, 2, 2, 1]);
  });
  it("computes rates, null on empty denominators", () => {
    expect(c.rates.signupToActivation).toBeCloseTo(2 / 3);
    expect(c.rates.paidToRetained).toBeCloseTo(0.5);
    expect(funnelCounts([], map, 30).rates.visitorToSignup).toBeNull();
  });
});

describe("identity + cohorts", () => {
  it("resolves anonymous ids via links", () => {
    expect(resolveIdentity([{ anonymousId: "x" }, { userId: "u" }, { anonymousId: "y" }], new Map([["x", "u1"]]))).toEqual(["u1", "u", "y"]);
  });
  it("buckets by UTC Monday and computes day-N activity", () => {
    const monday = Date.UTC(2026, 8, 28); // Mon 2026-09-28
    const evs = [ev("a", "signup", monday + 2 * D), ev("b", "signup", monday + 9 * D), ev("a", "active", monday + 40 * D)];
    const cohorts = weeklySignupCohorts(evs, "signup");
    expect(cohorts.map((c) => c.key)).toEqual(["2026-09-28", "2026-10-05"]);
    expect(dayNActive(evs, cohorts[0]!, "signup", "active", 30)).toBe(1);
    expect(dayNActive(evs, cohorts[1]!, "signup", "active", 30)).toBe(0);
  });
});

describe("attribution", () => {
  const touches = [{ subjectId: "a", source: "seo", at: 1 }, { subjectId: "a", source: "email", at: 5 }];
  it("first vs last touch, unattributed bucket, ignores later touches", () => {
    const conv = [{ subjectId: "a", at: 10 }, { subjectId: "q", at: 10 }, { subjectId: "a", at: 3 }];
    expect(attribute(conv, touches, "first_touch")).toEqual({ seo: 2, unattributed: 1 });
    expect(attribute(conv, touches, "last_touch")).toEqual({ email: 1, seo: 1, unattributed: 1 });
  });
});

describe("economics", () => {
  it("computes CAC/payback/LTV:CAC and handles zero customers", () => {
    const e = economics({ spendUsd: 90, modelCostUsd: 10, newPaying: 10, monthlyGrossProfitPerCustomerUsd: 5, expectedLifetimeMonths: 12 });
    expect(e.cacUsd).toBe(10); expect(e.paybackMonths).toBe(2); expect(e.ltvToCac).toBe(6);
    expect(economics({ spendUsd: 1, modelCostUsd: 0, newPaying: 0, monthlyGrossProfitPerCustomerUsd: 5, expectedLifetimeMonths: 1 }).cacUsd).toBeNull();
    expect(retainedCustomerValue(100, 10, 20)).toBe(70);
  });
});

describe("dropAnomaly", () => {
  it("flags large drops, not noise, not short series", () => {
    expect(dropAnomaly([10, 11, 9, 10, 2]).anomalous).toBe(true);
    expect(dropAnomaly([10, 11, 9, 10, 10]).anomalous).toBe(false);
    expect(dropAnomaly([1, 2]).anomalous).toBe(false);
  });
});
