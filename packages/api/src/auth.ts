import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${(await scrypt(pw, salt, 32)).toString("base64")}`;
}
export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) { await scrypt(pw, Buffer.alloc(16), 32); return false; } // constant-ish time for unknown users
  const [alg, s, h] = stored.split("$");
  if (alg !== "scrypt" || !s || !h) return false;
  const got = await scrypt(pw, Buffer.from(s, "base64"), 32), want = Buffer.from(h, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

export type Role = "owner" | "admin" | "member";
export interface Session { userId: string; orgId: string; role: Role; exp: number }

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export function signSession(s: Session, secret: string): string {
  const p = b64(JSON.stringify(s));
  return `${p}.${b64(createHmac("sha256", secret).update(p).digest())}`;
}
export function verifySession(token: string, secret: string, nowMs: number): Session | null {
  const [p, sig] = token.split(".");
  if (!p || !sig) return null;
  const want = createHmac("sha256", secret).update(p).digest(), got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const s = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Session;
    return typeof s.exp === "number" && s.exp > nowMs && s.userId && s.orgId && ["owner", "admin", "member"].includes(s.role) ? s : null;
  } catch { return null; }
}

export const newApiKey = (): { key: string; hash: string; prefix: string } => {
  const key = `qg_live_${randomBytes(24).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 12) };
};
export const hashApiKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/**
 * Per-tenant secret for /internal/* calls. A cell only holds the secret derived for its own organisation, so a
 * compromised cell cannot call the control plane as another tenant even though the master is shared server-side.
 */
export const internalSecretFor = (master: string, orgId: string): string => createHmac("sha256", master).update(`internal:${orgId}`).digest("base64url");

export function secretsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
