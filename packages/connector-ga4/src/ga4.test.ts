import { describe, expect, it } from "vitest";
import { Ga4Connector, toMetricPoints } from "./index.js";

const report = { rows: [{ dimensionValues: [{ value: "organic" }], metricValues: [{ value: "120" }, { value: "7" }] }] };
describe("Ga4Connector", () => {
  it("maps dimensions/metrics and flattens to metric points", async () => {
    const c = new Ga4Connector(async () => ({ status: 200, headers: {}, json: report, text: "" }), async () => "t");
    const rows = await c.runReport("123", { startDate: "a", endDate: "b", dimensions: ["sessionDefaultChannelGroup"], metrics: ["sessions", "conversions"] });
    expect(rows[0]).toEqual({ dimensions: { sessionDefaultChannelGroup: "organic" }, metrics: { sessions: 120, conversions: 7 } });
    expect(toMetricPoints(rows, new Date(0))).toHaveLength(2);
  });
  it("rejects non-numeric property ids (no URL injection) and surfaces failures", async () => {
    const c = new Ga4Connector(async () => ({ status: 500, headers: {}, json: null, text: "" }), async () => "t", async () => {});
    await expect(c.runReport("1/../2", { startDate: "a", endDate: "b", dimensions: [], metrics: [] })).rejects.toThrow("invalid");
    await expect(c.runReport("1", { startDate: "a", endDate: "b", dimensions: [], metrics: [] })).rejects.toThrow("500");
  });
});
