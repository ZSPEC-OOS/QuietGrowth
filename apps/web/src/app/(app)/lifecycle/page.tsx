import { api } from "@/lib/api";
import { PageHead, Status, Table } from "@/components/ui";
type A = { id: string; domain: string; type: string; rationale: string; status: string };
export const dynamic = "force-dynamic";
export default async function Lifecycle() {
  const { actions } = await api<{ actions: A[] }>("/v1/actions?limit=200");
  const l = actions.filter((a) => /email|outreach/.test(a.type) || ["activation", "retention"].includes(a.domain));
  return (<>
    <PageHead title="Lifecycle" sub="Activation, upgrade, retention and win-back messaging. Segments are rule-based; sends honour suppression and frequency caps." />
    <Table rows={l} empty="No lifecycle actions yet." cols={[{ h: "Action", c: (a) => a.type.replace(/_/g, " ") }, { h: "Why", c: (a) => a.rationale }, { h: "Status", c: (a) => <Status s={a.status} /> }]} />
  </>);
}
