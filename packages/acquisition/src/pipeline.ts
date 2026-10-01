import { GithubConnector, type RepoRef } from "@quietgrowth/connector-cms";
import type { Executor, Verifier, ActionRecord, OutcomeEvaluator } from "@quietgrowth/growth-engine";
import { sha256 } from "@quietgrowth/verification";
import type { Fetcher } from "@quietgrowth/verification";
import { funnelCounts, type FunnelEvent, type FunnelEventMap } from "@quietgrowth/metrics";
import { parseSeoPayload, patchFor, type SeoPayload } from "./operations.js";
import { prepublishChecks, type KnowledgeItem } from "./checks.js";

export const branchFor = (a: ActionRecord): string => `qg/${a.id.slice(0, 8)}`;
export const scopeForSeo = (a: ActionRecord): string => GithubConnector.scope(parseSeoPayload(a.payload).repo, branchFor(a));

export interface SeoExecutorDeps { github: GithubConnector; knowledge: () => Promise<KnowledgeItem[]>; existingPages: () => Promise<string[]>; allowedHosts: string[] }

/** SEO & Acquisition Operator hands: read file, run pre-publish checks, open one PR. */
export class SeoExecutor implements Executor {
  constructor(private readonly d: SeoExecutorDeps) {}
  async execute(a: ActionRecord, token: string) {
    const p = parseSeoPayload(a.payload);
    const current = await this.d.github.read(p.repo, p.operation.path);
    const patch = patchFor(p.operation, current?.content ?? null, p.marker);
    const checks = prepublishChecks({ text: patch.content === current?.content ? "" : patch.content, knowledge: await this.d.knowledge(), existingPages: await this.d.existingPages(), allowedHosts: this.d.allowedHosts });
    if (!checks.ok) throw new Error(`pre-publish checks failed: ${checks.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
    return this.d.github.openPullRequest({
      repo: p.repo, branch: branchFor(a), patches: [patch], title: `QuietGrowth: ${p.operation.op} (${a.targetMetric})`,
      body: `${a.rationale}\n\nAction: ${a.id}\nTarget metric: ${a.targetMetric}\nGuardrails: ${a.guardrailMetrics.join(", ")}`,
      actionId: a.id, policyVersion: a.policyVersion,
    }, token);
  }
}

export type PrReader = (repo: RepoRef, prNumber: number) => Promise<{ state: string; headRef: string; fileHashes: Record<string, string> } | null>;

/** Stage-1 verification (repo workflow): the PR exists on the expected branch with the exact patched content. */
export class PullRequestVerifier implements Verifier {
  constructor(private readonly readPr: PrReader, private readonly expectedContent: (a: ActionRecord) => Promise<{ path: string; content: string }>) {}
  async verify(a: ActionRecord, receipt: { resourceId: string }) {
    const p = parseSeoPayload(a.payload);
    const pr = await this.readPr(p.repo, Number(receipt.resourceId));
    const exp = await this.expectedContent(a);
    const checks = [
      { name: "pr_exists", ok: !!pr },
      { name: "pr_open", ok: pr?.state === "open" },
      { name: "head_branch_matches", ok: pr?.headRef === branchFor(a) },
      { name: "content_hash_matches", ok: pr?.fileHashes[exp.path] === sha256(exp.content) },
    ];
    return { ok: checks.every((c) => c.ok), checks };
  }
}

/** Observational evaluation: compares funnel counts before vs. after publish. Never labelled experimental. */
export class FunnelOutcomeEvaluator implements OutcomeEvaluator {
  constructor(private readonly load: (a: ActionRecord) => Promise<{ before: FunnelEvent[]; after: FunnelEvent[]; map: FunnelEventMap; retentionDays: number; guardrail: { before: number; after: number; worseIfHigher: boolean } }>) {}
  async evaluate(a: ActionRecord) {
    const d = await this.load(a);
    const b = funnelCounts(d.before, d.map, d.retentionDays), f = funnelCounts(d.after, d.map, d.retentionDays);
    const worse = d.guardrail.worseIfHigher ? d.guardrail.after > d.guardrail.before * 1.1 : d.guardrail.after < d.guardrail.before * 0.9;
    return {
      label: "observational" as const, guardrailsHeld: !worse,
      summary: { signupsDelta: f.signups - b.signups, activatedDelta: f.activated - b.activated, paidDelta: f.paid - b.paid, retainedDelta: f.retained - b.retained, note: "pre/post comparison; not causal" },
    };
  }
}

/** Stage-2 verification once the PR is merged and deployed: live page checks (MR §15.2). */
export { verifyPublishedPage } from "@quietgrowth/verification";
export type { Fetcher };
