import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { fileURLToPath } from "node:url";
import type { HttpClient } from "@quietgrowth/connectors-core";
import { migrate, withOrg } from "@quietgrowth/database";
import { DeepSeekClient, DeepSeekError, TokenCeilingExceeded, parseUsage, rateTableFromEnv, recordModelUsage } from "./index.js";

const ok = (usage: unknown): HttpClient => async () => ({ status: 200, headers: {}, text: "", json: { model: "deepseek-flash", choices: [{ message: { content: "hi" } }], usage } });

describe("DeepSeekClient", () => {
  it("sends bearer auth and the pinned model, and parses cache-aware usage", async () => {
    let seen: any;
    const c = new DeepSeekClient(async (r) => { seen = r; return { status: 200, headers: {}, text: "", json: { choices: [{ message: { content: "yo" } }], usage: { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 5 } } }; }, "key");
    const r = await c.chat([{ role: "user", content: "x" }], { maxTokens: 10 });
    expect(seen.headers.authorization).toBe("Bearer key"); expect(seen.body.model).toBe("deepseek-flash"); expect(seen.url).toContain("/chat/completions");
    expect(r.text).toBe("yo"); expect(r.usage).toEqual({ cachedInputTokens: 80, uncachedInputTokens: 20, outputTokens: 5 });
  });
  it("falls back to prompt_tokens when no cache split is reported; sanitises bad numbers", () => {
    expect(parseUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 30, completion_tokens: 4 })).toEqual({ cachedInputTokens: 30, uncachedInputTokens: 70, outputTokens: 4 });
    expect(parseUsage({ prompt_cache_hit_tokens: -5, completion_tokens: "x" })).toEqual({ cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0 });
    expect(parseUsage(undefined)).toEqual({ cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0 });
  });
  it("enforces the per-action token ceiling and maps auth failures", async () => {
    await expect(new DeepSeekClient(ok({ prompt_tokens: 500, completion_tokens: 500 }), "k").chat([], { maxTokens: 1, tokenCeiling: 100 })).rejects.toThrow(TokenCeilingExceeded);
    await expect(new DeepSeekClient(async () => ({ status: 401, headers: {}, text: "", json: null }), "k").chat([])).rejects.toThrow(DeepSeekError);
  });
  it("testKey reports invalid keys without leaking the key", async () => {
    const bad = await new DeepSeekClient(async () => ({ status: 401, headers: {}, text: "", json: null }), "sk-leak-me").testKey();
    expect(bad).toEqual({ ok: false, reason: "invalid_key" }); expect(JSON.stringify(bad)).not.toContain("sk-leak");
    expect((await new DeepSeekClient(ok({ prompt_tokens: 1, completion_tokens: 1 }), "k").testKey()).ok).toBe(true);
    expect(await new DeepSeekClient(async () => ({ status: 500, headers: {}, text: "", json: null }), "k").testKey()).toEqual({ ok: false, reason: "provider_error" });
  });
});

describe("rate table", () => {
  it("must come from configuration and be valid", () => {
    expect(() => rateTableFromEnv({})).toThrow("required");
    expect(() => rateTableFromEnv({ DEEPSEEK_RATE_TABLE: "{\"version\":\"v\"}" })).toThrow("invalid");
    expect(rateTableFromEnv({ DEEPSEEK_RATE_TABLE: JSON.stringify({ version: "t1", perMillionTokensUsd: { cachedInput: 0.1, uncachedInput: 1, output: 2 } }) }).version).toBe("t1");
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("recordModelUsage", () => {
  const sch = `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: pg.Pool; let org = "";
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3, options: `-c search_path=${sch},public` });
    await pool.query(`CREATE SCHEMA ${sch}`);
    await migrate(pool, fileURLToPath(new URL("../../database/migrations", import.meta.url)));
    await pool.query(`GRANT USAGE ON SCHEMA ${sch} TO qg_app`);
    org = (await pool.query("INSERT INTO organizations (name) VALUES ('A') RETURNING id")).rows[0].id;
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA ${sch} CASCADE`); await pool.end(); });
  it("meters cache-aware cost with the rate version and per-tenant totals", async () => {
    const rates = { version: "t1", perMillionTokensUsd: { cachedInput: 1, uncachedInput: 10, output: 20 } };
    const cost = await withOrg(pool, org, (c) => recordModelUsage(c, org, { usage: { cachedInputTokens: 1_000_000, uncachedInputTokens: 500_000, outputTokens: 100_000, reasoningMode: "low", retryCount: 1 }, rates }));
    expect(cost).toBeCloseTo(8);
    const row = (await pool.query("SELECT rate_version, cost_usd, reasoning_mode, retry_count FROM model_usage WHERE organization_id=$1", [org])).rows[0];
    expect(row).toMatchObject({ rate_version: "t1", reasoning_mode: "low", retry_count: 1 }); expect(Number(row.cost_usd)).toBeCloseTo(8);
  });
});
