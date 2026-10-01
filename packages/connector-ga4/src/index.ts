import { withRetry, HealthGate, type HttpClient } from "@quietgrowth/connectors-core";

// Google Analytics 4 Data API, read-only (MR §12.1 P0).
export interface Ga4Row { dimensions: Record<string, string>; metrics: Record<string, number> }

export class Ga4Connector {
  readonly provider = "google_analytics_4";
  readonly gate = new HealthGate();
  constructor(private readonly http: HttpClient, private readonly getToken: () => Promise<string>, private readonly sleep?: (ms: number) => Promise<void>) {}

  async runReport(propertyId: string, a: { startDate: string; endDate: string; dimensions: string[]; metrics: string[]; limit?: number }): Promise<Ga4Row[]> {
    if (!/^\d+$/.test(propertyId)) throw new Error("invalid GA4 property id");
    const r = await withRetry(this.http, {
      method: "POST", url: `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      headers: { authorization: `Bearer ${await this.getToken()}` },
      body: { dateRanges: [{ startDate: a.startDate, endDate: a.endDate }], dimensions: a.dimensions.map((name) => ({ name })), metrics: a.metrics.map((name) => ({ name })), limit: a.limit ?? 10000 },
    }, this.gate, { sleep: this.sleep });
    if (r.status !== 200) throw new Error(`ga4 report failed: ${r.status}`);
    const j = r.json as { rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] };
    return (j.rows ?? []).map((row) => ({
      dimensions: Object.fromEntries(a.dimensions.map((d, i) => [d, row.dimensionValues[i]?.value ?? ""])),
      metrics: Object.fromEntries(a.metrics.map((m, i) => [m, Number(row.metricValues[i]?.value ?? 0)])),
    }));
  }
}

/** Flattens report rows to metric_points shaped records. */
export function toMetricPoints(rows: Ga4Row[], at: Date, source = "ga4") {
  return rows.flatMap((r) => Object.entries(r.metrics).map(([metric, value]) => ({ source, metric, dimension: r.dimensions, at, value })));
}
