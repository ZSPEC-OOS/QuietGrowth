import { describe, expect, it } from "vitest";
import { UnsafeUrlError, analyzeHtml, assertPublicUrl, isPrivateAddress, safeFetch, validateGrowthContract } from "./index.js";

const pub = async () => ["93.184.216.34"];

describe("SSRF guard", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"])("private: %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"])("public: %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));
  it.each([
    "file:///etc/passwd", "gopher://x", "http://user:pw@example.com", "http://example.com:8080", "http://localhost/", "http://127.0.0.1/",
    "http://[::1]/", "http://metadata.internal/", "not a url", "http://169.254.169.254/latest",
  ])("rejects %s", async (u) => { await expect(assertPublicUrl(u, pub)).rejects.toThrow(UnsafeUrlError); });
  it("rejects hostnames resolving to private addresses (DNS rebinding style)", async () => {
    await expect(assertPublicUrl("https://evil.example", async () => ["93.184.216.34", "10.0.0.5"])).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl("https://nx.example", async () => [])).rejects.toThrow(UnsafeUrlError);
  });
  it("accepts public https", async () => { expect((await assertPublicUrl("https://example.com/x", pub)).hostname).toBe("example.com"); });
  it("re-validates every redirect hop and caps hops/size", async () => {
    const redirectToPrivate = async (u: string) => u.includes("start") ? { status: 302, headers: { location: "http://169.254.169.254/" }, body: "" } : { status: 200, headers: {}, body: "x" };
    await expect(safeFetch("https://start.example", { resolve: pub, fetchImpl: redirectToPrivate })).rejects.toThrow(UnsafeUrlError);
    const loop = async () => ({ status: 302, headers: { location: "https://a.example/" }, body: "" });
    await expect(safeFetch("https://a.example/", { resolve: pub, fetchImpl: loop })).rejects.toThrow("too many redirects");
    const big = async () => ({ status: 200, headers: {}, body: "x".repeat(100) });
    await expect(safeFetch("https://a.example/", { resolve: pub, fetchImpl: big, maxBytes: 10 })).rejects.toThrow("too large");
    expect((await safeFetch("https://a.example/", { resolve: pub, fetchImpl: async () => ({ status: 200, headers: {}, body: "ok" }) })).body).toBe("ok");
  });
});

describe("analyzeHtml", () => {
  const html = `<html><head><title>Acme Flow | Workflow automation for teams</title><meta name="description" content="Automate team workflows"><script>var secret=1</script></head>
  <body><h1>Automate work</h1><a href="/signup">Get started free</a><a href="/docs">Docs</a><p>Teams love our API and integrations. Pro $29/mo. Start your free trial.</p></body></html>`;
  const p = analyzeHtml(html);
  it("extracts name, description, headings, CTA, pricing, trial, category", () => {
    expect(p.name).toBe("Acme Flow");
    expect(p.description).toBe("Automate team workflows");
    expect(p.headings).toEqual(["Automate work"]);
    expect(p.signupPath).toBe("/signup");
    expect(p.pricingMentions).toContain("$29/mo");
    expect(p.hasFreeTrial).toBe(true);
    expect(p.category).toBe("b2b");
    expect(p.evidence.length).toBeGreaterThan(2);
  });
  it("ignores scripts and tolerates empty input", () => {
    expect(JSON.stringify(p)).not.toContain("secret");
    expect(analyzeHtml("").name).toBeNull();
  });
});

describe("growth contract", () => {
  const ok = { primaryConversion: "subscription_started", activationEvent: "first_project", signupEvent: "account_created", retentionWindowDays: 30, billingSource: "stripe", acquisitionObjective: "net new retained subscribers", guardrails: ["refund_rate"] };
  it("accepts a complete contract and lists every missing field otherwise", () => {
    expect(validateGrowthContract(ok).ok).toBe(true);
    const r = validateGrowthContract({});
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(7);
    expect(validateGrowthContract({ ...ok, retentionWindowDays: 0 }).ok).toBe(false);
  });
});
