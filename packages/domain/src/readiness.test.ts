import { describe, expect, it } from "vitest";
import { evaluateReadiness, type ReadinessInput } from "./readiness.js";

const ok: ReadinessInput = { productConfirmed: true, funnelComplete: true, funnelGaps: [], billingConnected: true, recentSignupEvents: 12, policyConfigured: true, repoConnectedHealthy: true, runtimeHealthy: true, verifierAvailable: true, observationWindowAndMetricDefined: true };
describe("evaluateReadiness", () => {
  it("is ready only when every Appendix B row passes", () => {
    expect(evaluateReadiness(ok)).toMatchObject({ ready: true, blocking: [] });
    for (const k of Object.keys(ok).filter((k) => typeof (ok as never)[k] === "boolean") as (keyof ReadinessInput)[]) {
      const r = evaluateReadiness({ ...ok, [k]: false });
      expect(r.ready, String(k)).toBe(false); expect(r.blocking).toHaveLength(1);
    }
    expect(evaluateReadiness({ ...ok, recentSignupEvents: 0 }).blocking).toEqual(["Analytics"]);
  });
  it("explains gaps", () => {
    expect(evaluateReadiness({ ...ok, funnelComplete: false, funnelGaps: ["activation_event_missing"] }).rows[1]!.detail).toContain("activation_event_missing");
  });
});
