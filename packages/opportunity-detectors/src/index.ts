import { valueScore } from "@quietgrowth/domain";
import { dropAnomaly, type FunnelCounts } from "@quietgrowth/metrics";

// Deterministic opportunity detectors for activation, conversion, retention and PLG (MR §8.4, §10.2, §10.5, §10.7).
export type Domain = "acquisition" | "activation" | "conversion" | "retention" | "expansion" | "economics";
export interface DetectedOpportunity { dedupeKey: string; domain: Domain; funnelStage: string; kind: string; score: number; evidence: Record<string, unknown>; insufficientData?: boolean }

export const MIN_STAGE_SAMPLE = 30;

type Stage = "visitor_to_signup" | "signup_to_activation" | "activation_to_paid" | "paid_to_retained";
const STAGES: { key: Stage; from: keyof FunnelCounts; to: keyof FunnelCounts; rate: keyof FunnelCounts["rates"]; domain: Domain; kind: string }[] = [
  { key: "visitor_to_signup", from: "visitors", to: "signups", rate: "visitorToSignup", domain: "acquisition", kind: "signup_conversion_gap" },
  { key: "signup_to_activation", from: "signups", to: "activated", rate: "signupToActivation", domain: "activation", kind: "activation_bottleneck" },
  { key: "activation_to_paid", from: "activated", to: "paid", rate: "activationToPaid", domain: "conversion", kind: "paid_conversion_gap" },
  { key: "paid_to_retained", from: "paid", to: "retained", rate: "paidToRetained", domain: "retention", kind: "retention_gap" },
];

/**
 * Default planning priors for stage conversion rates. These are NOT facts about the product:
 * they only rank which stage looks weakest, and are overridable per tenant. Evidence labels them as priors.
 */
export const DEFAULT_STAGE_BENCHMARKS: Record<Stage, number> = { visitor_to_signup: 0.03, signup_to_activation: 0.4, activation_to_paid: 0.15, paid_to_retained: 0.8 };

/**
 * Ranks stages by relative shortfall against the benchmark rate (MR §6.3 bottleneck detection).
 * Absolute losses are not comparable across stages (entrants differ by orders of magnitude).
 * Stages below the sample floor are reported as insufficient data rather than ranked.
 */
export function detectFunnelBottleneck(c: FunnelCounts, period: string, benchmarks: Record<Stage, number> = DEFAULT_STAGE_BENCHMARKS): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  const rows = STAGES.map((s) => ({ s, entrants: c[s.from] as number, loss: (c[s.from] as number) - (c[s.to] as number), rate: c.rates[s.rate] }));
  const ranked = rows
    .filter((r) => r.entrants >= MIN_STAGE_SAMPLE && r.rate !== null)
    .map((r) => ({ ...r, shortfall: Math.max(0, 1 - (r.rate as number) / benchmarks[r.s.key]) }))
    .filter((r) => r.shortfall > 0)
    .sort((a, b) => b.shortfall - a.shortfall || a.s.key.localeCompare(b.s.key));
  for (const r of ranked)
    out.push({
      dedupeKey: `funnel:${r.s.key}:${period}`, domain: r.s.domain, funnelStage: r.s.key, kind: r.s.kind,
      score: valueScore({ expectedIncrementalImpact: r.shortfall, confidence: Math.min(0.8, r.entrants / 500), ease: 0.5, timeToSignal: 0.5, reversibility: 0.8, strategicFit: 0.8, evidenceQualityCap: 0.8 }),
      evidence: { entrants: r.entrants, loss: r.loss, rate: r.rate, benchmark: benchmarks[r.s.key], benchmarkIsPrior: true, shortfall: r.shortfall, topBottleneck: r === ranked[0] },
    });
  for (const r of rows.filter((x) => x.entrants < MIN_STAGE_SAMPLE && x.entrants > 0))
    out.push({ dedupeKey: `insufficient:${r.s.key}:${period}`, domain: r.s.domain, funnelStage: r.s.key, kind: "insufficient_data", score: 0, evidence: { entrants: r.entrants, floor: MIN_STAGE_SAMPLE }, insufficientData: true });
  return out.sort((a, b) => b.score - a.score || a.dedupeKey.localeCompare(b.dedupeKey));
}

