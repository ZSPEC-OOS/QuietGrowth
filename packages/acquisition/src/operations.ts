import type { RepoRef, FilePatch } from "@quietgrowth/connector-cms";
import type { SeoSignal } from "@quietgrowth/connector-gsc";
import type { NewAction } from "@quietgrowth/growth-engine";
import { valueScore } from "@quietgrowth/domain";

// Bounded SEO operations (MR §10.1 step 4): one operation per action.
export type SeoOperation =
  | { op: "metadata"; path: string; title?: string; description?: string }
  | { op: "internal_link"; path: string; anchorText: string; targetPath: string }
  | { op: "faq_schema"; path: string; faqs: { q: string; a: string }[] }
  | { op: "new_intent_page"; path: string; markdown: string };

export interface SeoPayload { repo: RepoRef; operation: SeoOperation; targetUrl: string; marker: string }

/** Maps an operation to the policy action type (policy decides allow/approve/deny, never the agent). */
export function policyTypeFor(op: SeoOperation): NewAction["type"] {
  switch (op.op) {
    case "metadata": return "metadata_change";
    case "internal_link": return "internal_link_change";
    case "faq_schema": return "content_refresh";
    case "new_intent_page": return "new_intent_page";
  }
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Pure patch builder over existing file content. Returns the new file content. */
export function applyOperation(op: SeoOperation, current: string | null, marker: string): string {
  switch (op.op) {
    case "metadata": {
      if (current === null) throw new Error("metadata change requires an existing file");
      let out = current;
      if (op.title !== undefined) out = /<title>[\s\S]*?<\/title>/i.test(out) ? out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${op.title.replace(/</g, "&lt;")}</title>`) : out.replace(/<head>/i, `<head><title>${op.title.replace(/</g, "&lt;")}</title>`);
      if (op.description !== undefined) {
        const tag = `<meta name="description" content="${escapeAttr(op.description)}">`;
        out = /<meta[^>]+name=["']description["'][^>]*>/i.test(out) ? out.replace(/<meta[^>]+name=["']description["'][^>]*>/i, tag) : out.replace(/<\/title>/i, `</title>${tag}`);
      }
      return out.includes(marker) ? out : out.replace(/<\/body>/i, `<!-- ${marker} --></body>`);
    }
    case "internal_link": {
      if (current === null) throw new Error("internal link requires an existing file");
      const i = current.indexOf(op.anchorText);
      if (i < 0 || /<a\b[^>]*>[^<]*$/i.test(current.slice(0, i))) throw new Error("anchor text not found or already linked");
      return current.slice(0, i) + `<a href="${escapeAttr(op.targetPath)}">${op.anchorText}</a>` + current.slice(i + op.anchorText.length) + (current.includes(marker) ? "" : `<!-- ${marker} -->`);
    }
    case "faq_schema": {
      const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: op.faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) }).replace(/</g, "\\u003c");
      if (current === null) throw new Error("faq schema requires an existing file");
      return current.replace(/<\/head>/i, `<script type="application/ld+json">${ld}</script></head>`) + (current.includes(marker) ? "" : `<!-- ${marker} -->`);
    }
    case "new_intent_page":
      if (current !== null) throw new Error("page already exists; use a refresh operation");
      return `${op.markdown}\n\n<!-- ${marker} -->\n`;
  }
}

export function patchFor(op: SeoOperation, current: string | null, marker: string): FilePatch {
  return { path: op.path, content: applyOperation(op, current, marker), message: `QuietGrowth: ${op.op} on ${op.path}` };
}

/** Maps a detected signal to a ranked candidate (inspectable score per MR §8.3). */
export function candidateFromSignal(s: SeoSignal, orgId: string, funnelStage = "acquisition"): { dedupeKey: string; funnelStage: string; score: number; kind: string; evidence: unknown } {
  const impactBase = Math.min(1, s.impressions / 5000);
  const impact = s.kind === "low_ctr" ? impactBase * 0.6 : s.kind === "near_page_one" ? impactBase * 0.8 : impactBase * 0.3;
  const score = valueScore({
    expectedIncrementalImpact: impact, confidence: s.kind === "no_clicks_high_impressions" ? 0.3 : 0.6,
    ease: s.kind === "low_ctr" ? 0.9 : 0.6, timeToSignal: 0.5, reversibility: 0.9, strategicFit: 0.7, evidenceQualityCap: 0.8,
  });
  return { dedupeKey: s.dedupeKey, funnelStage, score, kind: s.kind, evidence: { orgId, ...s } };
}
