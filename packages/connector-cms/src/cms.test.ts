import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore, signAuthorization } from "@quietgrowth/policy-engine";
import type { HttpRequest, HttpResponse } from "@quietgrowth/connectors-core";
import { ForbiddenBranchError, ForbiddenPathError, GithubConnector, assertRepoRef, assertSafePatch, type PrRequest } from "./index.js";

const secret = "s";
const repo = { owner: "o", repo: "r", baseBranch: "main" };
const req: PrRequest = { repo, branch: "qg/a1", patches: [{ path: "content/p.md", content: "hi", message: "m" }], title: "t", body: "b", actionId: "a1", policyVersion: "v1" };
const tok = (o = {}) => signAuthorization({ actionId: "a1", policyVersion: "v1", resourceScope: GithubConnector.scope(repo, "qg/a1"), idempotencyKey: "k1", expiresAt: 9e9, ...o }, secret);
const ok = (status: number, json: unknown = {}): HttpResponse => ({ status, headers: {}, json, text: "" });
const fake = () => {
  const calls: HttpRequest[] = [];
  const http = async (r: HttpRequest) => {
    calls.push(r);
    if (r.method === "GET" && r.url.includes("/git/ref/")) return ok(200, { object: { sha: "abc" } });
    if (r.method === "POST" && r.url.endsWith("/git/refs")) return ok(201);
    if (r.method === "GET" && r.url.includes("/contents/")) return ok(404);
    if (r.method === "PUT") return ok(201);
    if (r.method === "POST" && r.url.endsWith("/pulls")) return ok(201, { number: 7, html_url: "https://gh/pr/7" });
    return ok(500);
  };
  return { calls, c: new GithubConnector(http, async () => "ghtok", { secret, store: new InMemoryIdempotencyStore(), now: () => 1 }, ["content"]) };
};

describe("repository reference validation (URL-path injection / wrong-repo)", () => {
  it("rejects coordinates that could alter the API path or target another repo", () => {
    for (const bad of [{ owner: "o/../x", repo: "r" }, { owner: "o", repo: "r/pulls" }, { owner: "..", repo: "r" }, { owner: "o", repo: "r?x=1" }, { owner: "o", repo: "" }])
      expect(() => assertRepoRef({ ...bad, baseBranch: "main" })).toThrow(ForbiddenPathError);
    expect(() => assertRepoRef({ owner: "o", repo: "r", baseBranch: "../main" })).toThrow();
    expect(() => assertRepoRef({ owner: "o", repo: "r", baseBranch: "main" })).not.toThrow();
    expect(() => assertRepoRef({ owner: "O", repo: "R", baseBranch: "main" }, [{ owner: "o", repo: "r" }])).not.toThrow();
    expect(() => assertRepoRef({ owner: "evil", repo: "r", baseBranch: "main" }, [{ owner: "o", repo: "r" }])).toThrow("not connected");
  });
  it("connector refuses other repositories before any network call", async () => {
    const calls: HttpRequest[] = [];
    const c = new GithubConnector(async (r) => { calls.push(r); return ok(200, {}); }, async () => "t", { secret, store: new InMemoryIdempotencyStore(), now: () => 1 }, ["content"], undefined, [{ owner: "o", repo: "r" }]);
    await expect(c.openPullRequest({ ...req, repo: { owner: "victim", repo: "secrets", baseBranch: "main" } }, tok())).rejects.toThrow(ForbiddenPathError);
    await expect(c.read({ owner: "o", repo: "r/../../x", baseBranch: "main" }, "content/a.md")).rejects.toThrow(ForbiddenPathError);
    await expect(c.read(repo, ".github/workflows/ci.yml")).rejects.toThrow(ForbiddenPathError);
    expect(calls).toHaveLength(0);
  });
});

describe("GithubConnector.openPullRequest", () => {
  it("creates branch, commits, opens PR and returns a receipt", async () => {
    const { c, calls } = fake();
    const r = await c.openPullRequest(req, tok());
    expect(r).toMatchObject({ provider: "github", resourceId: "7", idempotencyKey: "k1" });
    expect(calls.filter((x) => x.method !== "GET").map((x) => x.method)).toEqual(["POST", "PUT", "POST"]);
    expect((calls.find((x) => x.method === "PUT")!.body as any).branch).toBe("qg/a1");
  });
  it("never writes to the default branch or outside the qg/ namespace", async () => {
    const { c, calls } = fake();
    await expect(c.openPullRequest({ ...req, branch: "main" }, tok())).rejects.toThrow(ForbiddenBranchError);
    await expect(c.openPullRequest({ ...req, branch: "feature/x" }, tok())).rejects.toThrow(ForbiddenBranchError);
    expect(calls).toHaveLength(0);
  });
  it("rejects bad paths before any network call", async () => {
    const { c, calls } = fake();
    for (const path of ["../etc/passwd", ".github/workflows/ci.yml", "content/../.env", "/abs", "other/x.md", "content/.env.local"])
      await expect(c.openPullRequest({ ...req, patches: [{ path, content: "", message: "" }] }, tok())).rejects.toThrow(ForbiddenPathError);
    expect(calls).toHaveLength(0);
  });
  it("requires authorization bound to this branch and no network before verification", async () => {
    const { c, calls } = fake();
    await expect(c.openPullRequest(req, tok({ resourceScope: GithubConnector.scope(repo, "qg/other") }))).rejects.toThrow("not authorized");
    await expect(c.openPullRequest(req, "x")).rejects.toThrow("not authorized");
    expect(calls).toHaveLength(0);
  });
  it("replayed token is refused", async () => {
    const { c } = fake(); const t = tok();
    await c.openPullRequest(req, t);
    await expect(c.openPullRequest(req, t)).rejects.toThrow("replay");
  });
  it("assertSafePatch allows nested content paths", () => { expect(() => assertSafePatch({ path: "content/a/b.md", content: "", message: "" }, ["content"])).not.toThrow(); });
});
