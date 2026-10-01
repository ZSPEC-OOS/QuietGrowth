import { describe, expect, it } from "vitest";
import { LocalEncryptedSecretStore, MapBacking, SecretNotFoundError, redact } from "./index.js";

const key = LocalEncryptedSecretStore.generateKey();

describe("LocalEncryptedSecretStore", () => {
  it("round-trips and never stores plaintext", async () => {
    const backing = new MapBacking();
    const s = new LocalEncryptedSecretStore(key, backing);
    const ref = await s.put("o1", "deepseek", "sk-supersecretvalue12345");
    expect(await s.get("o1", ref)).toBe("sk-supersecretvalue12345");
    expect(JSON.stringify([...backing.raw.values()])).not.toContain("supersecret");
  });
  it("refs are org-bound and indistinguishable from missing", async () => {
    const s = new LocalEncryptedSecretStore(key);
    const ref = await s.put("o1", "k", "v");
    await expect(s.get("o2", ref)).rejects.toThrow(SecretNotFoundError);
    await expect(s.get("o1", "sec_nope")).rejects.toThrow(SecretNotFoundError);
  });
  it("detects tampering and wrong master key", async () => {
    const backing = new MapBacking();
    const s = new LocalEncryptedSecretStore(key, backing);
    const ref = await s.put("o1", "k", "value");
    const sealed = backing.raw.get(ref)!;
    backing.raw.set(ref, { ...sealed, data: Buffer.from("xxxxxx").toString("base64") });
    await expect(s.get("o1", ref)).rejects.toThrow();
    backing.raw.set(ref, sealed);
    await expect(new LocalEncryptedSecretStore(LocalEncryptedSecretStore.generateKey(), backing).get("o1", ref)).rejects.toThrow();
  });
  it("delete removes only within org; rejects bad key length", async () => {
    const s = new LocalEncryptedSecretStore(key);
    const ref = await s.put("o1", "k", "v");
    await s.delete("o2", ref);
    expect(await s.get("o1", ref)).toBe("v");
    await s.delete("o1", ref);
    await expect(s.get("o1", ref)).rejects.toThrow();
    expect(() => new LocalEncryptedSecretStore("short")).toThrow();
  });
});

describe("redact", () => {
  it("redacts secret keys and token-shaped strings, recursively", () => {
    const out = redact({ apiKey: "abc", nested: { Authorization: "Bearer abcdefghijkl", note: "key sk-abcdefghijklmnopqrstu here" }, list: ["ghp_abcdefghijklmnopqrstuvwx"], ok: 1 });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/abcdefghijkl|sk-abc|ghp_/);
    expect(out.ok).toBe(1);
  });
});

import { afterAll, beforeAll } from "vitest";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { migrate } from "@quietgrowth/database";
import { PgBacking } from "./index.js";

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("PgBacking (shared across processes, tenant-bound)", () => {
  const sch = `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: pg.Pool; let a = "", b = "";
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3, options: `-c search_path=${sch},public` });
    await pool.query(`CREATE SCHEMA ${sch}`);
    await migrate(pool, fileURLToPath(new URL("../../database/migrations", import.meta.url)));
    await pool.query(`GRANT USAGE ON SCHEMA ${sch} TO qg_app`);
    a = (await pool.query("INSERT INTO organizations (name) VALUES ('A') RETURNING id")).rows[0].id;
    b = (await pool.query("INSERT INTO organizations (name) VALUES ('B') RETURNING id")).rows[0].id;
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA ${sch} CASCADE`); await pool.end(); });
  it("a second store instance (another process) can read what the first wrote; plaintext never reaches the DB", async () => {
    const writer = new LocalEncryptedSecretStore(key, new PgBacking(pool)), reader = new LocalEncryptedSecretStore(key, new PgBacking(pool));
    const ref = await writer.put(a, "stripe", "sk_live_supersecretvalue");
    expect(await reader.get(a, ref)).toBe("sk_live_supersecretvalue");
    expect(JSON.stringify((await pool.query("SELECT * FROM secrets")).rows)).not.toContain("supersecret");
  });
  it("is tenant isolated and deletable", async () => {
    const s = new LocalEncryptedSecretStore(key, new PgBacking(pool));
    const ref = await s.put(a, "k", "v");
    await expect(s.get(b, ref)).rejects.toThrow(SecretNotFoundError);
    await s.delete(b, ref); expect(await s.get(a, ref)).toBe("v");
    await s.delete(a, ref); await expect(s.get(a, ref)).rejects.toThrow(SecretNotFoundError);
  });
});
