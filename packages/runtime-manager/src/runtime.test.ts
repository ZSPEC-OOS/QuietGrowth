import { describe, expect, it } from "vitest";
import { FakeRuntimeManager, ToolDeniedError } from "./index.js";

const contract = (o: Record<string, unknown> = {}) => ({
  contractVersion: 1 as const, contractId: "c1", orgId: "o1", actionId: "a1", agent: "acquisition" as const,
  task: "t", context: {}, untrusted: [], maxTokens: 1000, ...o,
});
const setup = async (org = "o1") => {
  const rt = new FakeRuntimeManager();
  const { instanceId } = await rt.provisionTenant(org);
  await rt.start(instanceId);
  return { rt, instanceId };
};

describe("FakeRuntimeManager", () => {
  it("run → events → cancel", async () => {
    const { rt, instanceId } = await setup();
    const { runId } = await rt.run(instanceId, contract());
    await rt.cancel(runId);
    const types: string[] = [];
    for await (const e of rt.streamEvents(runId)) types.push(e.type);
    expect(types).toEqual(["started", "cancelled"]);
  });
  it("rejects runs when stopped and invalid contracts", async () => {
    const { rt, instanceId } = await setup();
    await expect(rt.run(instanceId, { bad: 1 })).rejects.toThrow();
    await rt.stop(instanceId);
    await expect(rt.run(instanceId, contract())).rejects.toThrow("not running");
  });
  it("tenant boundary: cell refuses another org's contract", async () => {
    const { rt, instanceId } = await setup("o1");
    await expect(rt.run(instanceId, contract({ orgId: "o2" }))).rejects.toThrow(ToolDeniedError);
    await expect(rt.invokeTool(instanceId, { callId: "1", tool: "read_site", args: {} }, contract({ orgId: "o2" }))).rejects.toThrow(ToolDeniedError);
  });
  it("read-only agent cannot call mutation tool (negative test)", async () => {
    const { rt, instanceId } = await setup();
    const c = contract({ agent: "research", authorizationToken: "tok" });
    await expect(rt.invokeTool(instanceId, { callId: "1", tool: "repo_patch", args: {} }, c)).rejects.toThrow(ToolDeniedError);
  });
  it("mutation requires authorization token", async () => {
    const { rt, instanceId } = await setup();
    const call = { callId: "1", tool: "repo_patch", args: {} };
    await expect(rt.invokeTool(instanceId, call, contract())).rejects.toThrow("authorization token");
    expect((await rt.invokeTool(instanceId, call, contract({ authorizationToken: "tok" }))).ok).toBe(true);
  });
  it("unknown tools are rejected by schema", async () => {
    const { rt, instanceId } = await setup();
    await expect(rt.invokeTool(instanceId, { callId: "1", tool: "shell_exec", args: {} }, contract())).rejects.toThrow();
  });
});
