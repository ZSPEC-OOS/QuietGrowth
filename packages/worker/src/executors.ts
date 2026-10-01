import type { PoolClient } from "pg";
import { withOrg } from "@quietgrowth/database";
import type { ActionRecord, Executor, Verifier } from "@quietgrowth/growth-engine";
import type { WriteReceipt } from "@quietgrowth/connectors-core";
import type { Verification } from "@quietgrowth/verification";
import { EmailConnector, SendBlockedError, hashEmail } from "@quietgrowth/connector-email";
import { scopeForSeo } from "@quietgrowth/acquisition";
import type { Pool } from "pg";

const SEO_TYPES = new Set(["metadata_change", "internal_link_change", "content_refresh", "new_intent_page"]);
export const isSeoType = (t: string): boolean => SEO_TYPES.has(t);
export const isLifecycleType = (t: string): boolean => t === "lifecycle_email_existing_users";

export const scopeFor = (a: ActionRecord): string => isSeoType(a.type) ? scopeForSeo(a) : isLifecycleType(a.type) ? `email:${(a.payload as { segment: string }).segment}` : `action:${a.id}`;

/** Routes by action type. Unknown types have no executor: fail closed. */
export class CompositeExecutor implements Executor {
  constructor(private readonly seo: Executor, private readonly lifecycle: Executor) {}
  async execute(a: ActionRecord, token: string): Promise<WriteReceipt> {
    if (isSeoType(a.type)) return this.seo.execute(a, token);
    if (isLifecycleType(a.type)) return this.lifecycle.execute(a, token);
    throw new Error(`no executor registered for action type ${a.type}`);
  }
}

export class CompositeVerifier implements Verifier {
  constructor(private readonly seo: Verifier, private readonly lifecycle: Verifier) {}
  async verify(a: ActionRecord, r: WriteReceipt): Promise<Verification> {
    if (isSeoType(a.type)) return this.seo.verify(a, r);
    if (isLifecycleType(a.type)) return this.lifecycle.verify(a, r);
    return { ok: false, checks: [{ name: "no_verifier_for_type", ok: false, detail: a.type }] };
  }
}

/** Sends the campaign to each segment member via the email connector. Per-recipient idempotency keys make retries safe. */
export class LifecycleExecutor implements Executor {
  constructor(
    private readonly pool: Pool,
    private readonly email: (orgId: string) => Promise<EmailConnector>,
    private readonly tokenFor: (a: ActionRecord, recipientKey: string) => string,
    private readonly unsubscribeUrl: (orgId: string, emailHash: string) => string,
  ) {}

  private async emailsFor(c: PoolClient, orgId: string, subjects: string[]): Promise<string[]> {
    const r = await c.query(
      `SELECT DISTINCT ON (subj) subj, properties->>'email' AS email FROM (SELECT COALESCE(user_id, anonymous_id) AS subj, properties, occurred_at FROM conversion_events WHERE organization_id=$1 AND properties ? 'email') x
        WHERE subj = ANY($2) ORDER BY subj, occurred_at DESC`, [orgId, subjects]);
    return r.rows.map((x) => x.email as string).filter((e) => /^[^@\s]+@[^@\s]+$/.test(e));
  }

  async execute(a: ActionRecord, _token: string): Promise<WriteReceipt> {
    const p = a.payload as { segment: string; subjectIds: string[]; subject: string; text: string };
    const emails = await withOrg(this.pool, a.orgId, (c) => this.emailsFor(c, a.orgId, p.subjectIds));
    const conn = await this.email(a.orgId);
    let sent = 0; const blocked: Record<string, number> = {};
    for (const to of emails) {
      const h = hashEmail(to);
      try {
        await conn.send({ to, subject: p.subject, text: p.text, segment: p.segment, unsubscribeUrl: this.unsubscribeUrl(a.orgId, h) }, this.tokenFor(a, h), { actionId: a.id, policyVersion: a.policyVersion });
        sent++;
      } catch (e) {
        if (e instanceof SendBlockedError) blocked[e.reason] = (blocked[e.reason] ?? 0) + 1; else throw e;
      }
    }
    return { provider: "email", resourceId: `campaign:${p.segment}:${a.id.slice(0, 8)}`, idempotencyKey: a.idempotencyKey, at: Date.now(), detail: { sent, blocked, candidates: emails.length } };
  }
}

/** Verifies a campaign: something was sent (or every candidate was legitimately blocked) and nothing breached suppression. */
export class LifecycleVerifier implements Verifier {
  async verify(_a: ActionRecord, r: WriteReceipt): Promise<Verification> {
    const d = (r.detail ?? {}) as { sent?: number; blocked?: Record<string, number>; candidates?: number };
    const blockedTotal = Object.values(d.blocked ?? {}).reduce((x, y) => x + y, 0);
    const checks = [
      { name: "all_candidates_accounted_for", ok: (d.sent ?? 0) + blockedTotal === (d.candidates ?? -1) },
      { name: "sent_or_legitimately_blocked", ok: (d.sent ?? 0) > 0 || ((d.candidates ?? 0) > 0 && blockedTotal === d.candidates) }, // an empty campaign is a failure to surface, not a success
    ];
    return { ok: checks.every((c) => c.ok), checks };
  }
}
