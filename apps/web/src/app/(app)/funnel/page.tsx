import { api } from "@/lib/api";
import { gapText, int, pct } from "@/lib/format";
import { Banner, PageHead } from "@/components/ui";

type F = { counts: { visitors: number; signups: number; activated: number; paid: number; retained: number; rates: Record<string, number | null> } | null; completeness: { gaps: string[] } | null; subscribersReportable: boolean };
export const dynamic = "force-dynamic";
export default async function FunnelPage() {
  const f = await api<F>("/v1/funnel");
  const c = f.counts;
  const stages = c ? [["Visitors", c.visitors, null], ["Signups", c.signups, c.rates.visitorToSignup], ["Activated", c.activated, c.rates.signupToActivation], [f.subscribersReportable ? "Paid customers" : "Paid (client-reported)", c.paid, c.rates.activationToPaid], ["Retained", c.retained, c.rates.paidToRetained]] as const : [];
  const max = Math.max(1, ...stages.map((s) => s[1]));
  return (
    <>
      <PageHead title="Funnel" sub="visitor → signup → activated → paid → retained" />
      {f.completeness && f.completeness.gaps.length > 0 && <Banner title="Instrumentation gaps" items={f.completeness.gaps.map(gapText)} />}
      {!c ? <div className="card empty">Define your funnel events to see conversion.</div> : (
        <div className="funnel" role="list">{stages.map(([l, n, r]) => (<div key={l} role="listitem"><div className="row"><strong style={{ width: 190 }}>{l}</strong><div className="bar" style={{ width: `${Math.max(4, (n / max) * 100)}%` }}>{int(n)}</div><span>{r === null ? "" : pct(r)}</span></div></div>))}</div>
      )}
    </>
  );
}
