import { describe, expect, it } from "vitest";
import { sha256, verifyAdChange, verifyExperimentLive, verifyLifecycleSend, verifyPricingProposal, verifyPublishedPage, type Fetcher } from "./index.js";

const html = `<html><head><link rel="canonical" href="https://x.com/p"><script>gtag('G-1')</script></head><body>QG-MARKER-1</body></html>`;
const good: Fetcher = async (u) => (u.endsWith("sitemap.xml") ? { status: 200, headers: {}, body: "<loc>https://x.com/p</loc>" } : { status: 200, headers: {}, body: html });
const post = { url: "https://x.com/p", expectedMarker: "QG-MARKER-1", expectedHash: sha256(html), canonical: "https://x.com/p", analyticsTag: "G-1", sitemapUrl: "https://x.com/sitemap.xml" };

describe("verifyPublishedPage", () => {
  it("passes when all postconditions hold", async () => {
    const v = await verifyPublishedPage(post, good);
    expect(v.ok).toBe(true);
    expect(v.checks.length).toBe(7);
  });
  it.each([
    ["404", async () => ({ status: 404, headers: {}, body: html }), "http_200"],
    ["missing marker", async (u: string) => ({ status: 200, headers: {}, body: u.endsWith("sitemap.xml") ? "<loc>https://x.com/p</loc>" : "<html></html>" }), "marker_present"],
    ["noindex meta", async (u: string) => ({ status: 200, headers: {}, body: u.endsWith("sitemap.xml") ? "<loc>https://x.com/p</loc>" : html + `<meta name="robots" content="noindex">` }), "indexable"],
    ["noindex header", async (u: string) => ({ status: 200, headers: u.endsWith("sitemap.xml") ? {} : { "x-robots-tag": "noindex" }, body: u.endsWith("sitemap.xml") ? "<loc>https://x.com/p</loc>" : html }), "indexable"],
    ["not in sitemap", async (u: string) => ({ status: 200, headers: {}, body: u.endsWith("sitemap.xml") ? "<loc>other</loc>" : html }), "in_sitemap"],
  ])("fails on %s", async (_n, f, check) => {
    const v = await verifyPublishedPage(post, f as Fetcher);
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === check)?.ok).toBe(false);
  });
  it("wrong canonical / analytics tag", async () => {
    expect((await verifyPublishedPage({ ...post, canonical: "https://x.com/other" }, good)).ok).toBe(false);
    expect((await verifyPublishedPage({ ...post, analyticsTag: "G-2" }, good)).ok).toBe(false);
  });
  it("fetch errors fail closed", async () => {
    const v = await verifyPublishedPage(post, async () => { throw new Error("boom"); });
    expect(v.ok).toBe(false);
  });
});

describe("other verifiers", () => {
  it("lifecycle", () => {
    expect(verifyLifecycleSend({ providerMessageId: "m1", recipientSuppressed: false, priorReceiptsWithKey: 1 }).ok).toBe(true);
    expect(verifyLifecycleSend({ providerMessageId: "m1", recipientSuppressed: true, priorReceiptsWithKey: 1 }).ok).toBe(false);
    expect(verifyLifecycleSend({ providerMessageId: "m1", recipientSuppressed: false, priorReceiptsWithKey: 2 }).ok).toBe(false);
  });
  it("ads, experiments, pricing", () => {
    expect(verifyAdChange({ readBackState: "paused", expectedState: "paused", capBefore: 10, capAfter: 20 }).ok).toBe(false);
    expect(verifyExperimentLive({ assignmentEndpointOk: true, eventsCaptured: 5, controlCount: 3, treatmentCount: 0 }).ok).toBe(false);
    expect(verifyPricingProposal({ mutationsPerformed: 1, diffPresent: true }).ok).toBe(false);
    expect(verifyPricingProposal({ mutationsPerformed: 0, diffPresent: true }).ok).toBe(true);
  });
});
