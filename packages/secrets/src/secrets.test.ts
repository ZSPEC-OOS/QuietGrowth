import { describe, expect, it } from "vitest";
import { LocalEncryptedSecretStore, SecretNotFoundError, redact } from "./index.js";

const key = LocalEncryptedSecretStore.generateKey();

describe("LocalEncryptedSecretStore", () => {
  it("round-trips and never stores plaintext", async () => {
    const backing = new Map();
    const s = new LocalEncryptedSecretStore(key, backing);
    const ref = await s.put("o1", "deepseek", "sk-supersecretvalue12345");
    expect(await s.get("o1", ref)).toBe("sk-supersecretvalue12345");
    expect(JSON.stringify([...backing.values()])).not.toContain("supersecret");
  });
  it("refs are org-bound and indistinguishable from missing", async () => {
    const s = new LocalEncryptedSecretStore(key);
    const ref = await s.put("o1", "k", "v");
    await expect(s.get("o2", ref)).rejects.toThrow(SecretNotFoundError);
    await expect(s.get("o1", "sec_nope")).rejects.toThrow(SecretNotFoundError);
  });
  it("detects tampering and wrong master key", async () => {
    const backing = new Map();
    const s = new LocalEncryptedSecretStore(key, backing);
    const ref = await s.put("o1", "k", "value");
    const sealed = backing.get(ref);
    backing.set(ref, { ...sealed, data: Buffer.from("xxxxxx").toString("base64") });
    await expect(s.get("o1", ref)).rejects.toThrow();
    backing.set(ref, sealed);
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
