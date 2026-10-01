// Agent topology and tool policy, MR §9, §9.1.
export const AGENTS = [
  "director", "funnel-analyst", "research", "acquisition", "lifecycle",
  "conversion", "product-led-growth", "paid-search", "verifier",
] as const;
export type AgentId = (typeof AGENTS)[number];

export const TOOLS = [
  "read_analytics", "read_search_console", "read_billing", "read_site", "read_repo",
  "web_research", "propose_action",
  "repo_patch", "cms_publish", "send_lifecycle_email", "write_experiment", "ads_write",
  "trigger_rollback",
] as const;
export type ToolName = (typeof TOOLS)[number];

export const MUTATION_TOOLS: readonly ToolName[] = [
  "repo_patch", "cms_publish", "send_lifecycle_email", "write_experiment", "ads_write", "trigger_rollback",
];

const READ: ToolName[] = ["read_analytics", "read_search_console", "read_billing", "read_site", "read_repo"];

/** Deny-by-default allowlist. An agent absent from this map has no tools. */
export const AGENT_TOOLS: Readonly<Record<AgentId, readonly ToolName[]>> = {
  director: [...READ, "propose_action"],
  "funnel-analyst": [...READ],
  research: ["read_site", "web_research"],
  acquisition: [...READ, "propose_action", "repo_patch", "cms_publish"],
  lifecycle: [...READ, "propose_action", "send_lifecycle_email"],
  conversion: [...READ, "propose_action", "write_experiment"],
  "product-led-growth": [...READ, "propose_action", "repo_patch"],
  "paid-search": [...READ, "propose_action", "ads_write"],
  verifier: [...READ, "trigger_rollback"],
};

export const isMutationTool = (t: ToolName): boolean => MUTATION_TOOLS.includes(t);

export function isToolAllowed(agent: string, tool: string): boolean {
  const list = (AGENT_TOOLS as Record<string, readonly string[] | undefined>)[agent];
  return !!list && list.includes(tool);
}
