import { describe, expect, it } from "vitest";
import { CostLedger, costUsd, withinTokenCeiling, type RateTable } from "./index.js";

const rates: RateTable = { version: "test", perMillionTokensUsd: { cachedInput: 1, uncachedInput: 10, output: 20 } };

describe("cost engine", () => {
  it("computes cost from the supplied rate table", () => {
    expect(costUsd({ cachedInputTokens: 1_000_000, uncachedInputTokens: 500_000, outputTokens: 100_000 }, rates)).toBeCloseTo(1 + 5 + 2);
  });
  it("rejects invalid token counts", () => {
    expect(() => costUsd({ cachedInputTokens: -1, uncachedInputTokens: 0, outputTokens: 0 }, rates)).toThrow(RangeError);
  });
  it("tracks per-org monthly totals and cap", () => {
    const l = new CostLedger();
    l.record("o1", "2026-10", 3); l.record("o1", "2026-10", 2); l.record("o2", "2026-10", 100);
    expect(l.monthTotal("o1", "2026-10")).toBe(5);
    expect(l.capReached("o1", "2026-10", 5)).toBe(true);
    expect(l.capReached("o1", "2026-10", 6)).toBe(false);
    expect(l.capReached("o1", "2026-11", 1)).toBe(false);
  });
  it("token ceiling", () => {
    const u = { cachedInputTokens: 10, uncachedInputTokens: 10, outputTokens: 10 };
    expect(withinTokenCeiling(u, 30)).toBe(true);
    expect(withinTokenCeiling(u, 29)).toBe(false);
  });
});