/** Weekly activation-rate series regression (MR §10.2 cohort anomaly). */
export function detectActivationRegression(weeklyRates: { week: string; rate: number; n: number }[]): DetectedOpportunity[] {
  const usable = weeklyRates.filter((w) => w.n >= MIN_STAGE_SAMPLE);
  const last = usable[usable.length - 1];
  if (!last || usable.length < 5) return [];
  const a = dropAnomaly(usable.map((w) => w.rate));
  if (!a.anomalous) return [];
  return [{ dedupeKey: `activation_regression:${last.week}`, domain: "activation", funnelStage: "signup_to_activation", kind: "activation_regression", score: valueScore({ expectedIncrementalImpact: 0.8, confidence: 0.6, ease: 0.5, timeToSignal: 0.7, reversibility: 0.8, strategicFit: 0.9, evidenceQualityCap: 0.8 }), evidence: { week: last.week, rate: last.rate, zscore: a.zscore } }];
}

/** Surfaces a product issue instead of a messaging problem when churn follows a specific usage pattern (MR §10.7). */
export function detectChurnDriver(args: { churnedByFeature: Record<string, { churned: number; total: number }>; baselineChurnRate: number; period: string }): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  for (const [feature, v] of Object.entries(args.churnedByFeature)) {
    if (v.total < MIN_STAGE_SAMPLE) continue;
    const rate = v.churned / v.total;
    if (rate >= args.baselineChurnRate * 1.5 && rate - args.baselineChurnRate >= 0.05)
      out.push({ dedupeKey: `churn_driver:${feature}:${args.period}`, domain: "retention", funnelStage: "paid_to_retained", kind: "product_issue_churn_driver", score: valueScore({ expectedIncrementalImpact: Math.min(1, (rate - args.baselineChurnRate) * 4), confidence: 0.5, ease: 0.3, timeToSignal: 0.3, reversibility: 0.6, strategicFit: 0.9, evidenceQualityCap: 0.7 }), evidence: { feature, rate, baseline: args.baselineChurnRate, note: "surface to product owner; not a messaging fix" } });
  }
  return out;
}

export interface PlgFacts { hasInviteFeature: boolean; hasExportOrShare: boolean; integrations: string[]; multiUser: boolean; hasTemplates: boolean; existingIntegrationPages: string[] }

/** Referral/invite, share loops, integration pages, templates (MR §10.5). Proposal templates only; changes need approval. */
export function detectPlgOpportunities(f: PlgFacts, period: string): DetectedOpportunity[] {
  const o: DetectedOpportunity[] = [];
  const base = { confidence: 0.4, timeToSignal: 0.3, reversibility: 0.7, strategicFit: 0.7, evidenceQualityCap: 0.6 };
  if (f.multiUser && f.hasInviteFeature) o.push({ dedupeKey: `plg:invite_prompt:${period}`, domain: "expansion", funnelStage: "activation", kind: "team_invite_prompt_after_value_moment", score: valueScore({ ...base, expectedIncrementalImpact: 0.5, ease: 0.4 }), evidence: { requires: "approval", surface: "in_product" } });
  if (f.hasExportOrShare) o.push({ dedupeKey: `plg:share_loop:${period}`, domain: "acquisition", funnelStage: "visitor_to_signup", kind: "share_export_loop", score: valueScore({ ...base, expectedIncrementalImpact: 0.4, ease: 0.5 }), evidence: { requires: "approval", surface: "in_product" } });
  for (const i of f.integrations.filter((x) => !f.existingIntegrationPages.includes(x)))
    o.push({ dedupeKey: `plg:integration_page:${i.toLowerCase()}`, domain: "acquisition", funnelStage: "visitor_to_signup", kind: "integration_page", score: valueScore({ ...base, expectedIncrementalImpact: 0.45, ease: 0.7 }), evidence: { integration: i, requires: "approval_for_new_page" } });
  if (f.hasTemplates) o.push({ dedupeKey: `plg:template_gallery:${period}`, domain: "acquisition", funnelStage: "visitor_to_signup", kind: "template_gallery_pages", score: valueScore({ ...base, expectedIncrementalImpact: 0.4, ease: 0.4 }), evidence: { requires: "approval_for_new_page" } });
  return o.sort((a, b) => b.score - a.score || a.dedupeKey.localeCompare(b.dedupeKey));
}

/** Channel quality: low CAC but poor retention must not be scored as success (MR eval fixture 6). */
export function assessChannelQuality(ch: { source: string; newPaying: number; retainedAfterWindow: number; cacUsd: number | null }[], minPaying = 10): { source: string; verdict: "healthy" | "low_quality" | "insufficient_data"; retentionRate: number | null }[] {
  return ch.map((c) => {
    if (c.newPaying < minPaying) return { source: c.source, verdict: "insufficient_data" as const, retentionRate: null };
    const r = c.retainedAfterWindow / c.newPaying;
    return { source: c.source, verdict: r < 0.4 ? ("low_quality" as const) : ("healthy" as const), retentionRate: r };
  });
}
