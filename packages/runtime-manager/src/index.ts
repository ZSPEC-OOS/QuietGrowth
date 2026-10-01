import {
  isMutationTool, isToolAllowed, WorkContract, ToolCall, ToolResult,
  type WorkContract as WorkContractT, type ToolCall as ToolCallT, type ToolResult as ToolResultT, type WorkResult,
} from "@quietgrowth/agent-contracts";

// Runtime manager interface, MR §7.2. OpenClaw implementation arrives after the M0.5 spike.
export interface RuntimeInstance { instanceId: string; orgId: string }
export interface RuntimeHealth { healthy: boolean; detail?: string }
export interface RunRef { runId: string; instanceId: string }
export type RuntimeEvent =
  | { type: "started"; runId: string }
  | { type: "tool_call"; runId: string; call: ToolCallT }
  | { type: "tool_result"; runId: string; result: ToolResultT }
  | { type: "completed"; runId: string; result: WorkResult }
  | { type: "cancelled"; runId: string };

export interface AgentRuntimeManager {
  provisionTenant(orgId: string): Promise<RuntimeInstance>;
  start(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  health(instanceId: string): Promise<RuntimeHealth>;
  run(instanceId: string, work: unknown): Promise<RunRef>;
  cancel(runId: string): Promise<void>;
  invokeTool(instanceId: string, call: unknown, contract: WorkContractT): Promise<ToolResultT>;
  streamEvents(runId: string): AsyncIterable<RuntimeEvent>;
}

export class ToolDeniedError extends Error {}

/**
 * Enforces the tool gate shared by all runtime implementations: schema validation,
 * per-agent allowlist, and an authorisation token for every mutation tool.
 */
export function gateToolCall(call: unknown, contract: WorkContractT): ToolCallT {
  const parsed = ToolCall.parse(call);
  if (!isToolAllowed(contract.agent, parsed.tool)) throw new ToolDeniedError(`${contract.agent} may not use ${parsed.tool}`);
  if (isMutationTool(parsed.tool) && !contract.authorizationToken) throw new ToolDeniedError(`${parsed.tool} requires an authorization token`);
  return parsed;
}

/** In-memory runtime for tests and local development of the control plane. */
export class FakeRuntimeManager implements AgentRuntimeManager {
  private seq = 0;
  private readonly instances = new Map<string, { orgId: string; running: boolean }>();
  private readonly runs = new Map<string, { instanceId: string; cancelled: boolean; contract: WorkContractT }>();
  private readonly events = new Map<string, RuntimeEvent[]>();
  constructor(private readonly toolImpl: (call: ToolCallT, c: WorkContractT) => Promise<ToolResultT> = async (c) => ({ callId: c.callId, ok: true })) {}

  async provisionTenant(orgId: string): Promise<RuntimeInstance> {
    const instanceId = `inst_${++this.seq}`;
    this.instances.set(instanceId, { orgId, running: false });
    return { instanceId, orgId };
  }
  private inst(id: string) {
    const i = this.instances.get(id);
    if (!i) throw new Error(`unknown instance ${id}`);
    return i;
  }
  async start(id: string) { this.inst(id).running = true; }
  async stop(id: string) { this.inst(id).running = false; }
  async health(id: string): Promise<RuntimeHealth> { return { healthy: this.inst(id).running }; }

  async run(instanceId: string, work: unknown): Promise<RunRef> {
    const i = this.inst(instanceId);
    if (!i.running) throw new Error("instance not running");
    const contract = WorkContract.parse(work);
    // Tenant boundary: a cell only runs contracts for its own organization.
    if (contract.orgId !== i.orgId) throw new ToolDeniedError("contract organization does not match runtime cell");
    const runId = `run_${++this.seq}`;
    this.runs.set(runId, { instanceId, cancelled: false, contract });
    this.events.set(runId, [{ type: "started", runId }]);
    return { runId, instanceId };
  }
  async cancel(runId: string) {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`unknown run ${runId}`);
    r.cancelled = true;
    this.events.get(runId)!.push({ type: "cancelled", runId });
  }
  async invokeTool(instanceId: string, call: unknown, contract: WorkContractT): Promise<ToolResultT> {
    const i = this.inst(instanceId);
    if (contract.orgId !== i.orgId) throw new ToolDeniedError("contract organization does not match runtime cell");
    const gated = gateToolCall(call, contract);
    return ToolResult.parse(await this.toolImpl(gated, contract));
  }
  async *streamEvents(runId: string): AsyncIterable<RuntimeEvent> {
    for (const e of this.events.get(runId) ?? []) yield e;
  }
}
