import { describe, expect, it } from "vitest";
import { assignVariant, evaluateExperiment, twoProportionTest, validateSpec, type ExperimentSpec } from "./index.js";

const spec: ExperimentSpec = {
  hypothesis: "h", targetCohort: "new", treatment: "t", controlOrBaseline: "c", primaryMetric: "activation",
  guardrailMetrics: ["refund_rate"], minimumSamplePerVariant: 100, minimumObservationDays: 7, treatmentShare: 0.5,
  touchesPricingOrEntitlements: false,
};
const base = { spec, daysElapsed: 14, guardrails: [], instrumentationHealthy: true };

describe("spec + assignment", () => {
  it("validates required fields", () => {
    expect(validateSpec(spec)).toEqual([]);
    expect(validateSpec({ ...spec, guardrailMetrics: [], treatmentShare: 1 })).toHaveLength(2);
  });
  it("assignment is deterministic and roughly respects share", () => {
    expect(assignVariant("e1", "u1", 0.5)).toBe(assignVariant("e1", "u1", 0.5));
    let t = 0;
    for (let i = 0; i < 4000; i++) if (assignVariant("e1", `u${i}`, 0.3) === "treatment") t++;
    expect(t / 4000).toBeGreaterThan(0.27); expect(t / 4000).toBeLessThan(0.33);
  });
});

describe("twoProportionTest", () => {
  it("detects an obvious difference and none for identical arms", () => {
    expect(twoProportionTest({ n: 1000, conversions: 100 }, { n: 1000, conversions: 160 }).p!).toBeLessThan(0.001);
    expect(twoProportionTest({ n: 1000, conversions: 100 }, { n: 1000, conversions: 100 }).p!).toBeCloseTo(1, 1);
    expect(twoProportionTest({ n: 0, conversions: 0 }, { n: 5, conversions: 1 }).p).toBeNull();
  });
});

describe("evaluateExperiment", () => {
  const strong = { control: { n: 1000, conversions: 100 }, treatment: { n: 1000, conversions: 170 } };
  it("proposes a winner (always human-approved, labelled experimental)", () => {
    const d = evaluateExperiment({ ...base, primary: strong });
    expect(d.decision).toBe("propose_winner");
    if (d.decision === "propose_winner") expect(d.requiresHumanApproval).toBe(true);
  });
  it("never declares winners on tiny samples or before the window", () => {
    expect(evaluateExperiment({ ...base, primary: { control: { n: 10, conversions: 1 }, treatment: { n: 10, conversions: 9 } } }).decision).toBe("continue");
    expect(evaluateExperiment({ ...base, daysElapsed: 3, primary: strong }).decision).toBe("continue");
  });
  it("freezes on broken instrumentation", () => {
    expect(evaluateExperiment({ ...base, instrumentationHealthy: false, primary: strong }).decision).toBe("freeze_instrumentation");
  });
  it("stops when a guardrail significantly worsens even if primary improves (eval fixture 7)", () => {
    const d = evaluateExperiment({ ...base, primary: strong, guardrails: [{ name: "refund_rate", control: { n: 1000, conversions: 20 }, treatment: { n: 1000, conversions: 70 } }] });
    expect(d.decision).toBe("stop_guardrail");
  });
  it("inconclusive without significant difference", () => {
    expect(evaluateExperiment({ ...base, primary: { control: { n: 1000, conversions: 100 }, treatment: { n: 1000, conversions: 103 } } }).decision).toBe("inconclusive");
  });
});
