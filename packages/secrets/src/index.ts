import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

/** Secrets are stored by reference; callers only ever hold a `ref` (MR §14.3). */
export interface SecretStore {
  put(orgId: string, name: string, value: string): Promise<string>;
  get(orgId: string, ref: string): Promise<string>;
  delete(orgId: string, ref: string): Promise<void>;
}

export class SecretNotFoundError extends Error {}

interface Sealed { orgId: string; iv: string; tag: string; data: string }

/**
 * Local encrypted store (self-hosted mode). AES-256-GCM; the org id is bound as AAD,
 * so a ref cannot be decrypted under a different organization.
 * Persistence is injectable; default is in-memory.
 */
export class LocalEncryptedSecretStore implements SecretStore {
  private readonly key: Buffer;
  constructor(masterKey: string | Buffer, private readonly backing: Map<string, Sealed> = new Map()) {
    const key = typeof masterKey === "string" ? Buffer.from(masterKey, "base64") : masterKey;
    if (key.length !== 32) throw new Error("master key must be 32 bytes");
    this.key = key;
  }
  static generateKey(): string { return randomBytes(32).toString("base64"); }

  async put(orgId: string, name: string, value: string): Promise<string> {
    const ref = `sec_${name.replace(/[^a-z0-9_-]/gi, "_")}_${randomUUID()}`;
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(orgId));
    const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
    this.backing.set(ref, { orgId, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
    return ref;
  }
  async get(orgId: string, ref: string): Promise<string> {
    const s = this.backing.get(ref);
    // Same error for missing and cross-org refs: no existence oracle.
    if (!s || s.orgId !== orgId) throw new SecretNotFoundError("secret not found");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(s.iv, "base64"));
    d.setAAD(Buffer.from(orgId));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
  }
  async delete(orgId: string, ref: string): Promise<void> {
    const s = this.backing.get(ref);
    if (s && s.orgId === orgId) this.backing.delete(ref);
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /ya29\.[A-Za-z0-9._-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
];
const SECRET_KEYS = /^(authorization|api[_-]?key|token|secret|password|client[_-]?secret|access[_-]?token|refresh[_-]?token|deepseek[_-]?api[_-]?key)$/i;

/** Redacts secret-bearing keys and token-shaped strings from log payloads. */
export function redact<T>(value: T): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8) return "[truncated]";
    if (typeof v === "string") return SECRET_PATTERNS.reduce((s, re) => s.replace(re, "[REDACTED]"), v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.test(k) ? "[REDACTED]" : walk(x, depth + 1)]));
    }
    return v;
  };
  return walk(value, 0) as T;
}
