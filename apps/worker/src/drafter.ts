import type { PoolClient } from "pg";
import type { NewAction } from "@quietgrowth/growth-engine";
import { policyTypeFor, type SeoOperation, type SeoPayload } from "@quietgrowth/acquisition";
import type { RepoRef } from "@quietgrowth/connector-cms";
import type { DetectedOpportunity } from "@quietgrowth/opportunity-detectors";
import type { Drafter } from "./ports.js";

/**
 * Deterministic fallback drafter: usable with no model at all. It only drafts conservative
 * metadata operations from SEO opportunities; anything else is left for agent drafting.
 * The URL→file mapping comes from repo config, never from model output.
 */
export class RuleBasedSeoDrafter implements Drafter {
  constructor(private readonly repo: (orgId: string) => Promise<RepoRef | null>, private readonly fileFor: (url: string) => string | null, private readonly titleFor: (query: string, page: string) => string) {}

  async draft(orgId: string, opp: DetectedOpportunity & { id: string }, _c: PoolClient): Promise<NewAction | null> {
    if (!opp.kind.startsWith("seo_low_ctr")) return null;
    const ev = opp.evidence as { page?: string; query?: string };
    if (!ev.page || !ev.query) return null;
    const repo = await this.repo(orgId);
    const path = this.fileFor(ev.page);
    if (!repo || !path) return null;
    const operation: SeoOperation = { op: "metadata", path, title: this.titleFor(ev.query, ev.page) };
    const payload: SeoPayload = { repo, operation, targetUrl: ev.page, marker: `qg:${opp.dedupeKey}` };
    return {
      orgId, domain: "acquisition", type: policyTypeFor(operation), channel: "organic_search", targetMetric: "organic_signups", guardrailMetrics: ["bounce_rate", "activation_rate"],
      rationale: `Page ranks in the top 10 for "${ev.query}" with a low click-through rate; rewriting the title to match the query intent.`,
      evidence: [opp.evidence], expectedIncrementalImpact: opp.score, confidence: 0.5, estimatedExternalCostUsd: 0, estimatedModelCostUsd: 0,
      idempotencyKey: opp.dedupeKey, payload,
    };
  }
}
