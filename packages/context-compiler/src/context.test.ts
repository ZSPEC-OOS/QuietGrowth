import { describe, expect, it } from "vitest";
import { ContextBudgetError, compileContext, estimateTokens } from "./index.js";

describe("compileContext", () => {
  it("is deterministic and within budget", () => {
    const s = [{ key: "a", priority: 1, content: "x".repeat(400) }, { key: "policy", priority: 10, content: { m: "zero" }, required: true }];
    const r1 = compileContext(s, 60), r2 = compileContext([...s].reverse(), 60);
    expect(r1).toEqual(r2);
    expect(r1.tokens).toBeLessThanOrEqual(60);
    expect(r1.dropped).toEqual(["a"]);
    expect(r1.context.policy).toEqual({ m: "zero" });
  });
  it("trims arrays before dropping", () => {
    const r = compileContext([{ key: "past", priority: 1, content: Array.from({ length: 200 }, (_, i) => `item-${i}`) }], 100);
    expect(r.truncated).toEqual(["past"]);
    expect((r.context.past as unknown[]).length).toBeGreaterThan(0);
    expect(r.tokens).toBeLessThanOrEqual(100);
  });
  it("errors when a required section cannot fit", () => {
    expect(() => compileContext([{ key: "policy", priority: 1, content: "x".repeat(4000), required: true }], 50)).toThrow(ContextBudgetError);
  });
  it("estimate is stable", () => expect(estimateTokens("abcd")).toBe(estimateTokens("abcd")));
});
