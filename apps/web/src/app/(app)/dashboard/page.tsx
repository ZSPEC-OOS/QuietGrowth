import { api } from "@/lib/api";
import { gapText } from "@/lib/format";
import { economicsKpis, operationalKpis, topRowKpis, type DashboardData } from "@/lib/kpi";
import { Banner, Kpis, PageHead } from "@/components/ui";
import Link from "next/link";

export const dynamic = "force-dynamic";
export default async function Dashboard() {
  const d = await api<DashboardData>("/v1/dashboard");
  return (
    <>
      <PageHead title="Dashboard" sub="Subscriber outcomes first; diagnostics are secondary." />
      {d.instrumentationWarning && <Banner title="Conclusions are based on incomplete instrumentation" items={d.completeness ? d.completeness.gaps.map(gapText) : ["No funnel has been defined yet."]} />}
      <Kpis items={topRowKpis(d)} />
      <h2>Economics</h2><Kpis items={economicsKpis(d)} />
      <h2>Operations</h2><Kpis items={operationalKpis(d)} />
      {d.awaitingApproval > 0 && <p><Link className="btn primary" href="/actions?status=NEEDS_APPROVAL">Review {d.awaitingApproval} pending approval{d.awaitingApproval > 1 ? "s" : ""}</Link></p>}
    </>
  );
}
