import { api } from "@/lib/api";
import { gapText } from "@/lib/format";
import { Banner, PageHead } from "@/components/ui";
type P = { product: { name: string; primary_url: string; mode: string; profile: { description?: string; ctas?: string[]; pricingMentions?: string[]; category?: string } | null; profile_status: string | null } | null; completeness: { gaps: string[] } | null };
export const dynamic = "force-dynamic";
export default async function Product() {
  const p = await api<P>("/v1/product");
  if (!p.product) return (<><PageHead title="Product profile" /><div className="card">No product yet. <a href="/onboarding"><u>Start onboarding</u></a>.</div></>);
  const pr = p.product.profile;
  return (<>
    <PageHead title={p.product.name} sub={p.product.primary_url} />
    {p.product.profile_status === "draft" && <Banner title="Draft profile inferred from your site; review before Autopilot writes." items={["Claims, plans and segments must be confirmed by you."]} />}
    {p.completeness && p.completeness.gaps.length > 0 && <Banner title="Funnel instrumentation" items={p.completeness.gaps.map(gapText)} />}
    <div className="card"><p>{pr?.description ?? "No description found."}</p><p><strong>Category:</strong> {pr?.category ?? "unknown"}</p><p><strong>CTAs:</strong> {(pr?.ctas ?? []).join(", ") || "—"}</p><p><strong>Pricing mentions:</strong> {(pr?.pricingMentions ?? []).join(", ") || "—"}</p></div>
  </>);
}
