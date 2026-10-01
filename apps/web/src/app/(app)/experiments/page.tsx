import { api } from "@/lib/api";
import { PageHead, Pill, Table } from "@/components/ui";
type E = { id: string; hypothesis: string; status: string; decision: string | null };
export const dynamic = "force-dynamic";
export default async function Experiments() {
  const { experiments } = await api<{ experiments: E[] }>("/v1/experiments");
  return (<>
    <PageHead title="Experiments" sub="Hypotheses, observation windows and results. Winners are proposals; pricing and entitlement changes always need approval." />
    <Table rows={experiments} empty="No experiments yet." cols={[{ h: "Hypothesis", c: (e) => e.hypothesis }, { h: "Status", c: (e) => <Pill tone="info">{e.status}</Pill> }, { h: "Decision", c: (e) => e.decision ?? "—" }]} />
  </>);
}
