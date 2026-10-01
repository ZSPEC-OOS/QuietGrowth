import { PageHead } from "@/components/ui";
import { AnalyzeForm, FunnelForm } from "./forms";
import Link from "next/link";

const STEPS = ["Product link", "Funnel definition", "Constraints", "Connections", "Review"];
export default async function Onboarding({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const step = Math.min(5, Math.max(1, Number((await searchParams).step ?? 1) || 1));
  return (<>
    <PageHead title="Set up QuietGrowth" sub={`Step ${step} of 5: ${STEPS[step - 1]}`} />
    <div className="steps" aria-hidden>{STEPS.map((s, i) => <div key={s} className={`step ${i < step ? "on" : ""}`} />)}</div>
    {step === 1 && <AnalyzeForm />}
    {step === 2 && <FunnelForm />}
    {step === 3 && <div className="card"><p>Zero-Spend mode is on: <strong>$0 external spend</strong>, owned and free channels only. You can set a monthly model-cost cap and approval rules on the Autopilot screen.</p><Link className="btn primary" href="/onboarding?step=4">Continue</Link></div>}
    {step === 4 && <div className="card"><p>Add your DeepSeek key, billing, analytics, Search Console and repository on the Integrations screen. QuietGrowth marks conclusions as incomplete until they are connected.</p><Link className="btn primary" href="/integrations">Open integrations</Link> <Link className="btn" href="/onboarding?step=5">Skip for now</Link></div>}
    {step === 5 && <div className="card"><p>Autopilot will not write anything until the readiness checklist passes. Review the dashboard for instrumentation gaps.</p><Link className="btn primary" href="/dashboard">Go to dashboard</Link></div>}
  </>);
}
