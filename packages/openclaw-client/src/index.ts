import { WorkContract, ToolResult, type WorkContract as WorkContractT, type ToolResult as ToolResultT, WorkResult } from "@quietgrowth/agent-contracts";
import { gateToolCall, ToolDeniedError, type AgentRuntimeManager, type RunRef, type RuntimeEvent, type RuntimeHealth, type RuntimeInstance } from "@quietgrowth/runtime-manager";
import type { DockerCellManager, TenantConfig } from "@quietgrowth/cell-manager";

/**
 * OpenClaw Gateway adapter (MR §7.2, §29).
 *
 * UNVERIFIED ASSUMPTION: the Gateway wire protocol below (REST + NDJSON event stream) is an assumed shape,
 * isolated behind `GatewayTransport`. The M0.5 spike must confirm or replace the transport; nothing else
 * in QuietGrowth depends on the wire format.
 */
export interface GatewayTransport {
  health(baseUrl: string): Promise<boolean>;
  startRun(baseUrl: string, token: string, contract: WorkContractT): Promise<{ runId: string }>;
  cancelRun(baseUrl: string, token: string, runId: string): Promise<void>;
  streamEvents(baseUrl: string, token: string, runId: string): AsyncIterable<unknown>;
  invokeTool?(baseUrl: string, token: string, call: unknown): Promise<unknown>;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>; body?: unknown }>;

export class HttpGatewayTransport implements GatewayTransport {
  constructor(private readonly fetchImpl: FetchLike) {}
  private h(token: string) { return { authorization: `Bearer ${token}`, "content-type": "application/json" }; }
  async health(baseUrl: string): Promise<boolean> { try { return (await this.fetchImpl(`${baseUrl}/health`)).ok; } catch { return false; } }
  async startRun(baseUrl: string, token: string, contract: WorkContractT): Promise<{ runId: string }> {
    const r = await this.fetchImpl(`${baseUrl}/runs`, { method: "POST", headers: this.h(token), body: JSON.stringify(contract) });
    if (!r.ok) throw new Error(`gateway start failed: ${r.status}`);
    const j = (await r.json()) as { runId?: string };
    if (!j.runId) throw new Error("gateway returned no runId");
    return { runId: j.runId };
  }
  async cancelRun(baseUrl: string, token: string, runId: string): Promise<void> {
    const r = await this.fetchImpl(`${baseUrl}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", headers: this.h(token) });
    if (!r.ok) throw new Error(`gateway cancel failed: ${r.status}`);
  }
  async *streamEvents(baseUrl: string, token: string, runId: string): AsyncIterable<unknown> {
    const r = await this.fetchImpl(`${baseUrl}/runs/${encodeURIComponent(runId)}/events`, { headers: this.h(token) });
    if (!r.ok) throw new Error(`gateway events failed: ${r.status}`);
    for (const line of (await r.text()).split("\n")) if (line.trim()) yield JSON.parse(line);
  }
}

export interface OpenClawDeps {
  cells: DockerCellManager;
  transport: GatewayTransport;
  /** Per-tenant tenant config + gateway token provider (token comes from the secret store). */
  configFor: (orgId: string) => Promise<TenantConfig>;
  gatewayToken: (orgId: string) => Promise<string>;
  /** Executes an allowed tool call through the control plane (never directly against providers). */
  toolExecutor: (orgId: string, call: ReturnType<typeof gateToolCall>, contract: WorkContractT) => Promise<ToolResultT>;
}

export class OpenClawRuntimeManager implements AgentRuntimeManager {
  private readonly runs = new Map<string, { orgId: string; instanceId: string; contract: WorkContractT }>();
  private readonly byInstance = new Map<string, string>(); // instanceId -> orgId
  constructor(private readonly d: OpenClawDeps) {}

  private url(orgId: string): string { const c = this.d.cells.get(orgId); if (!c) throw new Error("no cell for organization"); return `http://127.0.0.1:${c.port}`; }
  private orgOf(instanceId: string): string { const o = this.byInstance.get(instanceId); if (!o) throw new Error(`unknown instance ${instanceId}`); return o; }

  async provisionTenant(orgId: string): Promise<RuntimeInstance> {
    const rec = await this.d.cells.provision(await this.d.configFor(orgId));
    this.byInstance.set(rec.instanceId, orgId);
    return { instanceId: rec.instanceId, orgId };
  }
  async start(instanceId: string): Promise<void> { await this.d.cells.start(this.orgOf(instanceId)); }
  async stop(instanceId: string): Promise<void> { await this.d.cells.stop(this.orgOf(instanceId)); }
  async health(instanceId: string): Promise<RuntimeHealth> {
    const org = this.orgOf(instanceId);
    const c = await this.d.cells.health(org);
    if (!c.healthy) return { healthy: false, detail: c.detail };
    return { healthy: await this.d.transport.health(this.url(org)), detail: c.detail };
  }

  async run(instanceId: string, work: unknown): Promise<RunRef> {
    const org = this.orgOf(instanceId);
    const contract = WorkContract.parse(work);
    if (contract.orgId !== org) throw new ToolDeniedError("contract organization does not match runtime cell"); // tenant boundary
    if (!(await this.health(instanceId)).healthy) throw new Error("runtime cell unhealthy; dispatch stopped"); // MR §27
    const { runId } = await this.d.transport.startRun(this.url(org), await this.d.gatewayToken(org), contract);
    this.runs.set(runId, { orgId: org, instanceId, contract });
    return { runId, instanceId };
  }
  async cancel(runId: string): Promise<void> {
    const r = this.runs.get(runId); if (!r) throw new Error(`unknown run ${runId}`);
    await this.d.transport.cancelRun(this.url(r.orgId), await this.d.gatewayToken(r.orgId), runId);
  }
  async invokeTool(instanceId: string, call: unknown, contract: WorkContractT): Promise<ToolResultT> {
    const org = this.orgOf(instanceId);
    if (contract.orgId !== org) throw new ToolDeniedError("contract organization does not match runtime cell");
    const gated = gateToolCall(call, contract); // schema + allowlist + token-for-mutation
    return ToolResult.parse(await this.d.toolExecutor(org, gated, contract));
  }
  async *streamEvents(runId: string): AsyncIterable<RuntimeEvent> {
    const r = this.runs.get(runId); if (!r) throw new Error(`unknown run ${runId}`);
    for await (const raw of this.d.transport.streamEvents(this.url(r.orgId), await this.d.gatewayToken(r.orgId), runId)) {
      const e = raw as { type?: string; call?: unknown; result?: unknown };
      // Only well-formed, known event shapes cross the boundary; the rest is dropped (untrusted input).
      if (e.type === "started") yield { type: "started", runId };
      else if (e.type === "cancelled") yield { type: "cancelled", runId };
      else if (e.type === "completed") { const p = WorkResult.safeParse(e.result); if (p.success && p.data.contractId === r.contract.contractId) yield { type: "completed", runId, result: p.data }; }
    }
  }
}
