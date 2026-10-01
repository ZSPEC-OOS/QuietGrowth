import { createHmac, timingSafeEqual } from "node:crypto";

/** Signed action authorisation envelope, MR §9.1, §14.3. */
export interface ActionAuthorization {
  actionId: string;
  policyVersion: string;
  /** Resource scope the write may touch, e.g. "repo:org/site:branch:qg/*". */
  resourceScope: string;
  idempotencyKey: string;
  /** Expiry, epoch milliseconds. */
  expiresAt: number;
}

export type VerifyFailure = "malformed" | "bad_signature" | "expired" | "scope_mismatch" | "policy_mismatch" | "action_mismatch" | "replay";
export type VerifyResult = { ok: true; auth: ActionAuthorization } | { ok: false; reason: VerifyFailure };

const b64 = (b: Buffer) => b.toString("base64url");
const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest();

export function signAuthorization(auth: ActionAuthorization, secret: string): string {
  const payload = b64(Buffer.from(JSON.stringify(auth)));
  return `${payload}.${b64(sign(secret, payload))}`;
}

export interface IdempotencyStore {
  /** Returns true if the key was newly claimed, false if already used. */
  claim(key: string): boolean;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Set<string>();
  claim(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

export interface VerifyExpectation {
  actionId: string;
  policyVersion: string;
  /** Scope the connector is about to touch; must equal the authorised scope. */
  resourceScope: string;
  now: number;
}

/** Verifies signature, expiry, binding, then claims the idempotency key (last). */
export function verifyAuthorization(token: string, secret: string, exp: VerifyExpectation, store: IdempotencyStore): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts as [string, string];
  const given = Buffer.from(sig, "base64url");
  const want = sign(secret, payload);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: "bad_signature" };
  let auth: ActionAuthorization;
  try {
    auth = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ActionAuthorization;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof auth.expiresAt !== "number" || typeof auth.idempotencyKey !== "string") return { ok: false, reason: "malformed" };
  if (exp.now >= auth.expiresAt) return { ok: false, reason: "expired" };
  if (auth.actionId !== exp.actionId) return { ok: false, reason: "action_mismatch" };
  if (auth.policyVersion !== exp.policyVersion) return { ok: false, reason: "policy_mismatch" };
  if (auth.resourceScope !== exp.resourceScope) return { ok: false, reason: "scope_mismatch" };
  if (!store.claim(auth.idempotencyKey)) return { ok: false, reason: "replay" };
  return { ok: true, auth };
}
