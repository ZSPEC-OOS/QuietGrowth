import { describe, expect, it } from "vitest";
import { AGENTS } from "@quietgrowth/agent-contracts";
import { ControlPlaneTools, toolDefinitions } from "./index.js";

const mk = (status: number, body: unknown) => {
  const calls: { url: string; init: any }[] = [];
  const t = new ControlPlaneTools({ controlPlaneUrl: "https://cp.test/", orgId: "org-fixed", internalSecret: "sec", fetchImpl: (async (url: string, init: any) => { calls.push({ url, init }); return { ok: status < 400, status, json: async () => body }; }) as never });
  return { t, calls };
};

describe("quietgrowth-tools plugin", () => {
  it("exposes only the agent's allowlisted tools and flags mutation tools", () => {
    expect(toolDefinitions("research").map((d) => d.name)).toEqual(["read_site", "web_research"]);
    expect(toolDefinitions("acquisition").some((d) => d.name === "repo_patch" && d.mutation)).toBe(true);
    for (const a of AGENTS) expect(toolDefinitions(a).length).toBeGreaterThan(0);
  });
  it("pins orgId from cell config (model-supplied org is ignored) and sends the internal secret", async () => {
    const { t, calls } = mk(200, { ok: true, data: { x: 1 } });
    const r = await t.call("funnel-analyst", {}, "read_analytics", { orgId: "evil-org" }, "c1");
    expect(r).toMatchObject({ callId: "c1", ok: true });
    expect(JSON.parse(calls[0]!.init.body).orgId).toBe("org-fixed");
    expect(calls[0]!.init.headers["x-internal-secret"]).toBe("sec"); expect(calls[0]!.url).toBe("https://cp.test/internal/tools/read_analytics");
  });
  it("refuses non-allowlisted tools locally without any network call", async () => {
    const { t, calls } = mk(200, {});
    expect((await t.call("research", {}, "repo_patch", {}, "c2")).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("surfaces control-plane denials as failed results", async () => {
    const r = await mk(403, { error: "tool_denied" }).t.call("director", {}, "propose_action", {}, "c3");
    expect(r.ok).toBe(false); expect(r.error).toBe("tool_denied");
  });
});
