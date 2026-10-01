import { createHmac, timingSafeEqual } from "node:crypto";

// Stripe-first billing adapter, MR §12.1 P0. Normalises provider events to revenue/subscription facts.
export class WebhookSignatureError extends Error {}

/** Verifies a Stripe-Signature header (t=timestamp,v1=hmac) with replay tolerance. */
export function verifyStripeSignature(rawBody: string, header: string, secret: string, nowSec: number, toleranceSec = 300): void {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts["t"]);
  const v1s = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!Number.isFinite(t) || v1s.length === 0) throw new WebhookSignatureError("malformed signature header");
  if (Math.abs(nowSec - t) > toleranceSec) throw new WebhookSignatureError("timestamp outside tolerance");
  const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const ok = v1s.some((s) => { const g = Buffer.from(s, "hex"); return g.length === want.length && timingSafeEqual(g, want); });
  if (!ok) throw new WebhookSignatureError("signature mismatch");
}

export function signStripePayload(rawBody: string, secret: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

export type RevenueKind = "subscription_started" | "plan_changed" | "subscription_cancelled" | "payment_succeeded" | "payment_failed" | "refund" | "involuntary_churn";

export interface RevenueEvent { providerEventId: string; kind: RevenueKind; customerId: string; subscriptionId?: string; amountCents: number; occurredAt: number; plan?: string; mrrCents?: number }

interface StripeEvent { id: string; type: string; created: number; data: { object: Record<string, any> } }

const monthlyCents = (item: any): number => {
  const unit = item?.price?.unit_amount ?? item?.plan?.amount ?? 0;
  const qty = item?.quantity ?? 1;
  const interval = item?.price?.recurring?.interval ?? item?.plan?.interval ?? "month";
  const count = item?.price?.recurring?.interval_count ?? 1;
  const perMonth = interval === "year" ? 1 / (12 * count) : interval === "week" ? 52 / 12 / count : interval === "day" ? 365 / 12 / count : 1 / count;
  return Math.round(unit * qty * perMonth);
};

/** Maps a Stripe event to zero or one normalised revenue event. Unknown types are ignored. */
export function normalizeStripeEvent(e: StripeEvent): RevenueEvent | null {
  const o = e.data.object;
  const base = { providerEventId: e.id, occurredAt: e.created * 1000 };
  switch (e.type) {
    case "customer.subscription.created":
      return { ...base, kind: "subscription_started", customerId: o.customer, subscriptionId: o.id, amountCents: 0, plan: o.items?.data?.[0]?.price?.id, mrrCents: (o.items?.data ?? []).reduce((a: number, i: any) => a + monthlyCents(i), 0) };
    case "customer.subscription.updated": {
      const prev = e.data as any;
      return prev.previous_attributes?.items
        ? { ...base, kind: "plan_changed", customerId: o.customer, subscriptionId: o.id, amountCents: 0, plan: o.items?.data?.[0]?.price?.id, mrrCents: (o.items?.data ?? []).reduce((a: number, i: any) => a + monthlyCents(i), 0) }
        : null;
    }
    case "customer.subscription.deleted":
      return { ...base, kind: o.cancellation_details?.reason === "payment_failed" ? "involuntary_churn" : "subscription_cancelled", customerId: o.customer, subscriptionId: o.id, amountCents: 0 };
    case "invoice.payment_succeeded":
      return { ...base, kind: "payment_succeeded", customerId: o.customer, subscriptionId: o.subscription, amountCents: o.amount_paid ?? 0 };
    case "invoice.payment_failed":
      return { ...base, kind: "payment_failed", customerId: o.customer, subscriptionId: o.subscription, amountCents: o.amount_due ?? 0 };
    case "charge.refunded":
      return { ...base, kind: "refund", customerId: o.customer, amountCents: o.amount_refunded ?? 0 };
    default:
      return null;
  }
}

export interface SubscriptionState { subscriptionId: string; customerId: string; status: "active" | "cancelled" | "churned_involuntary"; plan?: string; mrrCents: number; startedAt?: number; cancelledAt?: number; lastEventAt: number }

/**
 * Folds events into subscription state independent of arrival order: each field is
 * resolved by event time, so out-of-order or replayed webhooks converge (MR §27 reconcile).
 */
export function reconcileSubscriptions(events: RevenueEvent[]): Map<string, SubscriptionState> {
  const out = new Map<string, SubscriptionState>();
  const seen = new Set<string>();
  for (const e of [...events].sort((a, b) => a.occurredAt - b.occurredAt || a.providerEventId.localeCompare(b.providerEventId))) {
    if (seen.has(e.providerEventId) || !e.subscriptionId) continue;
    seen.add(e.providerEventId);
    const s = out.get(e.subscriptionId) ?? { subscriptionId: e.subscriptionId, customerId: e.customerId, status: "active" as const, mrrCents: 0, lastEventAt: 0 };
    if (e.kind === "subscription_started") { s.startedAt ??= e.occurredAt; s.status = "active"; s.mrrCents = e.mrrCents ?? s.mrrCents; s.plan = e.plan ?? s.plan; }
    if (e.kind === "plan_changed") { s.mrrCents = e.mrrCents ?? s.mrrCents; s.plan = e.plan ?? s.plan; }
    if (e.kind === "subscription_cancelled") { s.status = "cancelled"; s.cancelledAt = e.occurredAt; s.mrrCents = 0; }
    if (e.kind === "involuntary_churn") { s.status = "churned_involuntary"; s.cancelledAt = e.occurredAt; s.mrrCents = 0; }
    s.lastEventAt = Math.max(s.lastEventAt, e.occurredAt);
    out.set(e.subscriptionId, s);
  }
  return out;
}

export const totalMrrCents = (subs: Map<string, SubscriptionState>): number => [...subs.values()].reduce((a, s) => a + s.mrrCents, 0);
