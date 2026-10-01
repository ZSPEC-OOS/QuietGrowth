import { z } from "zod";
import { AGENTS, TOOLS } from "./agents.js";

export const CONTRACT_VERSION = 1 as const;

/** Retrieved/crawled text. Always data, never instructions (MR §14.3). */
export const UntrustedContent = z.object({
  source: z.string().min(1),
  trust: z.literal("untrusted"),
  text: z.string(),
}).strict();

export const WorkContract = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  contractId: z.string().min(1),
  orgId: z.string().min(1),
  actionId: z.string().min(1),
  agent: z.enum(AGENTS),
  task: z.string().min(1),
  /** Compiled, trusted context (policy, funnel, plans). */
  context: z.record(z.unknown()),
  untrusted: z.array(UntrustedContent).default([]),
  maxTokens: z.number().int().positive(),
  /** Signed ActionAuthorization token; required only for mutation tools. */
  authorizationToken: z.string().optional(),
}).strict();
export type WorkContract = z.infer<typeof WorkContract>;

export const Proposal = z.object({
  type: z.string().min(1),
  domain: z.enum(["acquisition", "activation", "conversion", "retention", "expansion", "economics"]),
  targetMetric: z.string().min(1),
  guardrailMetrics: z.array(z.string()),
  rationale: z.string().min(1),
  evidenceRefs: z.array(z.string()).min(1),
  expectedIncrementalImpact: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  estimatedExternalCostUsd: z.number().min(0),
  estimatedModelCostUsd: z.number().min(0),
}).strict();
export type Proposal = z.infer<typeof Proposal>;

export const ToolCall = z.object({
  callId: z.string().min(1),
  tool: z.enum(TOOLS),
  args: z.record(z.unknown()),
}).strict();
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolResult = z.object({
  callId: z.string().min(1),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
}).strict();
export type ToolResult = z.infer<typeof ToolResult>;

export const WorkResult = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  contractId: z.string().min(1),
  status: z.enum(["completed", "failed", "cancelled"]),
  proposals: z.array(Proposal).default([]),
  usage: z.object({
    cachedInputTokens: z.number().int().min(0),
    uncachedInputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
  }),
  error: z.string().optional(),
}).strict();
export type WorkResult = z.infer<typeof WorkResult>;
