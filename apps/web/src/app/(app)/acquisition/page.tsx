import { api } from "@/lib/api";
import { PageHead, Status, Table } from "@/components/ui";
type A = { id: string; domain: string; type: string; rationale: string; status: string };
type O = { id: string; domain: string; kind: string; score: string | null };
export const dynamic = "force-dynamic";
export default async function Acquisition() {
  const [{ actions }, { opportunities }] = await Promise.all([api<{ actions: A[] }>("/v1/actions?limit=200"), api<{ opportunities: O[] }>("/v1/opportunities")]);
  const acq = actions.filter((a) => a.domain === "acquisition");
  return (<>
    <PageHead title="Acquisition" sub="SEO, intent pages, directories, referrals and partnerships (owned and free channels)." />
    <h2>Open opportunities</h2>
    <Table rows={opportunities.filter((o) => o.domain === "acquisition")} empty="None detected yet." cols={[{ h: "Opportunity", c: (o) => o.kind.replace(/_/g, " ") }, { h: "Score", c: (o) => (o.score === null ? "—" : Number(o.score).toFixed(2)) }]} />
    <h2>Actions</h2>
    <Table rows={acq} empty="No acquisition actions." cols={[{ h: "Action", c: (a) => a.type.replace(/_/g, " ") }, { h: "Why", c: (a) => a.rationale }, { h: "Status", c: (a) => <Status s={a.status} /> }]} />
  </>);
}
