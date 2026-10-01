import { api } from "@/lib/api";
import { PageHead, Pill, Table } from "@/components/ui";
import { PolicyForm } from "./form";
type P = { policy: { version: string; mode: string; maxExternalSpendUsd: number; maxModelSpendUsd: number; limits: { maxActionsPerDay: number }; rules: Record<string, string> } };
export const dynamic = "force-dynamic";
const tone = (r: string) => (r === "deny" ? "bad" : r === "require_approval" ? "warn" : "ok") as "bad" | "warn" | "ok";
export default async function Autopilot() {
  const { policy } = await api<P>("/v1/autopilot/policy");
  return (<>
    <PageHead title="Autopilot" sub={`Mode: ${policy.mode.replace("_", "-")} · policy ${policy.version} · deterministic code enforces every rule below.`} />
    <PolicyForm maxModel={policy.maxModelSpendUsd} maxPerDay={policy.limits.maxActionsPerDay} />
    <h2>Rules</h2>
    <Table rows={Object.entries(policy.rules)} empty="No rules." cols={[{ h: "Action type", c: ([k]) => k.replace(/_/g, " ") }, { h: "Rule", c: ([, r]) => <Pill tone={tone(r)}>{r.replace(/_/g, " ")}</Pill> }]} />
  </>);
}
