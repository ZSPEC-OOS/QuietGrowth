import { describe, expect, it } from "vitest";
import { cents, gapText, int, pct, statusTone, usd } from "./format";
import { topRowKpis, type DashboardData } from "./kpi";

const base: DashboardData = { funnel: { visitors: 100, signups: 10, activated: 5, paid: 2, retained: 1, rates: { visitorToSignup: 0.1, signupToActivation: 0.5, activationToPaid: 0.4, paidToRetained: 0.5 } }, completeness: { gaps: [], mayReportSubscribers: true }, instrumentationWarning: false, actionsByStatus: {}, awaitingApproval: 0, economics: { modelCostUsdMonth: 0, externalSpendUsdMonth: 0 } };

describe("format", () => {
  it("handles null/NaN safely", () => { expect(pct(null)).toBe("—"); expect(pct(NaN)).toBe("—"); expect(usd(undefined)).toBe("—"); expect(int(undefined)).toBe("—"); expect(cents(null)).toBe("—"); });
  it("formats values", () => { expect(pct(0.1234)).toBe("12.3%"); expect(usd(12.5)).toBe("$12.50"); expect(usd("1500")).toBe("$1,500"); expect(cents(2900)).toBe("$29.00"); expect(int(12345)).toBe("12,345"); });
  it("explains every known gap in plain language and falls back safely", () => { expect(gapText("billing_source_not_connected")).toContain("cannot be confirmed"); expect(gapText("x")).toBe("x"); });
  it("maps statuses to tones", () => { expect(statusTone("BLOCKED")).toBe("bad"); expect(statusTone("NEEDS_APPROVAL")).toBe("warn"); expect(statusTone("SUCCEEDED")).toBe("ok"); });
});
describe("topRowKpis", () => {
  it("labels customers as confirmed only with billing truth", () => {
    expect(topRowKpis(base)[1]!.label).toBe("Paid customers");
    const k = topRowKpis({ ...base, completeness: { gaps: ["billing_source_not_connected"], mayReportSubscribers: false } });
    expect(k[1]!.label).toBe("Paid events (client-reported)"); expect(k[0]!.label).toContain("unconfirmed");
  });
  it("renders placeholders when no funnel exists", () => { expect(topRowKpis({ ...base, funnel: null }).every((k) => k.value === "—")).toBe(true); });
});
