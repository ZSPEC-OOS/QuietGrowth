import { describe, expect, it } from "vitest";
import { ACTION_STATES, TRANSITIONS, canTransition, transition, IllegalTransitionError } from "./action-state.js";
import { SCORE_WEIGHTS, valueScore } from "./scoring.js";

describe("action state machine", () => {
  it("allows the happy path", () => {
    const path = ["DISCOVERED","SCORED","PROPOSED","POLICY_CHECK","AUTO_APPROVED","QUEUED","RUNNING","VERIFYING","SUCCEEDED","OBSERVING","EVALUATED"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });
  it("routes approval path", () => {
    expect(transition("POLICY_CHECK", "NEEDS_APPROVAL")).toBe("NEEDS_APPROVAL");
    expect(transition("NEEDS_APPROVAL", "APPROVED")).toBe("APPROVED");
  });
  it("rejects every transition not in the table", () => {
    for (const a of ACTION_STATES) for (const b of ACTION_STATES) {
      if (TRANSITIONS[a].includes(b)) continue;
      expect(() => transition(a, b)).toThrow(IllegalTransitionError);
    }
  });
  it("cannot skip policy or approval", () => {
    expect(canTransition("PROPOSED", "QUEUED")).toBe(false);
    expect(canTransition("NEEDS_APPROVAL", "QUEUED")).toBe(false);
    expect(canTransition("BLOCKED", "QUEUED")).toBe(false);
  });
});

describe("valueScore", () => {
  it("weights sum to 1", () => {
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it("evidence quality caps confidence", () => {
    const base = { expectedIncrementalImpact: 0, confidence: 1, ease: 0, timeToSignal: 0, reversibility: 0, strategicFit: 0 };
    expect(valueScore(base)).toBeCloseTo(0.2);
    expect(valueScore({ ...base, evidenceQualityCap: 0.5 })).toBeCloseTo(0.1);
  });
  it("rejects out-of-range input", () => {
    expect(() => valueScore({ expectedIncrementalImpact: 2, confidence: 0, ease: 0, timeToSignal: 0, reversibility: 0, strategicFit: 0 })).toThrow(RangeError);
  });
});
