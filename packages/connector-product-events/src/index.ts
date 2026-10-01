import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

// Product event ingestion, MR §12.3: idempotent, server-side events, identity merge, schema versioning.
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;

export interface IncomingEvent {
  anonymousId?: string; userId?: string; event: string; timestamp: string;
  properties?: Record<string, unknown>;
  context?: { source?: string; sessionId?: string; [k: string]: unknown };
  messageId?: string; schemaVersion?: number;
}
export interface ValidEvent { idempotencyKey: string; anonymousId: string | null; userId: string | null; event: string; occurredAt: Date; properties: Record<string, unknown>; context: Record<string, unknown>; schemaVersion: number }

export function validateEvent(e: IncomingEvent, now = Date.now()): { ok: true; event: ValidEvent } | { ok: false; error: string } {
  if (!e || typeof e.event !== "string" || !/^[a-z][a-z0-9_]{0,63}$/i.test(e.event)) return { ok: false, error: "invalid event name" };
  if (!e.anonymousId && !e.userId) return { ok: false, error: "anonymousId or userId required" };
  const t = Date.parse(e.timestamp);
  if (!Number.isFinite(t)) return { ok: false, error: "invalid timestamp" };
  if (t > now + 5 * 60_000) return { ok: false, error: "timestamp in the future" };
  const schemaVersion = e.schemaVersion ?? 1;
  if (!(SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(schemaVersion)) return { ok: false, error: `unsupported schema version ${schemaVersion}` };
  const properties = upgradeProperties(e.properties ?? {}, schemaVersion);
  // Without a client message id, derive a stable key so retries of the same payload dedupe.
  const idempotencyKey = e.messageId ?? createHash("sha256").update(JSON.stringify([e.userId ?? "", e.anonymousId ?? "", e.event, t, e.properties ?? {}])).digest("hex");
  return { ok: true, event: { idempotencyKey, anonymousId: e.anonymousId ?? null, userId: e.userId ?? null, event: e.event, occurredAt: new Date(t), properties, context: e.context ?? {}, schemaVersion } };
}

/** v1 used `plan_name`; v2 uses `plan`. Normalise to v2 shape at ingestion. */
function upgradeProperties(p: Record<string, unknown>, v: number): Record<string, unknown> {
  if (v === 1 && "plan_name" in p) { const { plan_name, ...rest } = p; return { ...rest, plan: plan_name }; }
  return p;
}

export interface IngestResult { accepted: number; duplicates: number; rejected: { index: number; error: string }[] }

/** Writes a batch through a tenant-bound client (see `withOrg`). */
export async function ingestEvents(c: PoolClient, orgId: string, events: IncomingEvent[], now = Date.now()): Promise<IngestResult> {
  const res: IngestResult = { accepted: 0, duplicates: 0, rejected: [] };
  for (const [index, raw] of events.entries()) {
    const v = validateEvent(raw, now);
    if (!v.ok) { res.rejected.push({ index, error: v.error }); continue; }
    const e = v.event;
    const r = await c.query(
      `INSERT INTO conversion_events (organization_id, idempotency_key, anonymous_id, user_id, event, occurred_at, properties, context, schema_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      [orgId, e.idempotencyKey, e.anonymousId, e.userId, e.event, e.occurredAt, e.properties, e.context, e.schemaVersion],
    );
    if (r.rowCount === 0) { res.duplicates++; continue; }
    res.accepted++;
    // Identity merge: first link wins; a conflicting later link is ignored, never overwritten.
    if (e.anonymousId && e.userId)
      await c.query(`INSERT INTO identity_links (organization_id, anonymous_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [orgId, e.anonymousId, e.userId]);
  }
  return res;
}

/** Resolved subject id per event: linked user id, else user id, else anonymous id. */
export async function resolvedEvents(c: PoolClient, orgId: string, since: Date): Promise<{ subjectId: string; event: string; at: number }[]> {
  const r = await c.query(
    `SELECT COALESCE(e.user_id, l.user_id, e.anonymous_id) AS subject_id, e.event, e.occurred_at
       FROM conversion_events e LEFT JOIN identity_links l ON l.organization_id = e.organization_id AND l.anonymous_id = e.anonymous_id
      WHERE e.organization_id = $1 AND e.occurred_at >= $2 ORDER BY e.occurred_at`,
    [orgId, since],
  );
  return r.rows.map((x) => ({ subjectId: x.subject_id, event: x.event, at: new Date(x.occurred_at).getTime() }));
}
