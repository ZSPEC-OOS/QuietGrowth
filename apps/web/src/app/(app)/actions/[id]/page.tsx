import { api } from "@/lib/api";
import { PageHead, Status, Table } from "@/components/ui";

type D = { action: { id: string; type: string; rationale: string; status: string; evidence_json: unknown }; receipts: { provider: string; resource_id: string }[]; verifications: { status: string; receipt: { checks?: { name: string; ok: boolean }[] } | null }[]; audit: { actor: string; event: string; at: string }[] };
export const dynamic = "force-dynamic";
export default async function ActionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await api<D>(`/v1/actions/${encodeURIComponent(id)}`);
  return (
    <>
      <PageHead title={d.action.type.replace(/_/g, " ")} sub={d.action.rationale} />
      <p><Status s={d.action.status} /></p>
      <h2>Receipts</h2><Table rows={d.receipts} empty="No external changes recorded." cols={[{ h: "Provider", c: (r) => r.provider }, { h: "Resource", c: (r) => r.resource_id }]} />
      <h2>Independent verification</h2>
      <Table rows={d.verifications.flatMap((v) => v.receipt?.checks ?? [])} empty="Not verified yet." cols={[{ h: "Check", c: (c) => c.name }, { h: "Result", c: (c) => (c.ok ? "pass" : "FAIL") }]} />
      <h2>Audit trail</h2>
      <Table rows={d.audit} empty="No events." cols={[{ h: "When", c: (a) => new Date(a.at).toLocaleString() }, { h: "Actor", c: (a) => a.actor }, { h: "Event", c: (a) => a.event }]} />
    </>
  );
}
