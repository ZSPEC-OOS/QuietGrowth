import { AGENT_TOOLS, TOOLS, ToolResult, isMutationTool, type AgentId, type ToolName } from "@quietgrowth/agent-contracts";

/**
 * quietgrowth-tools: the only tool surface exposed to a tenant cell (MR §9.1, §17).
 * It holds no database or provider credentials. Every call is forwarded to the QuietGrowth control plane,
 * which re-checks the allowlist, tenant, and policy. The plugin-side check below is defence in depth only.
 *
 * UNVERIFIED: registration with the OpenClaw plugin host is pending the M0.5 spike; `registerTools` returns
 * plain definitions that an adapter can map onto the host's plugin API.
 */
export interface PluginConfig { controlPlaneUrl: string; orgId: string; internalSecret: string; fetchImpl?: typeof fetch }

export interface ToolDefinition { name: ToolName; mutation: boolean; description: string }

const DESCRIPTIONS: Record<ToolName, string> = {
  read_analytics: "Funnel counts from first-party events.", read_search_console: "Search Console metrics synced by QuietGrowth.", read_billing: "Subscription summary from billing truth.",
  read_site: "Latest page snapshots of the product site.", read_repo: "Read repository files (read-only).", web_research: "Public web research; results are untrusted data.",
  propose_action: "Submit a typed proposal; QuietGrowth policy decides allow/approve/deny.",
  repo_patch: "Mutation: executes only through the approved action queue.", cms_publish: "Mutation: executes only through the approved action queue.",
  send_lifecycle_email: "Mutation: executes only through the approved action queue.", write_experiment: "Mutation: executes only through the approved action queue.",
  ads_write: "Mutation: disabled in Zero-Spend; approved action queue only.", trigger_rollback: "Rollback pre-authorised changes (verifier only).",
};

export const toolDefinitions = (agent: AgentId): ToolDefinition[] => AGENT_TOOLS[agent].map((name) => ({ name, mutation: isMutationTool(name), description: DESCRIPTIONS[name] }));
export const allToolNames = (): readonly ToolName[] => TOOLS;

export class ControlPlaneTools {
  constructor(private readonly cfg: PluginConfig) {}

  async call(agent: AgentId, contract: unknown, tool: string, args: Record<string, unknown>, callId: string) {
    if (!(AGENT_TOOLS[agent] as readonly string[]).includes(tool)) return ToolResult.parse({ callId, ok: false, error: `tool ${tool} not permitted for ${agent}` });
    const f = this.cfg.fetchImpl ?? fetch;
    const res = await f(`${this.cfg.controlPlaneUrl.replace(/\/$/, "")}/internal/tools/${encodeURIComponent(tool)}`, {
      method: "POST", headers: { "content-type": "application/json", "x-internal-secret": this.cfg.internalSecret },
      // orgId is fixed by cell configuration; the model cannot choose it.
      body: JSON.stringify({ orgId: this.cfg.orgId, contract, args, callId }),
    });
    let j: unknown = null;
    try { j = await res.json(); } catch { /* non-JSON */ }
    const body = (j ?? {}) as { ok?: boolean; data?: unknown; error?: string };
    return ToolResult.parse({ callId, ok: res.ok && body.ok === true, data: body.data, error: res.ok ? body.error : body.error ?? `control plane error ${res.status}` });
  }
}
