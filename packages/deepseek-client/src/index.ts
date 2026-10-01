import type { HttpClient } from "@quietgrowth/connectors-core";
import { costUsd, withinTokenCeiling, type RateTable, type Usage } from "@quietgrowth/cost-engine";
import type { PoolClient } from "pg";

/**
 * Minimal DeepSeek client for BYOK validation and cost metering (MR §4).
 * UNVERIFIED: the endpoint path and usage field names follow DeepSeek's long-standing OpenAI-compatible API
 * (`/chat/completions`, `usage.prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `completion_tokens`). The
 * V4.1 Flash model name `deepseek-flash` comes from the reference document (MR §29) and must be revalidated at
 * release (M0.6 spike). Agents themselves reach the model through OpenClaw, not through this client.
 */
export const DEFAULT_MODEL = "deepseek-flash";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";

export class DeepSeekError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export class TokenCeilingExceeded extends Error {}

export interface ChatResult { text: string; usage: Usage; model: string }

export function parseUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => (typeof u[k] === "number" && Number.isFinite(u[k] as number) && (u[k] as number) >= 0 ? (u[k] as number) : 0);
  const hit = n("prompt_cache_hit_tokens");
  const miss = "prompt_cache_miss_tokens" in u ? n("prompt_cache_miss_tokens") : Math.max(0, n("prompt_tokens") - hit);
  return { cachedInputTokens: hit, uncachedInputTokens: miss, outputTokens: n("completion_tokens") };
}

export class DeepSeekClient {
  constructor(private readonly http: HttpClient, private readonly apiKey: string, private readonly baseUrl = DEFAULT_BASE_URL, private readonly model = DEFAULT_MODEL) {}

  async chat(messages: { role: "system" | "user" | "assistant"; content: string }[], opts: { maxTokens: number; tokenCeiling?: number } = { maxTokens: 256 }): Promise<ChatResult> {
    const r = await this.http({ method: "POST", url: `${this.baseUrl}/chat/completions`, headers: { authorization: `Bearer ${this.apiKey}` }, body: { model: this.model, messages, max_tokens: opts.maxTokens, stream: false } });
    if (r.status === 401 || r.status === 403) throw new DeepSeekError(r.status, "DeepSeek rejected the API key");
    if (r.status !== 200) throw new DeepSeekError(r.status, `DeepSeek error ${r.status}`);
    const j = r.json as { choices?: { message?: { content?: string } }[]; usage?: unknown; model?: string };
    const usage = parseUsage(j.usage);
    // Abort/re-plan on overrun (MR §4.2): the caller decides what to do, but the overrun is never silent.
    if (opts.tokenCeiling !== undefined && !withinTokenCeiling(usage, opts.tokenCeiling)) throw new TokenCeilingExceeded("per-action token ceiling exceeded");
    return { text: j.choices?.[0]?.message?.content ?? "", usage, model: j.model ?? this.model };
  }

  /** BYOK validation: a one-token call. Returns usage so the test itself is metered. */
  async testKey(): Promise<{ ok: true; usage: Usage } | { ok: false; reason: string }> {
    try { return { ok: true, usage: (await this.chat([{ role: "user", content: "ping" }], { maxTokens: 1 })).usage }; }
    catch (e) { return { ok: false, reason: e instanceof DeepSeekError && (e.status === 401 || e.status === 403) ? "invalid_key" : "provider_error" }; }
  }
}

/** Reads the active rate table from configuration (never hard-coded; MR §4.2). */
export function rateTableFromEnv(env: Record<string, string | undefined>): RateTable {
  const raw = env.DEEPSEEK_RATE_TABLE;
  if (!raw) throw new Error("DEEPSEEK_RATE_TABLE is required (JSON: {version, perMillionTokensUsd:{cachedInput,uncachedInput,output}})");
  const t = JSON.parse(raw) as RateTable;
  const p = t?.perMillionTokensUsd;
  if (!t.version || !p || ![p.cachedInput, p.uncachedInput, p.output].every((x) => typeof x === "number" && x >= 0)) throw new Error("invalid DEEPSEEK_RATE_TABLE");
  return t;
}

/** Appends a model-cost ledger row (tenant-bound client). Cost is computed from the supplied rate table. */
export async function recordModelUsage(c: PoolClient, orgId: string, a: { actionId?: string; usage: Usage; rates: RateTable }): Promise<number> {
  const cost = costUsd(a.usage, a.rates);
  await c.query(
    `INSERT INTO model_usage (organization_id, action_id, rate_version, cached_input_tokens, uncached_input_tokens, output_tokens, reasoning_mode, retry_count, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [orgId, a.actionId ?? null, a.rates.version, a.usage.cachedInputTokens, a.usage.uncachedInputTokens, a.usage.outputTokens, a.usage.reasoningMode ?? null, a.usage.retryCount ?? 0, cost]);
  return cost;
}
