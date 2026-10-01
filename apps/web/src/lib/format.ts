export const pct = (n: number | null | undefined, digits = 1): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(digits)}%`);
export const usd = (n: number | string | null | undefined): string => { const v = Number(n); return n === null || n === undefined || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v < 100 ? 2 : 0 }); };
export const int = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));
export const cents = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : usd(n / 100));

const GAP_TEXT: Record<string, string> = {
  signup_event_missing: "Signup event is not defined", activation_event_missing: "Activation event is not defined", paid_event_missing: "Paid-conversion event is not defined",
  retention_event_missing: "Retention event is not defined", retention_window_missing: "Retention window is not set", churn_event_missing: "Churn event is not defined",
  billing_source_not_connected: "Billing source is not connected, so paid customers cannot be confirmed",
  signup_event_not_observed: "Signup event has not been received yet", activation_event_not_observed: "Activation event has not been received yet", paid_event_not_observed: "Paid event has not been received yet",
};
export const gapText = (g: string): string => GAP_TEXT[g] ?? g;

export type Tone = "ok" | "warn" | "bad" | "info";
const STATUS_TONE: Record<string, Tone> = {
  AUTO_APPROVED: "ok", APPROVED: "ok", SUCCEEDED: "ok", EVALUATED: "ok", OBSERVING: "info", RUNNING: "info", QUEUED: "info", VERIFYING: "info",
  NEEDS_APPROVAL: "warn", PROPOSED: "info", POLICY_CHECK: "info", SCORED: "info", DISCOVERED: "info", BLOCKED: "bad", FAILED: "bad",
};
export const statusTone = (s: string): Tone => STATUS_TONE[s] ?? "info";
export const statusLabel = (s: string): string => s.toLowerCase().replace(/_/g, " ");
