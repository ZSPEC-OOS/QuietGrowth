import { describe, expect, it } from "vitest";
import { WebhookSignatureError, normalizeStripeEvent, reconcileSubscriptions, signStripePayload, totalMrrCents, verifyStripeSignature, type RevenueEvent } from "./index.js";

const secret = "whsec_test";
describe("verifyStripeSignature", () => {
  const body = '{"id":"evt_1"}';
  it("accepts a valid signature within tolerance", () => {
    expect(() => verifyStripeSignature(body, signStripePayload(body, secret, 1000), secret, 1100)).not.toThrow();
  });
  it.each([
    ["tampered body", () => verifyStripeSignature(body + " ", signStripePayload(body, secret, 1000), secret, 1000)],
    ["wrong secret", () => verifyStripeSignature(body, signStripePayload(body, "x", 1000), secret, 1000)],
    ["stale timestamp (replay)", () => verifyStripeSignature(body, signStripePayload(body, secret, 1000), secret, 5000)],
    ["malformed header", () => verifyStripeSignature(body, "garbage", secret, 1000)],
  ])("rejects %s", (_n, fn) => { expect(fn).toThrow(WebhookSignatureError); });
});

const sub = (id: string, created: number, type: string, extra: any = {}) => ({ id, type, created, data: { object: { id: "sub_1", customer: "cus_1", items: { data: [{ price: { id: "price_a", unit_amount: 1200, recurring: { interval: "year", interval_count: 1 } }, quantity: 2 }] }, ...extra } } });

describe("normalizeStripeEvent", () => {
  it("normalises annual plans to monthly MRR (1200c/yr x2 = 200c/mo)", () => {
    const e = normalizeStripeEvent(sub("e1", 100, "customer.subscription.created"))!;
    expect(e.kind).toBe("subscription_started"); expect(e.mrrCents).toBe(200);
  });
  it("distinguishes involuntary churn; ignores unknown and non-plan updates", () => {
    expect(normalizeStripeEvent(sub("e2", 1, "customer.subscription.deleted", { cancellation_details: { reason: "payment_failed" } }))!.kind).toBe("involuntary_churn");
    expect(normalizeStripeEvent(sub("e3", 1, "customer.subscription.deleted"))!.kind).toBe("subscription_cancelled");
    expect(normalizeStripeEvent(sub("e4", 1, "customer.subscription.updated"))).toBeNull();
    expect(normalizeStripeEvent(sub("e5", 1, "ping"))).toBeNull();
  });
});

describe("reconcileSubscriptions", () => {
  const ev = (providerEventId: string, kind: RevenueEvent["kind"], occurredAt: number, mrrCents?: number): RevenueEvent => ({ providerEventId, kind, customerId: "c", subscriptionId: "s", amountCents: 0, occurredAt, mrrCents });
  const events = [ev("1", "subscription_started", 10, 1000), ev("2", "plan_changed", 20, 3000), ev("3", "subscription_cancelled", 30)];
  it("converges regardless of arrival order and de-duplicates replays", () => {
    const a = reconcileSubscriptions(events), b = reconcileSubscriptions([...events].reverse()), c = reconcileSubscriptions([...events, events[1]!]);
    expect(b).toEqual(a); expect(c).toEqual(a);
    expect(a.get("s")!.status).toBe("cancelled");
    expect(totalMrrCents(a)).toBe(0);
  });
  it("sums MRR over active subscriptions", () => {
    expect(totalMrrCents(reconcileSubscriptions(events.slice(0, 2)))).toBe(3000);
  });
});
