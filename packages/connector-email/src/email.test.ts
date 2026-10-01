import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore, signAuthorization } from "@quietgrowth/policy-engine";
import type { WriteReceipt } from "@quietgrowth/connectors-core";
import { EmailConnector, HttpEmailProvider, SendBlockedError, hashEmail, segmentsFor, type SendState } from "./index.js";

const secret = "s", now = 1_000_000;
const mem = () => {
  const suppressed = new Set<string>(); const sends: { h: string; at: number }[] = []; const receipts = new Map<string, WriteReceipt>();
  const state: SendState = {
    isSuppressed: async (h) => suppressed.has(h),
    sendsInLast: async (h, w) => sends.filter((s) => s.h === h && now - s.at <= w).length,
    sendsToday: async () => sends.length,
    receiptForKey: async (k) => receipts.get(k),
    record: async (h, r) => { sends.push({ h, at: now }); receipts.set(r.idempotencyKey, r); },
  };
  return { state, suppressed, sends };
};
const tok = (k: string) => signAuthorization({ actionId: "a", policyVersion: "v1", resourceScope: "email:new_signup", idempotencyKey: k, expiresAt: now + 1000 }, secret);
const msg = { to: "A@x.com", subject: "s", text: "t", segment: "new_signup", unsubscribeUrl: "https://x/u" };
const setup = (caps = { perRecipientPerWeek: 2, perDay: 100 }) => {
  const m = mem(); let sent = 0;
  const conn = new EmailConnector({ send: async () => ({ id: `m${++sent}` }) }, m.state, caps, { secret, store: new InMemoryIdempotencyStore(), now: () => now });
  return { conn, m, sent: () => sent };
};
const ctx = { actionId: "a", policyVersion: "v1" };

describe("EmailConnector", () => {
  it("sends once and records a receipt keyed by the idempotency key", async () => {
    const { conn, sent } = setup();
    const r = await conn.send(msg, tok("k1"), ctx);
    expect(r.resourceId).toBe("m1"); expect(sent()).toBe(1);
  });
  it("blocks suppressed recipients (case-insensitive hash) and missing unsubscribe", async () => {
    const { conn, m } = setup();
    m.suppressed.add(hashEmail("a@x.com"));
    await expect(conn.send(msg, tok("k2"), ctx)).rejects.toThrow(SendBlockedError);
    await expect(setup().conn.send({ ...msg, unsubscribeUrl: "" }, tok("k3"), ctx)).rejects.toThrow("missing_unsubscribe");
  });
  it("enforces per-recipient and daily caps", async () => {
    const { conn } = setup({ perRecipientPerWeek: 1, perDay: 100 });
    await conn.send(msg, tok("k4"), ctx);
    await expect(conn.send(msg, tok("k5"), ctx)).rejects.toThrow("frequency_cap");
    const d = setup({ perRecipientPerWeek: 9, perDay: 1 });
    await d.conn.send(msg, tok("k6"), ctx);
    await expect(d.conn.send({ ...msg, to: "b@x.com" }, tok("k7"), ctx)).rejects.toThrow("daily_cap");
  });
  it("requires valid authorization and refuses when degraded", async () => {
    const { conn } = setup();
    await expect(conn.send(msg, "bad", ctx)).rejects.toThrow("not authorized");
    conn.gate.set({ status: "degraded" });
    await expect(conn.send(msg, tok("k8"), ctx)).rejects.toThrow("degraded");
  });
  it("HttpEmailProvider passes idempotency key and fails on provider errors", async () => {
    let h: any;
    const ok = new HttpEmailProvider(async (r) => { h = r.headers; return { status: 200, headers: {}, json: { id: "e1" }, text: "" }; }, "key", "from@x.com");
    expect(await ok.send(msg, "idem")).toEqual({ id: "e1" }); expect(h["idempotency-key"]).toBe("idem");
    await expect(new HttpEmailProvider(async () => ({ status: 500, headers: {}, json: null, text: "" }), "k", "f").send(msg, "i")).rejects.toThrow("500");
  });
});

describe("segmentsFor", () => {
  const D = 86_400_000, n = 100 * D;
  it("derives segments deterministically", () => {
    expect(segmentsFor({ signedUpAt: n - D }, n)).toEqual(["new_signup"]);
    expect(segmentsFor({ signedUpAt: n - 10 * D }, n)).toEqual(["not_activated"]);
    expect(segmentsFor({ signedUpAt: 0, activatedAt: 1, trialEndsAt: n + D }, n)).toEqual(["activated_not_paid", "trial_ending"]);
    expect(segmentsFor({ signedUpAt: 0, activatedAt: 1, paidAt: 2, lastActiveAt: n - 20 * D, activityTrend7d: -0.6 }, n)).toEqual(["dormant", "churn_risk"]);
    expect(segmentsFor({ signedUpAt: 0, paidAt: 1, cancelledAt: 5 }, n)).toEqual(["cancelled"]);
    expect(segmentsFor({ signedUpAt: 0, paidAt: 1, cancelledAt: 5, reactivatedAt: 9 }, n)).toEqual(["reactivated"]);
  });
});
