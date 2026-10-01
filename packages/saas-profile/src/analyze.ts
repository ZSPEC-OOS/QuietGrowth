// Deterministic first-pass product analysis (MR §3.2); the model refines this later.
export interface DraftProfile {
  name: string | null;
  description: string | null;
  headings: string[];
  ctas: string[];
  pricingMentions: string[];
  hasFreeTrial: boolean;
  hasFreemium: boolean;
  signupPath: string | null;
  category: "b2b" | "b2c" | "unknown";
  evidence: { field: string; snippet: string }[];
}

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const all = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => m[1] ?? "");

export function analyzeHtml(html: string): DraftProfile {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const title = strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "") || null;
  const description = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(body)?.[1]?.trim() || null;
  const headings = all(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi, body).map(strip).filter(Boolean).slice(0, 10);
  const links = [...body.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1]!, text: strip(m[2] ?? "") }));
  const ctaRe = /(sign\s?up|get started|start (free|your)|try (it )?(free|now)|book a demo|request a demo|create (an )?account)/i;
  const ctaLinks = links.filter((l) => ctaRe.test(l.text));
  const text = strip(body);
  const pricingMentions = [...new Set(text.match(/(\$|€|£)\s?\d+(?:[.,]\d+)?(?:\s?\/\s?(?:mo|month|yr|year|user|seat))?/gi) ?? [])].slice(0, 10);
  const b2b = /\b(teams?|enterprise|sso|workspace|admin|api|integrations?|crm|b2b)\b/i.test(text);
  const b2c = /\b(personal|family|students?|hobby|consumers?)\b/i.test(text);

  const evidence: DraftProfile["evidence"] = [];
  if (title) evidence.push({ field: "name", snippet: title });
  if (description) evidence.push({ field: "description", snippet: description });
  for (const c of ctaLinks.slice(0, 3)) evidence.push({ field: "cta", snippet: c.text });
  for (const p of pricingMentions.slice(0, 3)) evidence.push({ field: "pricing", snippet: p });

  return {
    name: title ? title.split(/[|\-–—:]/)[0]!.trim() || title : null,
    description,
    headings,
    ctas: [...new Set(ctaLinks.map((l) => l.text))].slice(0, 5),
    pricingMentions,
    hasFreeTrial: /free trial|start (your )?free|14[- ]day/i.test(text),
    hasFreemium: /free (plan|forever|tier)|freemium/i.test(text),
    signupPath: ctaLinks[0]?.href ?? null,
    category: b2b && !b2c ? "b2b" : b2c && !b2b ? "b2c" : "unknown",
    evidence,
  };
}
