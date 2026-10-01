// Funnel/cohort aggregation and attribution arithmetic, MR §6, §10.2, §19.1.
export interface FunnelEvent {
  subjectId: string; // resolved identity (user id when linked, else anonymous id)
  event: string;
  at: number; // epoch ms
  source?: string;
}

export interface FunnelEventMap { signup: string; activation: string; paid: string; retention?: string }

export interface FunnelCounts {
  visitors: number; signups: number; activated: number; paid: number; retained: number;
  rates: { visitorToSignup: number | null; signupToActivation: number | null; activationToPaid: number | null; paidToRetained: number | null };
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

/** Resolve anonymous ids to user ids via identity links (earliest link wins). */
export function resolveIdentity<T extends { anonymousId?: string; userId?: string }>(events: T[], links: ReadonlyMap<string, string>): string[] {
  return events.map((e) => (e.userId ?? (e.anonymousId ? links.get(e.anonymousId) ?? e.anonymousId : "")));
}

/**
 * Strictly sequential funnel: a subject counts at a stage only if they also reached all
 * earlier stages (so a stray `subscription_started` without signup cannot inflate counts).
 * `retained` = paid and a retention event at least `retentionDays` after paid.
 */
export function funnelCounts(events: FunnelEvent[], map: FunnelEventMap, retentionDays: number, visitorEvent = "landing_view"): FunnelCounts {
  const first = (name: string) => {
    const m = new Map<string, number>();
    for (const e of events) if (e.event === name && (!m.has(e.subjectId) || e.at < m.get(e.subjectId)!)) m.set(e.subjectId, e.at);
    return m;
  };
  const visitors = first(visitorEvent), signups = first(map.signup), act = first(map.activation), paid = first(map.paid);
  const retEvents = map.retention ? events.filter((e) => e.event === map.retention) : [];

  const signed = [...signups.keys()];
  const activated = signed.filter((s) => act.has(s));
  const payers = activated.filter((s) => paid.has(s));
  const windowMs = retentionDays * 86_400_000;
  const retained = payers.filter((s) => retEvents.some((e) => e.subjectId === s && e.at >= paid.get(s)! + windowMs));
  return {
    visitors: visitors.size, signups: signed.length, activated: activated.length, paid: payers.length, retained: retained.length,
    rates: {
      visitorToSignup: ratio(signed.length, visitors.size),
      signupToActivation: ratio(activated.length, signed.length),
      activationToPaid: ratio(payers.length, activated.length),
      paidToRetained: ratio(retained.length, payers.length),
    },
  };
}

export interface Cohort { key: string; subjects: string[] }

/** Weekly signup cohorts (ISO week start, UTC Monday). */
export function weeklySignupCohorts(events: FunnelEvent[], signupEvent: string): Cohort[] {
  const first = new Map<string, number>();
  for (const e of events) if (e.event === signupEvent && (!first.has(e.subjectId) || e.at < first.get(e.subjectId)!)) first.set(e.subjectId, e.at);
  const buckets = new Map<string, string[]>();
  for (const [s, at] of first) {
    const d = new Date(at);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    const key = monday.toISOString().slice(0, 10);
    buckets.set(key, [...(buckets.get(key) ?? []), s]);
  }
  return [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([key, subjects]) => ({ key, subjects }));
}

/** Share of a cohort that performed `event` within `days` of their signup. */
export function dayNActive(events: FunnelEvent[], cohort: Cohort, signupEvent: string, activeEvent: string, days: number): number | null {
  if (cohort.subjects.length === 0) return null;
  const signupAt = new Map<string, number>();
  for (const e of events) if (e.event === signupEvent && cohort.subjects.includes(e.subjectId) && !signupAt.has(e.subjectId)) signupAt.set(e.subjectId, e.at);
  const lo = (s: string) => signupAt.get(s)! + days * 86_400_000;
  const active = cohort.subjects.filter((s) => events.some((e) => e.subjectId === s && e.event === activeEvent && e.at >= lo(s)));
  return active.length / cohort.subjects.length;
}

// ---- attribution ----
export type AttributionModel = "first_touch" | "last_touch";
export interface Touch { subjectId: string; source: string; at: number }

/** Credit conversions to a source. Subjects without touches fall into "unattributed". */
export function attribute(conversions: { subjectId: string; at: number }[], touches: Touch[], model: AttributionModel): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of conversions) {
    const prior = touches.filter((t) => t.subjectId === c.subjectId && t.at <= c.at).sort((a, b) => a.at - b.at);
    const pick = model === "first_touch" ? prior[0] : prior[prior.length - 1];
    const k = pick?.source ?? "unattributed";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ---- unit economics ----
export interface Economics { cacUsd: number | null; paybackMonths: number | null; ltvToCac: number | null }

export function economics(args: { spendUsd: number; modelCostUsd: number; newPaying: number; monthlyGrossProfitPerCustomerUsd: number; expectedLifetimeMonths: number }): Economics {
  const { spendUsd, modelCostUsd, newPaying, monthlyGrossProfitPerCustomerUsd: gp, expectedLifetimeMonths: life } = args;
  if (newPaying <= 0) return { cacUsd: null, paybackMonths: null, ltvToCac: null };
  const cac = (spendUsd + modelCostUsd) / newPaying;
  return { cacUsd: cac, paybackMonths: gp > 0 ? cac / gp : null, ltvToCac: cac > 0 ? (gp * life) / cac : null };
}

/** MR §6.2: retained_customer_value = retained_revenue - refunds - variable_service_cost. */
export function retainedCustomerValue(retainedRevenue: number, refunds: number, variableServiceCost: number): number {
  return retainedRevenue - refunds - variableServiceCost;
}

/** Simple anomaly check: latest value more than `z` standard deviations below the trailing mean. */
export function dropAnomaly(series: number[], z = 2): { anomalous: boolean; zscore: number | null } {
  if (series.length < 4) return { anomalous: false, zscore: null };
  const hist = series.slice(0, -1), last = series[series.length - 1]!;
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length);
  if (sd === 0) return { anomalous: last < mean, zscore: null };
  const zs = (last - mean) / sd;
  return { anomalous: zs <= -z, zscore: zs };
}
