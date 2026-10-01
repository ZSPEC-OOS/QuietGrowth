import { api } from "@/lib/api";
import { PageHead, Pill, Table } from "@/components/ui";
import { ConnectForm } from "./form";
type I = { provider: string; status: string; scopes: string[]; last_sync_at: string | null };
export const dynamic = "force-dynamic";
export default async function Integrations() {
  const { integrations } = await api<{ integrations: I[] }>("/v1/integrations");
  return (<>
    <PageHead title="Integrations" sub="Health, scopes and sync state. A degraded connector stops writes until you reconnect." />
    <Table rows={integrations} empty="Nothing connected yet." cols={[{ h: "Provider", c: (i) => i.provider }, { h: "Status", c: (i) => <Pill tone={i.status === "healthy" ? "ok" : i.status === "degraded" ? "warn" : "bad"}>{i.status}</Pill> }, { h: "Scopes", c: (i) => i.scopes.join(", ") || "—" }, { h: "Last sync", c: (i) => (i.last_sync_at ? new Date(i.last_sync_at).toLocaleString() : "never") }]} />
    <h2>Connect</h2><ConnectForm />
  </>);
}
