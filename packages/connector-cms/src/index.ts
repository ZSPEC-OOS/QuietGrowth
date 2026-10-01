import { authorizeWrite, HealthGate, withRetry, type AuthContext, type HttpClient, type WriteReceipt } from "@quietgrowth/connectors-core";

// GitHub repo connector: branch + patch + PR; never writes to the default branch (MR §21.4, §9.1).
export class ForbiddenPathError extends Error {}
export class ForbiddenBranchError extends Error {}

export interface RepoRef { owner: string; repo: string; baseBranch: string }
export interface FilePatch { path: string; content: string; message: string }
export interface PrRequest { repo: RepoRef; branch: string; patches: FilePatch[]; title: string; body: string; actionId: string; policyVersion: string }

const BRANCH_PREFIX = "qg/";
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_NAME = /^[A-Za-z0-9_./-]{1,200}$/;

/** Repo coordinates end up in API URL paths; reject anything that could change the path or target another repository. */
export function assertRepoRef(r: RepoRef, allowed?: { owner: string; repo: string }[]): void {
  if (!REPO_PART.test(r.owner) || !REPO_PART.test(r.repo) || r.owner === "." || r.owner === ".." || r.repo === "." || r.repo === ".." || !BRANCH_NAME.test(r.baseBranch) || r.baseBranch.includes(".."))
    throw new ForbiddenPathError("invalid repository reference");
  if (allowed && !allowed.some((a) => a.owner.toLowerCase() === r.owner.toLowerCase() && a.repo.toLowerCase() === r.repo.toLowerCase())) throw new ForbiddenPathError("repository is not connected for this organization");
}
const SAFE_PATH = /^(?!.*(^|\/)\.\.(\/|$))(?!\/)[\w./@-]+$/;
const DENIED_PATH = /(^|\/)(\.github|\.git|node_modules|\.env[^/]*|secrets?)(\/|$)/i;

export function assertSafePatch(p: FilePatch, allowedRoots: string[]): void {
  if (!SAFE_PATH.test(p.path) || DENIED_PATH.test(p.path)) throw new ForbiddenPathError(`path not allowed: ${p.path}`);
  if (allowedRoots.length > 0 && !allowedRoots.some((r) => p.path === r || p.path.startsWith(r.endsWith("/") ? r : r + "/")))
    throw new ForbiddenPathError(`path outside allowed roots: ${p.path}`);
}

export class GithubConnector {
  readonly provider = "github";
  readonly gate = new HealthGate();
  constructor(private readonly http: HttpClient, private readonly token: () => Promise<string>, private readonly auth: AuthContext, private readonly allowedRoots: string[] = [], private readonly sleep?: (ms: number) => Promise<void>, private readonly allowedRepos?: { owner: string; repo: string }[]) {}

  /** Resource scope a caller must request authorisation for. */
  static scope(r: RepoRef, branch: string): string { return `repo:${r.owner}/${r.repo}:branch:${branch}`; }

  private async call(method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
    return withRetry(this.http, { method, url: `https://api.github.com${path}`, headers: { authorization: `Bearer ${await this.token()}`, accept: "application/vnd.github+json" }, body }, this.gate, { sleep: this.sleep });
  }

  async read(r: RepoRef, path: string): Promise<{ content: string; sha: string } | null> {
    assertRepoRef(r, this.allowedRepos);
    assertSafePatch({ path, content: "", message: "" }, this.allowedRoots);
    const res = await this.call("GET", `/repos/${r.owner}/${r.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(r.baseBranch)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`github read failed: ${res.status}`);
    const j = res.json as { content: string; sha: string };
    return { content: Buffer.from(j.content, "base64").toString("utf8"), sha: j.sha };
  }

  /** Creates branch, commits patches, opens a PR. Verifies authorisation before any network write. */
  async openPullRequest(req: PrRequest, token: string): Promise<WriteReceipt> {
    assertRepoRef(req.repo, this.allowedRepos);
    if (!req.branch.startsWith(BRANCH_PREFIX) || req.branch === req.repo.baseBranch || !BRANCH_NAME.test(req.branch) || req.branch.includes("..")) throw new ForbiddenBranchError(`branch must start with ${BRANCH_PREFIX}`);
    for (const p of req.patches) assertSafePatch(p, this.allowedRoots);
    const a = authorizeWrite(this.gate, this.auth, token, { actionId: req.actionId, policyVersion: req.policyVersion, resourceScope: GithubConnector.scope(req.repo, req.branch) });
    const { owner, repo, baseBranch } = req.repo;

    const base = await this.call("GET", `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
    if (base.status !== 200) throw new Error(`base branch lookup failed: ${base.status}`);
    const sha = (base.json as { object: { sha: string } }).object.sha;
    const br = await this.call("POST", `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${req.branch}`, sha });
    if (br.status !== 201 && br.status !== 422) throw new Error(`branch create failed: ${br.status}`); // 422: exists (idempotent retry)

    for (const p of req.patches) {
      const existing = await this.call("GET", `/repos/${owner}/${repo}/contents/${encodeURI(p.path)}?ref=${encodeURIComponent(req.branch)}`);
      const put = await this.call("PUT", `/repos/${owner}/${repo}/contents/${encodeURI(p.path)}`, {
        message: p.message, content: Buffer.from(p.content, "utf8").toString("base64"), branch: req.branch,
        ...(existing.status === 200 ? { sha: (existing.json as { sha: string }).sha } : {}),
      });
      if (put.status !== 200 && put.status !== 201) throw new Error(`file commit failed: ${put.status}`);
    }
    const pr = await this.call("POST", `/repos/${owner}/${repo}/pulls`, { title: req.title, head: req.branch, base: baseBranch, body: req.body });
    if (pr.status !== 201 && pr.status !== 422) throw new Error(`pull request failed: ${pr.status}`);
    const j = pr.json as { number?: number; html_url?: string } | null;
    return { provider: "github", resourceId: String(j?.number ?? req.branch), idempotencyKey: a.idempotencyKey, at: this.auth.now(), detail: { url: j?.html_url, branch: req.branch } };
  }
}

/** Rollback = a revert PR is out of scope for the connector; the plan is to close the PR if unmerged. */
export const rollbackScope = (r: RepoRef, branch: string): string => GithubConnector.scope(r, branch);
