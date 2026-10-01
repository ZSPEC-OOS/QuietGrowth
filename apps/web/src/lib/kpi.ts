import { pct, int, usd } from "./format";

export interface DashboardData {
  funnel: { visitors: number; signups: number; activated: number; paid: number; retained: number; rates: { visitorToSignup: number | null; signupToActivation: number | null; activationToPaid: number | null; paidToRetained: number | null } } | null;
  completeness: { gaps: string[]; mayReportSubscribers: boolean } | null;
  instrumentationWarning: boolean;
  actionsByStatus: Record<string, number>;
  awaitingApproval: number;
  economics: { modelCostUsdMonth: number; externalSpendUsdMonth: number };
}
export interface Kpi { label: string; value: string; note?: string }

/** Top-row KPIs (MR §19.1). Paid/retained customers are never shown as "subscribers" without billing truth. */
export function topRowKpis(d: DashboardData): Kpi[] {
  const f = d.funnel;
  const billing = d.completeness?.mayReportSubscribers ?? false;
  return [
    { label: billing ? "Retained customers" : "Retained (unconfirmed)", value: f ? int(f.retained) : "—", note: billing ? undefined : "Billing source not connected" },
    { label: billing ? "Paid customers" : "Paid events (client-reported)", value: f ? int(f.paid) : "—", note: billing ? undefined : "Not confirmed by billing" },
    { label: "Activation rate", value: pct(f?.rates.signupToActivation) },
    { label: "Paid conversion", value: pct(f?.rates.activationToPaid) },
    { label: "Retention", value: pct(f?.rates.paidToRetained) },
  ];
}
export const economicsKpis = (d: DashboardData): Kpi[] => [
  { label: "Model cost (month)", value: usd(d.economics.modelCostUsdMonth) },
  { label: "External spend (month)", value: usd(d.economics.externalSpendUsdMonth) },
];
export const operationalKpis = (d: DashboardData): Kpi[] => [
  { label: "Awaiting approval", value: int(d.awaitingApproval) },
  { label: "Observing", value: int(d.actionsByStatus["OBSERVING"] ?? 0) },
  { label: "Failed", value: int(d.actionsByStatus["FAILED"] ?? 0) },
];
