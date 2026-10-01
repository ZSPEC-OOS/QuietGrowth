import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import { PageHead, Status, Table } from "@/components/ui";
import { decide } from "./actions";
import Link from "next/link";

type A = { id: string; domain: string; type: string; target_metric: string; rationale: string; status: string; estimated_external_cost_usd: string; estimated_model_cost_usd: string; created_at: string };
export const dynamic = "force-dynamic";
export default async function Actions({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const { actions } = await api<{ actions: A[] }>(`/v1/actions${status && /^[A-Z_]+$/.test(status) ? `?status=${status}` : ""}`);
  return (
    <>
      <PageHead title="Actions" sub="Approval inbox, execution history, verification and rollback." />
      <div className="row" style={{ marginBottom: 12 }}><Link className="btn" href="/actions">All</Link><Link className="btn" href="/actions?status=NEEDS_APPROVAL">Needs approval</Link><Link className="btn" href="/actions?status=FAILED">Failed</Link></div>
      <Table rows={actions} empty="No actions." cols={[
        { h: "Action", c: (a) => <><strong>{a.type.replace(/_/g, " ")}</strong><div className="sub">{a.rationale}</div></> },
        { h: "Target", c: (a) => a.target_metric }, { h: "Cost", c: (a) => `${usd(a.estimated_external_cost_usd)} ext · ${usd(a.estimated_model_cost_usd)} model` },
        { h: "Status", c: (a) => <Status s={a.status} /> },
        { h: "", c: (a) => (
          <div className="row">
            <Link className="btn" href={`/actions/${a.id}`}>Details</Link>
            {a.status === "NEEDS_APPROVAL" && (<>
              <form action={decide}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="op" value="approve" /><button className="primary">Approve</button></form>
              <form action={decide}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="op" value="reject" /><button>Reject</button></form>
            </>)}
          </div>) },
      ]} />
    </>
  );
}
