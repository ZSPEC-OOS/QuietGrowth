import { api } from "@/lib/api";
import { PageHead, Pill, Table } from "@/components/ui";

type O = { id: string; domain: string; funnel_stage: string | null; kind: string; score: string | null; status: string; evidence_json: Record<string, unknown> };
export const dynamic = "force-dynamic";
export default async function Opportunities() {
  const { opportunities } = await api<{ opportunities: O[] }>("/v1/opportunities");
  return (
    <>
      <PageHead title="Opportunities" sub="Evidence-backed, ranked by inspectable value score. Risk is a policy gate, not part of the score." />
      <Table rows={opportunities} empty="No opportunities yet. Connect Search Console and product events." cols={[
        { h: "Opportunity", c: (o) => o.kind.replace(/_/g, " ") }, { h: "Domain", c: (o) => o.domain }, { h: "Funnel stage", c: (o) => o.funnel_stage ?? "—" },
        { h: "Score", c: (o) => (o.score === null ? "—" : Number(o.score).toFixed(2)) }, { h: "Status", c: (o) => <Pill tone="info">{o.status}</Pill> },
        { h: "Evidence", c: (o) => <code>{JSON.stringify(o.evidence_json).slice(0, 90)}</code> },
      ]} />
    </>
  );
}
