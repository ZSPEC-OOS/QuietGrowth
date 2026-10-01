import { AGENTS, AGENT_TOOLS, MUTATION_TOOLS, type AgentId } from "@quietgrowth/agent-contracts";

// Per-tenant OpenClaw cell configuration, MR §7.1, §9.1, §14.3, §4.3.
export const PINNED_MODEL = "deepseek/deepseek-flash";

export interface TenantConfigInput {
  orgId: string;
  openclawImage: string;
  /** Control-plane base URL the quietgrowth-tools plugin calls. */
  controlPlaneUrl: string;
  /** References into the secret store; the cell receives names, never values in the config file. */
  secretRefs: { deepseekApiKey: string; internalSecret: string };
  tokenCeilingPerRun: number;
}

export interface TenantConfig {
  schemaVersion: 1;
  orgId: string;
  image: string;
  model: { primary: string; provider: "deepseek"; pinned: true };
  gateway: { bind: "loopback"; authRequired: true };
  hostExec: { default: "deny"; allowlist: string[] };
  agents: Record<AgentId, { tools: string[]; mutation: boolean; maxTokens: number }>;
  plugins: { "quietgrowth-tools": { controlPlaneUrl: string; orgId: string } };
  secrets: { deepseekApiKey: string; internalSecret: string };
  network: { egress: "deny_by_default"; allow: string[] };
}

export function buildTenantConfig(i: TenantConfigInput): TenantConfig {
  if (!i.orgId) throw new Error("orgId required");
  if (!/^[\w.\-/:@]+$/.test(i.openclawImage) || !/@sha256:|:[\w.-]+$/.test(i.openclawImage)) throw new Error("openclaw image must be a pinned tag or digest");
  if (/:latest$/.test(i.openclawImage)) throw new Error("openclaw image must not use :latest (version pinning, MR §28)");
  const agents = Object.fromEntries(AGENTS.map((a) => [a, { tools: [...AGENT_TOOLS[a]], mutation: AGENT_TOOLS[a].some((t) => MUTATION_TOOLS.includes(t)), maxTokens: i.tokenCeilingPerRun }])) as TenantConfig["agents"];
  return {
    schemaVersion: 1, orgId: i.orgId, image: i.openclawImage,
    model: { primary: PINNED_MODEL, provider: "deepseek", pinned: true },
    gateway: { bind: "loopback", authRequired: true },
    hostExec: { default: "deny", allowlist: [] },
    agents,
    plugins: { "quietgrowth-tools": { controlPlaneUrl: i.controlPlaneUrl, orgId: i.orgId } },
    secrets: i.secretRefs,
    network: { egress: "deny_by_default", allow: [new URL(i.controlPlaneUrl).host, "api.deepseek.com"] },
  };
}

/** Static safety validation applied to any config before a cell starts (also used by admin tooling). */
export function validateTenantConfig(c: TenantConfig): string[] {
  const errs: string[] = [];
  if (c.model.primary !== PINNED_MODEL || !c.model.pinned) errs.push("model must be pinned to deepseek/deepseek-flash");
  if (c.gateway.bind !== "loopback" || !c.gateway.authRequired) errs.push("gateway must bind to loopback with auth");
  if (c.hostExec.default !== "deny") errs.push("host exec must be deny-by-default");
  for (const a of ["funnel-analyst", "research"] as const) if (c.agents[a].mutation) errs.push(`${a} must be read-only`);
  if (c.agents.director.mutation) errs.push("director must be proposal-only");
  if (c.network.egress !== "deny_by_default") errs.push("egress must be deny-by-default");
  return errs;
}
