import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore, signAuthorization } from "@quietgrowth/policy-engine";
import { ConnectorDegradedError, HealthGate, WriteNotAuthorizedError, authorizeWrite, withRetry, type HttpResponse } from "./index.js";

const secret = "s";
const token = (o = {}) => signAuthorization({ actionId: "a", policyVersion: "v1", resourceScope: "repo:x", idempotencyKey: "k1", expiresAt: 10_000, ...o }, secret);
const ctx = () => ({ secret, store: new InMemoryIdempotencyStore(), now: () => 1000 });
const exp = { actionId: "a", policyVersion: "v1", resourceScope: "repo:x" };
const res = (status: number): HttpResponse => ({ status, headers: {}, json: null, text: "" });

describe("authorizeWrite", () => {
  it("allows a valid token when healthy", () => { expect(authorizeWrite(new HealthGate(), ctx(), token(), exp).idempotencyKey).toBe("k1"); });
  it("refuses writes when degraded or revoked, even with a valid token", () => {
    const g = new HealthGate();
    g.set({ status: "degraded", detail: "expired" });
    expect(() => authorizeWrite(g, ctx(), token(), exp)).toThrow(ConnectorDegradedError);
    g.set({ status: "revoked" });
    expect(() => authorizeWrite(g, ctx(), token(), exp)).toThrow(ConnectorDegradedError);
  });
  it("refuses forged / out-of-scope tokens", () => {
    expect(() => authorizeWrite(new HealthGate(), ctx(), token({ resourceScope: "repo:other" }), exp)).toThrow(WriteNotAuthorizedError);
    expect(() => authorizeWrite(new HealthGate(), ctx(), "garbage", exp)).toThrow(WriteNotAuthorizedError);
  });
});

describe("withRetry", () => {
  it("retries 429/5xx with backoff then succeeds", async () => {
    const seq = [429, 503, 200]; const waits: number[] = [];
    const r = await withRetry(async () => res(seq.shift()!), { method: "GET", url: "x" }, new HealthGate(), { sleep: async (ms) => { waits.push(ms); } });
    expect(r.status).toBe(200); expect(waits).toEqual([500, 1000]);
  });
  it("gives up after retries", async () => {
    const r = await withRetry(async () => res(500), { method: "GET", url: "x" }, new HealthGate(), { retries: 2, sleep: async () => {} });
    expect(r.status).toBe(500);
  });
  it("401 marks connector degraded without retrying", async () => {
    const g = new HealthGate(); let calls = 0;
    await withRetry(async () => { calls++; return res(401); }, { method: "GET", url: "x" }, g);
    expect(calls).toBe(1); expect(g.current.status).toBe("degraded");
  });
});
