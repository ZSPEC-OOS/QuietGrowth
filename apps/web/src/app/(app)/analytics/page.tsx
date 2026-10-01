import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import { PageHead, Table } from "@/components/ui";
import { economicsKpis, type DashboardData } from "@/lib/kpi";
import { Kpis } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function Analytics() {
  const [d, c] = await Promise.all([api<DashboardData>("/v1/dashboard"), api<{ months: { month: string; costUsd: number; tokens: number }[] }>("/v1/model-cost")]);
  return (<>
    <PageHead title="Analytics" sub="Economics and model-cost ledger. Channel proxies are diagnostics only." />
    <Kpis items={economicsKpis(d)} />
    <h2>Model cost by month</h2>
    <Table rows={c.months} empty="No model usage recorded." cols={[{ h: "Month", c: (m) => m.month }, { h: "Cost", c: (m) => usd(m.costUsd) }, { h: "Tokens", c: (m) => m.tokens.toLocaleString("en-US") }]} />
  </>);
}
