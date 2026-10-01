import { describe, expect, it } from "vitest";
import { AGENTS, AGENT_TOOLS, MUTATION_TOOLS, TOOLS, WorkContract, WorkResult, Proposal, isToolAllowed } from "./index.js";

const base = { contractVersion: 1, contractId: "c1", orgId: "o1", actionId: "a1", agent: "research", task: "t", context: {}, maxTokens: 1000 };

describe("tool policy", () => {
  it("read-only agents have no mutation tools", () => {
    for (const a of ["funnel-analyst", "research"] as const)
      for (const t of MUTATION_TOOLS) expect(isToolAllowed(a, t), `${a}/${t}`).toBe(false);
  });
  it("director is proposal-only", () => {
    for (const t of MUTATION_TOOLS) expect(isToolAllowed("director", t)).toBe(false);
    expect(isToolAllowed("director", "propose_action")).toBe(true);
  });
  it("verifier may only mutate via rollback", () => {
    const m = AGENT_TOOLS.verifier.filter((t) => MUTATION_TOOLS.includes(t));
    expect(m).toEqual(["trigger_rollback"]);
  });
  it("billing/pricing is never reachable by a write tool", () => {
    expect((TOOLS as readonly string[]).some((t) => /billing|pricing/.test(t) && MUTATION_TOOLS.includes(t as never))).toBe(false);
  });
  it("unknown agent/tool denied", () => {
    expect(isToolAllowed("root", "repo_patch")).toBe(false);
    expect(isToolAllowed("acquisition", "shell_exec")).toBe(false);
  });
  it("every agent has an allowlist entry", () => {
    for (const a of AGENTS) expect(AGENT_TOOLS[a]).toBeDefined();
  });
});

describe("schemas", () => {
  it("accepts a valid contract and defaults untrusted", () => {
    expect(WorkContract.parse(base).untrusted).toEqual([]);
  });
  it("rejects unknown fields, agents, versions", () => {
    expect(() => WorkContract.parse({ ...base, extra: 1 })).toThrow();
    expect(() => WorkContract.parse({ ...base, agent: "root" })).toThrow();
    expect(() => WorkContract.parse({ ...base, contractVersion: 2 })).toThrow();
  });
  it("untrusted content must be labelled untrusted", () => {
    expect(() => WorkContract.parse({ ...base, untrusted: [{ source: "s", trust: "trusted", text: "x" }] })).toThrow();
  });
  it("proposal requires evidence", () => {
    const p = { type: "metadata_change", domain: "acquisition", targetMetric: "m", guardrailMetrics: [], rationale: "r", evidenceRefs: [], expectedIncrementalImpact: 0.1, confidence: 0.5, estimatedExternalCostUsd: 0, estimatedModelCostUsd: 0 };
    expect(() => Proposal.parse(p)).toThrow();
    expect(Proposal.parse({ ...p, evidenceRefs: ["e1"] })).toBeTruthy();
  });
  it("result round-trips", () => {
    const r = { contractVersion: 1, contractId: "c1", status: "completed", usage: { cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 } };
    expect(WorkResult.parse(r).proposals).toEqual([]);
  });
});
