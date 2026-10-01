import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "@quietgrowth/policy-engine";
import { GithubConnector } from "@quietgrowth/connector-cms";
import type { HttpRequest, HttpResponse } from "@quietgrowth/connectors-core";
import { ZERO_SPEND_POLICY } from "@quietgrowth/policy-engine";
import { GrowthEngine, MemoryActionStore, type NewAction } from "@quietgrowth/growth-engine";
import { sha256 } from "@quietgrowth/verification";
import { parseSeoPayload, SeoExecutor, PullRequestVerifier, FunnelOutcomeEvaluator, applyOperation, branchFor, candidateFromSignal, checkLinks, policyTypeFor, prepublishChecks, scopeForSeo, similarity, type SeoPayload } from "./index.js";

const page = `<html><head><title>Old</title><meta name="description" content="old"></head><body><p>Our CRM helps teams</p></body></html>`;
const marker = "qg:a1";

describe("applyOperation", () => {
  it("rewrites title/description idempotently and adds marker once", () => {
    const out = applyOperation({ op: "metadata", path: "p.html", title: "New <b>", description: 'Say "hi"' }, page, marker);
    expect(out).toContain("<title>New &lt;b></title>"); expect(out).toContain('content="Say &quot;hi&quot;"'); expect(out.match(/qg:a1/g)).toHaveLength(1);
    expect(applyOperation({ op: "metadata", path: "p.html", title: "New <b>", description: 'Say "hi"' }, out, marker)).toBe(out);
  });
  it("internal link wraps first unlinked anchor and refuses to double-link", () => {
    const out = applyOperation({ op: "internal_link", path: "p.html", anchorText: "CRM", targetPath: "/crm" }, page, marker);
    expect(out).toContain('<a href="/crm">CRM</a>');
    expect(() => applyOperation({ op: "internal_link", path: "p.html", anchorText: "CRM", targetPath: "/crm" }, out, marker)).toThrow("already linked");
    expect(() => applyOperation({ op: "internal_link", path: "p.html", anchorText: "missing", targetPath: "/x" }, page, marker)).toThrow();
  });
  it("faq schema escapes angle brackets; new pages cannot overwrite", () => {
    const out = applyOperation({ op: "faq_schema", path: "p.html", faqs: [{ q: "Is it </script>?", a: "No" }] }, page, marker);
    expect(out).not.toContain("</script>?"); expect(out).toContain("FAQPage");
    expect(() => applyOperation({ op: "new_intent_page", path: "p.html", markdown: "# x" }, page, marker)).toThrow("already exists");
    expect(applyOperation({ op: "new_intent_page", path: "n.md", markdown: "# x" }, null, marker)).toContain(marker);
  });
  it("maps operations to policy action types", () => {
    expect(policyTypeFor({ op: "metadata", path: "x" })).toBe("metadata_change");
    expect(policyTypeFor({ op: "new_intent_page", path: "x", markdown: "" })).toBe("new_intent_page");
  });
});

describe("pre-publish checks", () => {
  const knowledge = [{ kind: "claim" as const, content: "Used by 2,000 teams" }, { kind: "pricing" as const, content: "$29/mo" }, { kind: "prohibited_claim" as const, content: "guaranteed results" }, { kind: "competitor" as const, content: "Rivalco" }];
  it("passes grounded copy and fails invented figures, prohibited and deceptive claims", () => {
    expect(prepublishChecks({ text: "Plans from $29/mo.", knowledge, existingPages: [], allowedHosts: ["x.com"] }).ok).toBe(true);
    expect(prepublishChecks({ text: "Only $9/mo!", knowledge, existingPages: [], allowedHosts: [] }).checks.find((c) => c.name === "figures_verified")!.ok).toBe(false);
    expect(prepublishChecks({ text: "We offer guaranteed results", knowledge, existingPages: [], allowedHosts: [] }).ok).toBe(false);
    expect(prepublishChecks({ text: "Rivalco is a scam", knowledge, existingPages: [], allowedHosts: [] }).ok).toBe(false);
  });
  it("detects duplicates and off-host/spammy links", () => {
    const t = "the quick brown fox jumps over the lazy dog every single morning";
    expect(similarity(t, t)).toBe(1);
    expect(prepublishChecks({ text: t, knowledge: [], existingPages: [t], allowedHosts: [] }).ok).toBe(false);
    expect(checkLinks("see https://evil.biz/x", ["x.com"])[0]!.ok).toBe(false);
    expect(checkLinks("[a](/ok) [b](/../x)", ["x.com"]).find((c) => c.name === "internal_links_wellformed")!.ok).toBe(false);
  });
});

