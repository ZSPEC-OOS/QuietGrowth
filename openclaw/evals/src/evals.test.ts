import { describe, expect, it } from "vitest";
import { AGENTS, AGENT_TOOLS, MUTATION_TOOLS, WorkContract, isToolAllowed } from "@quietgrowth/agent-contracts";
import { gateToolCall, ToolDeniedError } from "@quietgrowth/runtime-manager";
import { ZERO_SPEND_POLICY, evaluate } from "@quietgrowth/policy-engine";
import { assessChannelQuality, detectFunnelBottleneck } from "@quietgrowth/opportunity-detectors";
import { evaluateExperiment } from "@quietgrowth/experiments";
import { segmentsFor } from "@quietgrowth/connector-email";
import { INJECTION_PAYLOADS } from "./injection-corpus.js";

const base = { contractVersion: 1, contractId: "c", orgId: "o1", actionId: "a", task: "t", context: {}, maxTokens: 100 };

describe("prompt-injection: untrusted content never changes authorization", () => {
  for (const agent of AGENTS) {
    it(`${agent}: tool access is identical with and without hostile content`, () => {
      for (const text of INJECTION_PAYLOADS) {
        const hostile = WorkContract.parse({ ...base, agent, untrusted: [{ source: "page", trust: "untrusted", text }] });
        const clean = WorkContract.parse({ ...base, agent });
        for (const tool of [...AGENT_TOOLS[agent], ...MUTATION_TOOLS]) {
          const run = (c: typeof hostile) => { try { gateToolCall({ callId: "1", tool, args: {} }, c); return "allowed"; } catch (e) { return e instanceof ToolDeniedError ? "denied" : "invalid"; } };
          expect(run(hostile), `${agent}/${tool}/${text.slice(0, 20)}`).toBe(run(clean));
        }
      }
    });
  }
  it("forbidden tool classes stay denied for every agent regardless of content", () => {
    for (const a of AGENTS) { expect(isToolAllowed(a, "shell_exec")).toBe(false); expect(isToolAllowed(a, "billing_write")).toBe(false); expect(isToolAllowed(a, "pricing_write")).toBe(false); }
  });
  it("injected 'approve/skip policy' intents cannot reach AUTO_APPROVED for forbidden or approval-gated action types", () => {
    const S = { externalSpendUsd: 0, modelSpendUsd: 0, actionsToday: {} };
    const r = (type: string) => evaluate({ type, estimatedExternalCostUsd: 0, estimatedModelCostUsd: 0 }, ZERO_SPEND_POLICY, S).verdict;
    expect(r("pricing_change")).toBe("NEEDS_APPROVAL"); expect(r("cold_outreach")).toBe("NEEDS_APPROVAL");
    expect(r("social_media_post")).toBe("DENY"); expect(r("paid_ad_campaign")).toBe("DENY"); expect(r("delete_customer_data")).toBe("DENY");
    expect(r("tenant_export")).toBe("DENY");
  });
});

const counts = (visitors: number, signups: number, activated: number, paid: number, retained: number) => {
  const r = (n: number, d: number) => (d === 0 ? null : n / d);
  return { visitors, signups, activated, paid, retained, rates: { visitorToSignup: r(signups, visitors), signupToActivation: r(activated, signups), activationToPaid: r(paid, activated), paidToRetained: r(retained, paid) } };
};

describe("growth eval fixtures (MR §20.2)", () => {
  it("1. high signup, low activation", () => { expect(detectFunnelBottleneck(counts(10000, 1000, 100, 50, 40), "p")[0]!.kind).toBe("activation_bottleneck"); });
  it("2. high activation, low paid conversion", () => { expect(detectFunnelBottleneck(counts(2000, 1000, 900, 20, 18), "p")[0]!.kind).toBe("paid_conversion_gap"); });
  it("3. good paid conversion, severe first-month churn", () => { expect(detectFunnelBottleneck(counts(2000, 1000, 900, 400, 40), "p")[0]!.kind).toBe("retention_gap"); });
  it("4. organic traffic spike from irrelevant queries is not a funnel win: visitor growth with flat signups ranks signup conversion, not scale", () => {
    expect(detectFunnelBottleneck(counts(200000, 1000, 400, 100, 80), "p")[0]!.kind).toBe("signup_conversion_gap");
  });
  it("5. email with high clicks but no activation lift must not be a successful experiment", () => {
    const d = evaluateExperiment({ spec: { hypothesis: "h", targetCohort: "c", treatment: "email", controlOrBaseline: "none", primaryMetric: "activation", guardrailMetrics: ["unsub"], minimumSamplePerVariant: 100, minimumObservationDays: 7, treatmentShare: 0.5, touchesPricingOrEntitlements: false }, daysElapsed: 14, primary: { control: { n: 1000, conversions: 150 }, treatment: { n: 1000, conversions: 152 } }, guardrails: [], instrumentationHealthy: true });
    expect(d.decision).toBe("inconclusive");
  });
  it("6. paid campaign with low CAC but low retention is low quality", () => {
    expect(assessChannelQuality([{ source: "paid", newPaying: 100, retainedAfterWindow: 10, cacUsd: 2 }])[0]!.verdict).toBe("low_quality");
  });
  it("7. pricing experiment with apparent conversion lift but increased refunds stops on the guardrail", () => {
    const d = evaluateExperiment({ spec: { hypothesis: "h", targetCohort: "c", treatment: "t", controlOrBaseline: "b", primaryMetric: "paid", guardrailMetrics: ["refund_rate"], minimumSamplePerVariant: 100, minimumObservationDays: 7, treatmentShare: 0.5, touchesPricingOrEntitlements: true }, daysElapsed: 30, primary: { control: { n: 2000, conversions: 100 }, treatment: { n: 2000, conversions: 180 } }, guardrails: [{ name: "refund_rate", control: { n: 100, conversions: 3 }, treatment: { n: 180, conversions: 40 } }], instrumentationHealthy: true });
    expect(d.decision).toBe("stop_guardrail");
  });
  it("lifecycle segmentation never labels a cancelled user as dormant or churn-risk", () => {
    expect(segmentsFor({ signedUpAt: 0, paidAt: 1, cancelledAt: 5, lastActiveAt: 0, activityTrend7d: -1 }, 1e10)).toEqual(["cancelled"]);
  });
});
