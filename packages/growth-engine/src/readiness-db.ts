import type { PoolClient } from "pg";
import { evaluateCompleteness, evaluateReadiness, type FunnelDefinition, type Readiness } from "@quietgrowth/domain";

export interface ReadinessOptions {
  now: () => number;
  /** Self-hosted single-tenant mode has no tenant cell row; the owner attests the runtime instead. */
  runtimeAttested?: boolean;
  verifierAvailable: boolean;
}

/** Computes Appendix B readiness from tenant state. Must be called with a tenant-bound client. */
export async function loadReadiness(c: PoolClient, orgId: string, o: ReadinessOptions): Promise<Readiness> {
  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, [orgId, ...p])).rows;
  const profile = (await q("SELECT pp.status FROM products p JOIN LATERAL (SELECT status FROM product_profiles WHERE product_id=p.id ORDER BY version DESC LIMIT 1) pp ON true WHERE p.organization_id=$1 LIMIT 1"))[0];
  const fdef = (await q("SELECT definition FROM funnel_definitions WHERE organization_id=$1 AND active LIMIT 1"))[0]?.definition as (FunnelDefinition & { acquisitionObjective?: string }) | undefined;
  const observed = new Set<string>((await q("SELECT DISTINCT event FROM conversion_events WHERE organization_id=$1 AND occurred_at >= $2", [new Date(o.now() - 90 * 86_400_000)])).map((r) => r.event as string));
  const comp = fdef ? evaluateCompleteness({ ...fdef, billingSourceConnected: false }, observed) : null; // billing is judged by its own row
  const funnelGaps = comp ? comp.gaps.filter((g) => g !== "billing_source_not_connected") : [];
  const integ = new Map((await q("SELECT provider, status FROM integrations WHERE organization_id=$1")).map((r) => [r.provider as string, r.status as string]));
  const signups = fdef?.events.signup ? Number((await q("SELECT count(*)::int n FROM conversion_events WHERE organization_id=$1 AND event=$2 AND occurred_at >= $3", [fdef.events.signup, new Date(o.now() - 7 * 86_400_000)]))[0].n) : 0;
  const policies = Number((await q("SELECT count(*)::int n FROM policy_versions WHERE organization_id=$1"))[0].n);
  const cell = (await q("SELECT status FROM runtime_cells WHERE organization_id=$1"))[0];
  return evaluateReadiness({
    productConfirmed: profile?.status === "confirmed",
    funnelComplete: !!fdef && funnelGaps.length === 0, funnelGaps: fdef ? funnelGaps : ["funnel_not_defined"],
    billingConnected: integ.get("stripe") === "healthy",
    recentSignupEvents: signups,
    policyConfigured: policies > 0,
    repoConnectedHealthy: integ.get("github") === "healthy",
    runtimeHealthy: cell?.status === "running" || (!!o.runtimeAttested && !cell),
    verifierAvailable: o.verifierAvailable,
    observationWindowAndMetricDefined: !!fdef?.acquisitionObjective && (fdef?.retentionWindowDays ?? 0) > 0,
  });
}
