// Autopilot readiness checklist, MR Appendix B (M3.9). Writes stay blocked until every row passes.
export interface ReadinessInput {
  productConfirmed: boolean;
  funnelComplete: boolean;
  funnelGaps: string[];
  billingConnected: boolean;
  recentSignupEvents: number;
  policyConfigured: boolean;
  repoConnectedHealthy: boolean;
  runtimeHealthy: boolean;
  verifierAvailable: boolean;
  observationWindowAndMetricDefined: boolean;
}

export interface ReadinessRow { area: string; ok: boolean; detail: string }
export interface Readiness { ready: boolean; rows: ReadinessRow[]; blocking: string[] }

export function evaluateReadiness(i: ReadinessInput): Readiness {
  const rows: ReadinessRow[] = [
    { area: "Product identity", ok: i.productConfirmed, detail: i.productConfirmed ? "Profile confirmed" : "Confirm the product profile and claims" },
    { area: "Funnel", ok: i.funnelComplete, detail: i.funnelComplete ? "Signup, activation, paid and retention events mapped and observed" : `Gaps: ${i.funnelGaps.join(", ") || "funnel not defined"}` },
    { area: "Billing", ok: i.billingConnected, detail: i.billingConnected ? "Server-side billing source connected" : "Connect a billing source" },
    { area: "Analytics", ok: i.recentSignupEvents > 0, detail: i.recentSignupEvents > 0 ? `${i.recentSignupEvents} signup events in the last 7 days` : "No recent signup events received" },
    { area: "Policy", ok: i.policyConfigured, detail: i.policyConfigured ? "Policy saved" : "Review and save spend, outreach and approval rules" },
    { area: "Repository/CMS", ok: i.repoConnectedHealthy, detail: i.repoConnectedHealthy ? "Repository connected" : "Connect a repository with write scope to a branch" },
    { area: "OpenClaw", ok: i.runtimeHealthy, detail: i.runtimeHealthy ? "Isolated runtime healthy, model pinned" : "Runtime cell not healthy" },
    { area: "Verification", ok: i.verifierAvailable, detail: i.verifierAvailable ? "Postcondition checker available" : "No verifier for the intended mutation" },
    { area: "Measurement", ok: i.observationWindowAndMetricDefined, detail: i.observationWindowAndMetricDefined ? "Observation window and target metric defined" : "Define a target metric and observation window" },
  ];
  const blocking = rows.filter((r) => !r.ok).map((r) => r.area);
  return { ready: blocking.length === 0, rows, blocking };
}
