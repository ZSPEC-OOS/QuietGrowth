import { describe, expect, it } from "vitest";
import { buildTenantConfig, DockerCellManager, type CommandRunner } from "@quietgrowth/cell-manager";
import { OpenClawRuntimeManager, HttpGatewayTransport, type FetchLike, type GatewayTransport } from "./index.js";

const ORG = "11111111-1111-1111-1111-111111111111";
const cfgFor = async (orgId: string) => buildTenantConfig({ orgId, openclawImage: "registry.example/openclaw:1.0", controlPlaneUrl: "https://api.qg.test", secretRefs: { deepseekApiKey: "a", internalSecret: "b" }, tokenCeilingPerRun: 1000 });
const docker: CommandRunner = { run: async (_c, a) => ({ code: 0, stdout: a[0] === "inspect" ? "running|healthy" : "", stderr: "" }) };
const contract = (o: Record<string, unknown> = {}) => ({ contractVersion: 1 as const, contractId: "c1", orgId: ORG, actionId: "a1", agent: "acquisition" as const, task: "t", context: {}, untrusted: [], maxTokens: 100, ...o });

function setup(over: Partial<GatewayTransport> = {}) {
  const log: string[] = [];
  const transport: GatewayTransport = {
    health: async () => true,
    startRun: async (_u, tok) => { log.push(`start:${tok}`); return { runId: "r1" }; },
    cancelRun: async (_u, _t, id) => { log.push(`cancel:${id}`); },
    streamEvents: async function* () { yield { type: "started" }; yield { type: "bogus", x: 1 }; yield { type: "completed", result: { contractVersion: 1, contractId: "c1", status: "completed", usage: { cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 } } }; yield { type: "completed", result: { contractVersion: 1, contractId: "OTHER", status: "completed", usage: { cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 } } }; },
    ...over,
  };
  const cells = new DockerCellManager(docker, 20000);
  const rt = new OpenClawRuntimeManager({ cells, transport, configFor: cfgFor, gatewayToken: async () => "gwtok", toolExecutor: async (_o, c) => ({ callId: c.callId, ok: true }) });
  return { rt, log, cells };
}
const boot = async (s: ReturnType<typeof setup>) => { const i = await s.rt.provisionTenant(ORG); await s.rt.start(i.instanceId); return i; };

describe("OpenClawRuntimeManager", () => {
  it("run → stream (filters unknown/mismatched events) → cancel", async () => {
    const s = setup(); const i = await boot(s);
    const { runId } = await s.rt.run(i.instanceId, contract());
    const types: string[] = []; for await (const e of s.rt.streamEvents(runId)) types.push(e.type);
    expect(types).toEqual(["started", "completed"]);
    await s.rt.cancel(runId); expect(s.log).toEqual(["start:gwtok", "cancel:r1"]);
  });
  it("enforces the tenant boundary and refuses to dispatch to an unhealthy cell", async () => {
    const s = setup(); const i = await boot(s);
    await expect(s.rt.run(i.instanceId, contract({ orgId: "22222222-2222-2222-2222-222222222222" }))).rejects.toThrow("organization");
    const bad = setup({ health: async () => false }); const bi = await boot(bad);
    await expect(bad.rt.run(bi.instanceId, contract())).rejects.toThrow("unhealthy");
    expect(bad.log).toEqual([]);
  });
  it("tool gate: allowlist and token requirement apply before the executor runs", async () => {
    const s = setup(); const i = await boot(s);
    await expect(s.rt.invokeTool(i.instanceId, { callId: "1", tool: "ads_write", args: {} }, contract({ authorizationToken: "t" }))).rejects.toThrow("may not use");
    await expect(s.rt.invokeTool(i.instanceId, { callId: "1", tool: "repo_patch", args: {} }, contract())).rejects.toThrow("authorization token");
    expect((await s.rt.invokeTool(i.instanceId, { callId: "1", tool: "read_site", args: {} }, contract())).ok).toBe(true);
  });
  it("invalid contracts are rejected before reaching the gateway", async () => {
    const s = setup(); const i = await boot(s);
    await expect(s.rt.run(i.instanceId, { nope: 1 })).rejects.toThrow();
    expect(s.log).toEqual([]);
  });
});

describe("HttpGatewayTransport", () => {
  const f = (status: number, body: unknown = {}): FetchLike => async () => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  it("maps responses and fails closed", async () => {
    expect((await new HttpGatewayTransport(f(200, { runId: "x" })).startRun("http://h", "t", contract() as never)).runId).toBe("x");
    await expect(new HttpGatewayTransport(f(500)).startRun("http://h", "t", contract() as never)).rejects.toThrow("500");
    await expect(new HttpGatewayTransport(f(200, {})).startRun("http://h", "t", contract() as never)).rejects.toThrow("no runId");
    expect(await new HttpGatewayTransport(async () => { throw new Error("down"); }).health("http://h")).toBe(false);
    const evs: unknown[] = []; for await (const e of new HttpGatewayTransport(f(200, '{"type":"started"}\n\n{"type":"cancelled"}')).streamEvents("http://h", "t", "r")) evs.push(e);
    expect(evs).toHaveLength(2);
  });
});