describe("parseSeoPayload (agent output is untrusted)", () => {
  const good = { repo: { owner: "o", repo: "r", baseBranch: "main" }, targetUrl: "https://x.com/p", marker: "qg:k", operation: { op: "metadata", path: "content/p.html", title: "T" } };
  it("accepts a well-formed payload", () => { expect(parseSeoPayload(good).operation.op).toBe("metadata"); });
  it.each([
    ["path traversal", { ...good, operation: { op: "metadata", path: "../x" } }],
    ["absolute path", { ...good, operation: { op: "metadata", path: "/etc/passwd" } }],
    ["repo path injection", { ...good, repo: { owner: "o", repo: "r/../../x", baseBranch: "main" } }],
    ["unknown operation", { ...good, operation: { op: "delete_everything", path: "a" } }],
    ["extra fields", { ...good, extra: 1 }],
    ["non-relative link target", { ...good, operation: { op: "internal_link", path: "a.html", anchorText: "x", targetPath: "https://evil.com" } }],
    ["null", null],
  ])("rejects %s", (_n, bad) => { expect(() => parseSeoPayload(bad)).toThrow("invalid SEO payload"); });
});

describe("candidateFromSignal", () => {
  it("scores deterministically within [0,1]", () => {
    const c = candidateFromSignal({ kind: "low_ctr", page: "p", query: "q", impressions: 3000, position: 3, ctr: 0.001, dedupeKey: "k" }, "o");
    expect(c.score).toBeGreaterThan(0); expect(c.score).toBeLessThanOrEqual(1);
    expect(candidateFromSignal({ kind: "low_ctr", impressions: 3000, position: 3, ctr: 0.001, dedupeKey: "k" }, "o").score).toBe(c.score);
  });
});

