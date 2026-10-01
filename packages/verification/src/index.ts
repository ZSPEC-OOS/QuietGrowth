import { createHash } from "node:crypto";

// Independent postcondition checks, MR §15.2. Uses only injected, read-only fetchers.
export interface HttpResponse { status: number; headers: Record<string, string>; body: string }
export type Fetcher = (url: string) => Promise<HttpResponse>;

export interface Check { name: string; ok: boolean; detail?: string }
export interface Verification { ok: boolean; checks: Check[] }

const wrap = (checks: Check[]): Verification => ({ ok: checks.every((c) => c.ok), checks });
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface PagePostcondition {
  url: string;
  expectedMarker?: string;
  expectedHash?: string;
  canonical?: string;
  analyticsTag?: string;
  sitemapUrl?: string;
}

/** Publish-page verification: 200, marker/hash, canonical, indexability, analytics tag, sitemap. */
export async function verifyPublishedPage(p: PagePostcondition, fetcher: Fetcher): Promise<Verification> {
  const checks: Check[] = [];
  let res: HttpResponse;
  try {
    res = await fetcher(p.url);
  } catch (e) {
    return wrap([{ name: "http_200", ok: false, detail: e instanceof Error ? e.message : "fetch failed" }]);
  }
  checks.push({ name: "http_200", ok: res.status === 200, detail: String(res.status) });
  if (p.expectedMarker !== undefined) checks.push({ name: "marker_present", ok: res.body.includes(p.expectedMarker) });
  if (p.expectedHash !== undefined) checks.push({ name: "content_hash", ok: sha256(res.body) === p.expectedHash });

  const robotsMeta = /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i.exec(res.body)?.[1] ?? "";
  const xRobots = res.headers["x-robots-tag"] ?? "";
  checks.push({ name: "indexable", ok: !/noindex/i.test(robotsMeta + " " + xRobots) });

  if (p.canonical !== undefined) {
    const canon = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(res.body)?.[1];
    checks.push({ name: "canonical", ok: canon === p.canonical, detail: canon });
  }
  if (p.analyticsTag !== undefined) checks.push({ name: "analytics_tag", ok: res.body.includes(p.analyticsTag) });
  if (p.sitemapUrl !== undefined) {
    try {
      const sm = await fetcher(p.sitemapUrl);
      checks.push({ name: "in_sitemap", ok: sm.status === 200 && sm.body.includes(p.url) });
    } catch {
      checks.push({ name: "in_sitemap", ok: false, detail: "sitemap fetch failed" });
    }
  }
  return wrap(checks);
}

/** Lifecycle send: provider accepted id, suppression honoured, no duplicate idempotency key. */
export function verifyLifecycleSend(a: { providerMessageId?: string; recipientSuppressed: boolean; priorReceiptsWithKey: number }): Verification {
  return wrap([
    { name: "provider_accepted", ok: !!a.providerMessageId },
    { name: "suppression_respected", ok: !a.recipientSuppressed },
    { name: "no_duplicate_send", ok: a.priorReceiptsWithKey <= 1 },
  ]);
}

/** Ad change: provider read-back matches, spend cap unchanged. */
export function verifyAdChange(a: { readBackState: string; expectedState: string; capBefore: number; capAfter: number }): Verification {
  return wrap([
    { name: "state_matches", ok: a.readBackState === a.expectedState },
    { name: "spend_cap_unchanged", ok: a.capBefore === a.capAfter },
  ]);
}

/** Feature-flag experiment: assignment endpoint live, events captured, both arms populated. */
export function verifyExperimentLive(a: { assignmentEndpointOk: boolean; eventsCaptured: number; controlCount: number; treatmentCount: number }): Verification {
  return wrap([
    { name: "assignment_endpoint", ok: a.assignmentEndpointOk },
    { name: "events_captured", ok: a.eventsCaptured > 0 },
    { name: "both_arms_populated", ok: a.controlCount > 0 && a.treatmentCount > 0 },
  ]);
}

/** Pricing/billing proposals must not mutate anything; only the proposed catalog diff is verified. */
export function verifyPricingProposal(a: { mutationsPerformed: number; diffPresent: boolean }): Verification {
  return wrap([
    { name: "no_mutation", ok: a.mutationsPerformed === 0 },
    { name: "diff_present", ok: a.diffPresent },
  ]);
}
