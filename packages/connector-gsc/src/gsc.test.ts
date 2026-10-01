import { describe, expect, it } from "vitest";
import type { HttpRequest } from "@quietgrowth/connectors-core";
import { GscConnector, detectSeoOpportunities, type GscRow } from "./index.js";

const rows = { rows: [{ keys: ["best crm", "https://x.com/crm"], clicks: 3, impressions: 900, ctr: 0.003, position: 4.2 }, { keys: ["crm tool", "https://x.com/tool"], clicks: 10, impressions: 500, ctr: 0.02, position: 12 }] };

describe("GscConnector", () => {
  it("queries with bearer token and maps dimensions", async () => {
    let seen: HttpRequest | undefined;
    const c = new GscConnector(async (r) => { seen = r; return { status: 200, headers: {}, json: rows, text: "" }; }, async () => "tok");
    const out = await c.query({ siteUrl: "https://x.com/", startDate: "2026-09-01", endDate: "2026-09-28", dimensions: ["query", "page"] });
    expect(seen!.headers!.authorization).toBe("Bearer tok");
    expect(out[0]).toMatchObject({ query: "best crm", page: "https://x.com/crm", impressions: 900 });
  });
  it("401 degrades the connector and surfaces an error", async () => {
    const c = new GscConnector(async () => ({ status: 401, headers: {}, json: null, text: "" }), async () => "tok");
    await expect(c.query({ siteUrl: "s", startDate: "a", endDate: "b", dimensions: ["page"] })).rejects.toThrow("401");
    expect(c.gate.current.status).toBe("degraded");
  });
});

describe("detectSeoOpportunities", () => {
  const data: GscRow[] = [
    { query: "a", page: "p1", clicks: 1, impressions: 1000, ctr: 0.001, position: 3 },
    { query: "b", page: "p2", clicks: 20, impressions: 400, ctr: 0.05, position: 12 },
    { query: "c", page: "p3", clicks: 0, impressions: 300, ctr: 0, position: 40 },
    { query: "d", page: "p4", clicks: 0, impressions: 10, ctr: 0, position: 3 },
    { query: "e", page: "p5", clicks: 50, impressions: 800, ctr: 0.06, position: 2 },
  ];
  it("flags low CTR, near-page-one, buried pages; ignores low volume and healthy rows; stable ordering", () => {
    const s = detectSeoOpportunities(data);
    expect(s.map((x) => x.kind)).toEqual(["low_ctr", "near_page_one", "no_clicks_high_impressions"]);
    expect(detectSeoOpportunities([...data].reverse())).toEqual(s);
    expect(new Set(s.map((x) => x.dedupeKey)).size).toBe(3);
  });
});
