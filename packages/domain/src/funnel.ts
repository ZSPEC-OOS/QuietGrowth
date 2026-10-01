// Funnel definition + instrumentation completeness, MR §3.3, §6, Appendix B.
export type FunnelStageKey = "signup" | "activation" | "paid" | "retention" | "churn";

export interface FunnelDefinition {
  /** Event name mapped to each stage; absent = not defined. */
  events: Partial<Record<FunnelStageKey, string>>;
  /** Retention window in days (e.g. 30), absent = not defined. */
  retentionWindowDays?: number;
  /** True when paid events come from a server-side billing source. */
  billingSourceConnected: boolean;
}

export type Gap =
  | "signup_event_missing"
  | "activation_event_missing"
  | "paid_event_missing"
  | "retention_event_missing"
  | "retention_window_missing"
  | "churn_event_missing"
  | "billing_source_not_connected"
  | "signup_event_not_observed"
  | "activation_event_not_observed"
  | "paid_event_not_observed";

export interface Completeness {
  gaps: Gap[];
  /** All evidence needed to report funnel conversion rates. */
  funnelReliable: boolean;
  /** May the system report "subscribers"/"paid customers"? Requires billing truth. */
  mayReportSubscribers: boolean;
  /** May Autopilot write? (Appendix B funnel + billing rows). */
  autopilotWritesReady: boolean;
}

/**
 * `observedEvents` are event names seen in recent ingestion. A mapped event
 * never observed is a gap: a mapping alone is not instrumentation.
 */
export function evaluateCompleteness(def: FunnelDefinition, observedEvents: ReadonlySet<string>): Completeness {
  const gaps: Gap[] = [];
  const e = def.events;
  if (!e.signup) gaps.push("signup_event_missing");
  else if (!observedEvents.has(e.signup)) gaps.push("signup_event_not_observed");
  if (!e.activation) gaps.push("activation_event_missing");
  else if (!observedEvents.has(e.activation)) gaps.push("activation_event_not_observed");
  if (!e.paid) gaps.push("paid_event_missing");
  else if (!def.billingSourceConnected && !observedEvents.has(e.paid)) gaps.push("paid_event_not_observed");
  if (!e.retention) gaps.push("retention_event_missing");
  if (def.retentionWindowDays === undefined || def.retentionWindowDays <= 0) gaps.push("retention_window_missing");
  if (!e.churn) gaps.push("churn_event_missing");
  if (!def.billingSourceConnected) gaps.push("billing_source_not_connected");

  const has = (g: Gap) => gaps.includes(g);
  const funnelGaps: Gap[] = ["signup_event_missing","signup_event_not_observed","activation_event_missing","activation_event_not_observed","paid_event_missing","paid_event_not_observed"];
  return {
    gaps,
    funnelReliable: !funnelGaps.some(has),
    mayReportSubscribers: def.billingSourceConnected && !has("paid_event_missing"),
    autopilotWritesReady: gaps.length === 0,
  };
}
