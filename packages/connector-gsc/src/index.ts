import { withRetry, HealthGate, type HttpClient, type Health } from "@quietgrowth/connectors-core";

// Google Search Console, read-only (MR §12.1 P0, §10.1).
export interface GscRow { query?: string; page?: string; clicks: number; impressions: number; ctr: number; position: number }
export interface GscQuery { siteUrl: string; startDate: string; endDate: string; dimensions: ("query" | "page")[]; rowLimit?: number }

export class GscConnector {
  readonly provider = "google_search_console";
  readonly gate = new HealthGate();
  constructor(private readonly http: HttpClient, private readonly getToken: () => Promise<string>, private readonly sleep?: (ms: number) => Promise<void>) {}

  async test(siteUrl: string): Promise<Health> {
    const r = await withRetry(this.http, { method: "GET", url: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`, headers: { authorization: `Bearer ${await this.getToken()}` } }, this.gate, { sleep: this.sleep });
    if (r.status === 200) { this.gate.set({ status: "healthy" }); }
    else if (this.gate.current.status === "healthy") this.gate.set({ status: "degraded", detail: `status ${r.status}` });
    return this.gate.current;
  }

  async query(q: GscQuery): Promise<GscRow[]> {
    const r = await withRetry(this.http, {
      method: "POST", url: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(q.siteUrl)}/searchAnalytics/query`,
      headers: { authorization: `Bearer ${await this.getToken()}` },
      body: { startDate: q.startDate, endDate: q.endDate, dimensions: q.dimensions, rowLimit: q.rowLimit ?? 1000 },
    }, this.gate, { sleep: this.sleep });
    if (r.status !== 200) throw new Error(`gsc query failed: ${r.status}`);
    const rows = ((r.json as any)?.rows ?? []) as { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[];
    return rows.map((x) => ({
      query: q.dimensions.includes("query") ? x.keys[q.dimensions.indexOf("query")] : undefined,
      page: q.dimensions.includes("page") ? x.keys[q.dimensions.indexOf("page")] : undefined,
      clicks: x.clicks, impressions: x.impressions, ctr: x.ctr, position: x.position,
    }));
  }
}

export type SeoOpportunityKind = "low_ctr" | "near_page_one" | "no_clicks_high_impressions";
export interface SeoSignal { kind: SeoOpportunityKind; page?: string; query?: string; impressions: number; position: number; ctr: number; dedupeKey: string }

/** Deterministic opportunity detection (MR §10.1). Thresholds are explicit parameters. */
export function detectSeoOpportunities(rows: GscRow[], opt = { minImpressions: 100, lowCtr: 0.02 }): SeoSignal[] {
  const out: SeoSignal[] = [];
  for (const r of rows) {
    if (r.impressions < opt.minImpressions) continue;
    const id = `${r.page ?? ""}|${r.query ?? ""}`;
    const base = { page: r.page, query: r.query, impressions: r.impressions, position: r.position, ctr: r.ctr };
    if (r.position <= 10 && r.ctr < opt.lowCtr) out.push({ ...base, kind: "low_ctr", dedupeKey: `seo:low_ctr:${id}` });
    else if (r.position > 7 && r.position <= 20) out.push({ ...base, kind: "near_page_one", dedupeKey: `seo:near_page_one:${id}` });
    else if (r.clicks === 0 && r.position > 20) out.push({ ...base, kind: "no_clicks_high_impressions", dedupeKey: `seo:no_clicks:${id}` });
  }
  return out.sort((a, b) => b.impressions - a.impressions || a.dedupeKey.localeCompare(b.dedupeKey));
}
