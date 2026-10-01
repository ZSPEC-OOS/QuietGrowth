import { createHash } from "node:crypto";
import { authorizeWrite, HealthGate, type AuthContext, type HttpClient, type WriteReceipt } from "@quietgrowth/connectors-core";

// Lifecycle email connector, MR §10.3. Enforces suppression, frequency caps and idempotency.
export const hashEmail = (email: string): string => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

export interface EmailMessage { to: string; subject: string; text: string; html?: string; segment: string; unsubscribeUrl: string }

export interface SendState {
  isSuppressed(emailHash: string): Promise<boolean>;
  sendsInLast(emailHash: string, windowMs: number): Promise<number>;
  sendsToday(): Promise<number>;
  receiptForKey(idempotencyKey: string): Promise<WriteReceipt | undefined>;
  record(emailHash: string, receipt: WriteReceipt): Promise<void>;
}

export interface EmailCaps { perRecipientPerWeek: number; perDay: number }
export class SendBlockedError extends Error { constructor(readonly reason: "suppressed" | "frequency_cap" | "daily_cap" | "missing_unsubscribe") { super(`send blocked: ${reason}`); } }

export interface EmailProvider { send(m: EmailMessage, idempotencyKey: string): Promise<{ id: string }> }

export class EmailConnector {
  readonly provider = "email";
  readonly gate = new HealthGate();
  constructor(private readonly p: EmailProvider, private readonly state: SendState, private readonly caps: EmailCaps, private readonly auth: AuthContext) {}

  async send(m: EmailMessage, token: string, ctx: { actionId: string; policyVersion: string }): Promise<WriteReceipt> {
    const a = authorizeWrite(this.gate, this.auth, token, { ...ctx, resourceScope: `email:${m.segment}` });
    const dup = await this.state.receiptForKey(a.idempotencyKey);
    if (dup) return dup; // idempotent replay: never double-send
    if (!m.unsubscribeUrl) throw new SendBlockedError("missing_unsubscribe");
    const h = hashEmail(m.to);
    if (await this.state.isSuppressed(h)) throw new SendBlockedError("suppressed");
    if ((await this.state.sendsInLast(h, 7 * 86_400_000)) >= this.caps.perRecipientPerWeek) throw new SendBlockedError("frequency_cap");
    if ((await this.state.sendsToday()) >= this.caps.perDay) throw new SendBlockedError("daily_cap");
    const { id } = await this.p.send(m, a.idempotencyKey);
    const receipt: WriteReceipt = { provider: "email", resourceId: id, idempotencyKey: a.idempotencyKey, at: this.auth.now() };
    await this.state.record(h, receipt);
    return receipt;
  }
}

/** Resend-style HTTP provider. The provider choice is an open owner decision; swap this class only. */
export class HttpEmailProvider implements EmailProvider {
  constructor(private readonly http: HttpClient, private readonly apiKey: string, private readonly from: string, private readonly endpoint = "https://api.resend.com/emails") {}
  async send(m: EmailMessage, idempotencyKey: string): Promise<{ id: string }> {
    const r = await this.http({
      method: "POST", url: this.endpoint,
      headers: { authorization: `Bearer ${this.apiKey}`, "idempotency-key": idempotencyKey },
      body: { from: this.from, to: [m.to], subject: m.subject, text: m.text, html: m.html, headers: { "List-Unsubscribe": `<${m.unsubscribeUrl}>` } },
    });
    const id = (r.json as { id?: string } | null)?.id;
    if (r.status >= 300 || !id) throw new Error(`email provider error ${r.status}`);
    return { id };
  }
}

/** Deterministic lifecycle segmentation from first-party facts (MR §10.3). The model never decides membership. */
export type LifecycleSegment = "new_signup" | "not_activated" | "activated_not_paid" | "trial_ending" | "dormant" | "churn_risk" | "cancelled" | "reactivated";
export interface UserFacts { signedUpAt: number; activatedAt?: number; paidAt?: number; trialEndsAt?: number; lastActiveAt?: number; cancelledAt?: number; reactivatedAt?: number; activityTrend7d?: number }

export function segmentsFor(u: UserFacts, now: number): LifecycleSegment[] {
  const d = 86_400_000, out: LifecycleSegment[] = [];
  if (u.reactivatedAt && (!u.cancelledAt || u.reactivatedAt > u.cancelledAt)) return ["reactivated"];
  if (u.cancelledAt) return ["cancelled"];
  if (!u.activatedAt) out.push(now - u.signedUpAt <= 2 * d ? "new_signup" : "not_activated");
  if (u.activatedAt && !u.paidAt) out.push("activated_not_paid");
  if (u.trialEndsAt && !u.paidAt && u.trialEndsAt - now > 0 && u.trialEndsAt - now <= 3 * d) out.push("trial_ending");
  if (u.paidAt && u.lastActiveAt !== undefined && now - u.lastActiveAt > 14 * d) out.push("dormant");
  if (u.paidAt && u.activityTrend7d !== undefined && u.activityTrend7d <= -0.5) out.push("churn_risk");
  return out;
}
