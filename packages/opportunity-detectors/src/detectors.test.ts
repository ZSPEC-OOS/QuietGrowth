import { describe, expect, it } from "vitest";
import type { FunnelCounts } from "@quietgrowth/metrics";
import { assessChannelQuality, detectActivationRegression, detectChurnDriver, detectFunnelBottleneck, detectPlgOpportunities } from "./index.js";

const counts = (visitors: number, signups: number, activated: number, paid: number, retained: number): FunnelCounts => {
  const r = (n: number, d: number) => (d === 0 ? null : n / d);
  return { visitors, signups, activated, paid, retained, rates: { visitorToSignup: r(signups, visitors), signupToActivation: r(activated, signups), activationToPaid: r(paid, activated), paidToRetained: r(retained, paid) } };
};

describe("detectFunnelBottleneck (growth eval fixtures 1-3)", () => {
  it("fixture 1: high signup, low activation => activation bottleneck is top", () => {
    const o = detectFunnelBottleneck(counts(10000, 1000, 100, 50, 40), "2026-W40");
    expect(o[0]).toMatchObject({ kind: "activation_bottleneck", domain: "activation" });
    expect((o[0]!.evidence as any).topBottleneck).toBe(true);
  });
  it("fixture 2: high activation, low paid conversion => conversion gap", () => {
    expect(detectFunnelBottleneck(counts(2000, 1000, 900, 20, 18), "p")[0]!.kind).toBe("paid_conversion_gap");
  });
  it("fixture 3: good paid conversion but severe first-month churn => retention gap", () => {
    const o = detectFunnelBottleneck(counts(2000, 1000, 900, 400, 40), "p");
    expect(o[0]).toMatchObject({ kind: "retention_gap", domain: "retention" });
  });
  it("small samples are reported as insufficient data, never ranked", () => {
    const o = detectFunnelBottleneck(counts(1000, 100, 10, 2, 1), "p");
    expect(o.filter((x) => x.insufficientData).map((x) => x.funnelStage)).toEqual(expect.arrayContaining(["activation_to_paid"]));
    expect(o.filter((x) => x.insufficientData).every((x) => x.score === 0)).toBe(true);
  });
  it("is deterministic and dedupe keys are period-scoped", () => {
    const a = detectFunnelBottleneck(counts(10000, 1000, 100, 50, 40), "w1"), b = detectFunnelBottleneck(counts(10000, 1000, 100, 50, 40), "w1");
    expect(a).toEqual(b); expect(a[0]!.dedupeKey).toContain("w1");
  });
});

describe("other detectors", () => {
  it("activation regression flags a sharp weekly drop with enough data only", () => {
    const w = (rates: number[]) => rates.map((rate, i) => ({ week: `w${i}`, rate, n: 100 }));
    expect(detectActivationRegression(w([0.4, 0.42, 0.39, 0.41, 0.1]))).toHaveLength(1);
    expect(detectActivationRegression(w([0.4, 0.42, 0.39, 0.41, 0.4]))).toEqual([]);
    expect(detectActivationRegression(w([0.4, 0.1]))).toEqual([]);
    expect(detectActivationRegression([0.4, 0.4, 0.4, 0.4, 0.05].map((rate, i) => ({ week: `w${i}`, rate, n: 5 })))).toEqual([]);
  });
  it("churn driver is a product issue, requires volume and a material gap", () => {
    const o = detectChurnDriver({ baselineChurnRate: 0.1, period: "p", churnedByFeature: { exports: { churned: 30, total: 100 }, search: { churned: 11, total: 100 }, tiny: { churned: 5, total: 5 } } });
    expect(o.map((x) => (x.evidence as any).feature)).toEqual(["exports"]);
    expect(o[0]!.kind).toBe("product_issue_churn_driver");
  });
  it("PLG templates need matching product facts and skip existing integration pages", () => {
    const o = detectPlgOpportunities({ hasInviteFeature: true, hasExportOrShare: false, integrations: ["Slack", "Zapier"], multiUser: true, hasTemplates: false, existingIntegrationPages: ["Slack"] }, "p");
    expect(o.map((x) => x.kind).sort()).toEqual(["integration_page", "team_invite_prompt_after_value_moment"]);
    expect(detectPlgOpportunities({ hasInviteFeature: true, hasExportOrShare: false, integrations: [], multiUser: false, hasTemplates: false, existingIntegrationPages: [] }, "p")).toEqual([]);
  });
  it("fixture 6: low CAC but poor retention is low quality, small cohorts are insufficient", () => {
    const r = assessChannelQuality([{ source: "ads", newPaying: 50, retainedAfterWindow: 5, cacUsd: 3 }, { source: "seo", newPaying: 40, retainedAfterWindow: 30, cacUsd: 20 }, { source: "x", newPaying: 3, retainedAfterWindow: 3, cacUsd: 1 }]);
    expect(r.map((x) => x.verdict)).toEqual(["low_quality", "healthy", "insufficient_data"]);
  });
});