describe("end-to-end SEO closed loop (fakes)", () => {
  const repo = { owner: "o", repo: "r", baseBranch: "main" };
  const payload: SeoPayload = { repo, targetUrl: "https://x.com/p", marker, operation: { op: "metadata", path: "content/p.html", title: "Better title" } };
  const newAction = (): NewAction => ({ orgId: "org1", domain: "acquisition", type: policyTypeFor(payload.operation), targetMetric: "organic_signups", guardrailMetrics: ["bounce_rate"], rationale: "Low CTR on /p", evidence: ["gsc:1"], expectedIncrementalImpact: 0.3, confidence: 0.6, estimatedExternalCostUsd: 0, estimatedModelCostUsd: 0.002, idempotencyKey: "seo:low_ctr:p", payload });

  function build(opts: { prContent?: string } = {}) {
    const written: Record<string, string> = {};
    const calls: HttpRequest[] = [];
    const ok = (status: number, json: unknown = {}): HttpResponse => ({ status, headers: {}, json, text: "" });
    const http = async (r: HttpRequest) => {
      calls.push(r);
      if (r.method === "GET" && r.url.includes("/contents/")) return r.url.includes("ref=main") ? ok(200, { content: Buffer.from(page).toString("base64"), sha: "s" }) : ok(404);
      if (r.method === "GET") return ok(200, { object: { sha: "abc" } });
      if (r.method === "POST" && r.url.endsWith("/git/refs")) return ok(201);
      if (r.method === "PUT") { written["content/p.html"] = Buffer.from((r.body as any).content, "base64").toString(); return ok(201); }
      if (r.method === "POST" && r.url.endsWith("/pulls")) return ok(201, { number: 11, html_url: "u" });
      return ok(500);
    };
    const auth = { secret: "sec", store: new InMemoryIdempotencyStore(), now: () => 1000 };
    const github = new GithubConnector(http, async () => "t", auth, ["content"]);
    const store = new MemoryActionStore();
    const engine = new GrowthEngine({
      store, authSecret: "sec", now: () => 1000, scopeFor: scopeForSeo, policies: { current: async () => ZERO_SPEND_POLICY },
      executor: new SeoExecutor({ github, knowledge: async () => [], existingPages: async () => [], allowedHosts: ["x.com"] }),
      verifier: new PullRequestVerifier(async () => ({ state: "open", headRef: "", fileHashes: {} }) as never, async () => ({ path: "content/p.html", content: "" })),
      outcomes: new FunnelOutcomeEvaluator(async () => ({ before: [], after: [], map: { signup: "s", activation: "a", paid: "p" }, retentionDays: 30, guardrail: { before: 1, after: 1, worseIfHigher: true } })),
    });
    return { store, engine, written, calls, github, auth };
  }

  it("proposal → auto-approve → PR opened on qg/ branch → PR verified → observed", async () => {
    const t = build();
    const { action } = await t.engine.propose(newAction());
    expect(action.status).toBe("AUTO_APPROVED");
    const expected = applyOperation(payload.operation, page, marker);
    // Rebuild engine with a verifier that reads the PR we just "opened".
    const verifier = new PullRequestVerifier(async () => ({ state: "open", headRef: branchFor(action), fileHashes: { "content/p.html": sha256(t.written["content/p.html"] ?? "") } }), async () => ({ path: "content/p.html", content: expected }));
    const engine2 = new GrowthEngine({ store: t.store, authSecret: "sec", now: () => 1000, scopeFor: scopeForSeo, policies: { current: async () => ZERO_SPEND_POLICY }, executor: new SeoExecutor({ github: t.github, knowledge: async () => [], existingPages: async () => [], allowedHosts: ["x.com"] }), verifier, outcomes: new FunnelOutcomeEvaluator(async () => ({ before: [{ subjectId: "u", event: "s", at: 1 }], after: [{ subjectId: "a", event: "s", at: 2 }, { subjectId: "b", event: "s", at: 3 }], map: { signup: "s", activation: "a", paid: "p" }, retentionDays: 30, guardrail: { before: 1, after: 1, worseIfHigher: true } })) });
    const run = await engine2.runAutoApproved("org1", action.id);
    expect(run.verification!.checks.every((c) => c.ok)).toBe(true);
    expect(run.action.status).toBe("SUCCEEDED");
    expect(t.written["content/p.html"]).toBe(expected);
    expect(t.calls.some((c) => c.method === "POST" && JSON.stringify(c.body).includes(branchFor(action)))).toBe(true);
    await engine2.observe("org1", action.id);
    const ev = await engine2.evaluateOutcome("org1", action.id);
    expect(ev.outcome.label).toBe("observational"); expect((ev.outcome.summary as any).signupsDelta).toBe(1);
  });

  it("verification fails when the PR content differs from the intended patch", async () => {
    const t = build();
    const { action } = await t.engine.propose(newAction());
    const verifier = new PullRequestVerifier(async () => ({ state: "open", headRef: branchFor(action), fileHashes: { "content/p.html": "tampered" } }), async () => ({ path: "content/p.html", content: "expected" }));
    const v = await verifier.verify(action, { resourceId: "11" });
    expect(v.ok).toBe(false); expect(v.checks.find((c) => c.name === "content_hash_matches")!.ok).toBe(false);
  });

  it("pre-publish check failure aborts before any PR is opened", async () => {
    const t = build();
    const exec = new SeoExecutor({ github: t.github, knowledge: async () => [{ kind: "prohibited_claim", content: "better title" }], existingPages: async () => [], allowedHosts: [] });
    const { action } = await t.engine.propose(newAction());
    await expect(exec.execute(action, "tok")).rejects.toThrow("pre-publish checks failed");
    expect(t.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});
