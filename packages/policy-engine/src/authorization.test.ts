import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore, signAuthorization, verifyAuthorization, type ActionAuthorization } from "./authorization.js";

const secret = "test-secret";
const auth: ActionAuthorization = { actionId: "a1", policyVersion: "v1", resourceScope: "repo:o/r", idempotencyKey: "k1", expiresAt: 2000 };
const exp = { actionId: "a1", policyVersion: "v1", resourceScope: "repo:o/r", now: 1000 };

describe("action authorization", () => {
  it("accepts a valid token once, rejects replay", () => {
    const store = new InMemoryIdempotencyStore();
    const t = signAuthorization(auth, secret);
    expect(verifyAuthorization(t, secret, exp, store).ok).toBe(true);
    expect(verifyAuthorization(t, secret, exp, store)).toEqual({ ok: false, reason: "replay" });
  });
  it("rejects tampering and wrong secret", () => {
    const t = signAuthorization(auth, secret);
    const forged = signAuthorization({ ...auth, resourceScope: "repo:evil" }, secret).split(".")[0] + "." + t.split(".")[1];
    expect(verifyAuthorization(forged, secret, exp, new InMemoryIdempotencyStore())).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyAuthorization(t, "other", exp, new InMemoryIdempotencyStore())).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("rejects expiry, scope, policy, action mismatches", () => {
    const t = signAuthorization(auth, secret);
    const v = (e: Partial<typeof exp>) => verifyAuthorization(t, secret, { ...exp, ...e }, new InMemoryIdempotencyStore());
    expect(v({ now: 2000 })).toEqual({ ok: false, reason: "expired" });
    expect(v({ resourceScope: "repo:x" })).toEqual({ ok: false, reason: "scope_mismatch" });
    expect(v({ policyVersion: "v2" })).toEqual({ ok: false, reason: "policy_mismatch" });
    expect(v({ actionId: "a2" })).toEqual({ ok: false, reason: "action_mismatch" });
  });
  it("failed verification does not burn the idempotency key", () => {
    const store = new InMemoryIdempotencyStore();
    const t = signAuthorization(auth, secret);
    verifyAuthorization(t, secret, { ...exp, resourceScope: "wrong" }, store);
    expect(verifyAuthorization(t, secret, exp, store).ok).toBe(true);
  });
  it("rejects malformed tokens", () => {
    for (const t of ["", "abc", "a.b.c", "."]) expect(verifyAuthorization(t, secret, exp, new InMemoryIdempotencyStore()).ok).toBe(false);
  });
});
