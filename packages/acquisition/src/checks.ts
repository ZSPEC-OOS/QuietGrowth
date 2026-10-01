// Pre-publish checks, MR §10.1 step 5 / M4.5: factual, duplication, link, competitor-claim.
export interface Check { name: string; ok: boolean; detail?: string }
export interface KnowledgeItem { kind: "claim" | "pricing" | "prohibited_claim" | "competitor"; content: string }

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const shingles = (s: string, k = 4): Set<string> => { const w = words(s), out = new Set<string>(); for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" ")); return out; };

/** Jaccard similarity over word 4-shingles. */
export function similarity(a: string, b: string): number {
  const A = shingles(a), B = shingles(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Numbers/prices in new copy must appear in the verified knowledge base (no invented figures). */
export function checkClaims(text: string, knowledge: KnowledgeItem[]): Check[] {
  const checks: Check[] = [];
  const known = knowledge.filter((k) => k.kind === "claim" || k.kind === "pricing").map((k) => k.content).join(" ");
  const figures = text.match(/(?:\$|€|£)\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:%|x|users|customers|teams)\b/gi) ?? [];
  const unverified = figures.filter((f) => !known.includes(f.trim()));
  checks.push({ name: "figures_verified", ok: unverified.length === 0, detail: unverified.join(", ") || undefined });
  const prohibited = knowledge.filter((k) => k.kind === "prohibited_claim").map((k) => k.content.toLowerCase()).filter((p) => text.toLowerCase().includes(p));
  checks.push({ name: "no_prohibited_claims", ok: prohibited.length === 0, detail: prohibited.join(", ") || undefined });
  // Deceptive comparative language about named competitors (MR §1.3).
  const competitors = knowledge.filter((k) => k.kind === "competitor").map((k) => k.content);
  const bad = competitors.filter((c) => new RegExp(`${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^.]{0,80}(scam|fraud|worst|terrible|stole|illegal|lawsuit)`, "i").test(text));
  checks.push({ name: "no_deceptive_competitor_claims", ok: bad.length === 0, detail: bad.join(", ") || undefined });
  return checks;
}

export function checkDuplication(text: string, existing: string[], threshold = 0.6): Check {
  const worst = existing.reduce((m, e) => Math.max(m, similarity(text, e)), 0);
  return { name: "not_duplicate", ok: worst < threshold, detail: `max similarity ${worst.toFixed(2)}` };
}

export function checkLinks(text: string, allowedHosts: string[]): Check[] {
  const urls = [...text.matchAll(/\bhttps?:\/\/[^\s)"'<>]+/gi)].map((m) => m[0]);
  const hrefs = [...text.matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1]!); // internal markdown links are fine
  const offHost = urls.filter((u) => { try { return !allowedHosts.includes(new URL(u).hostname); } catch { return true; } });
  return [
    { name: "links_on_allowed_hosts", ok: offHost.length === 0, detail: offHost.join(", ") || undefined },
    { name: "no_spammy_backlinks", ok: offHost.length <= 3, detail: `${offHost.length} external links` },
    { name: "internal_links_wellformed", ok: hrefs.every((h) => !h.includes("..") && !h.includes("//")) },
  ];
}

export interface PrepublishInput { text: string; knowledge: KnowledgeItem[]; existingPages: string[]; allowedHosts: string[] }
export function prepublishChecks(i: PrepublishInput): { ok: boolean; checks: Check[] } {
  const checks = [...checkClaims(i.text, i.knowledge), checkDuplication(i.text, i.existingPages), ...checkLinks(i.text, i.allowedHosts)];
  return { ok: checks.every((c) => c.ok), checks };
}
