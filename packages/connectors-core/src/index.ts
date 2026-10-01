import { verifyAuthorization, type IdempotencyStore, type VerifyResult } from "@quietgrowth/policy-engine";

// Connector contract, MR §12.2, with health gating (MR §27).
export type HealthStatus = "healthy" | "degraded" | "revoked";
export interface Health { status: HealthStatus; detail?: string }
export interface ConnectorResult<T = unknown> { data: T; fetchedAt: number }
export interface WriteReceipt { provider: string; resourceId: string; idempotencyKey: string; at: number; detail?: Record<string, unknown> }

export interface Connector<TRead, TWrite, TData = unknown> {
  readonly provider: string;
  test(connectionId: string): Promise<Health>;
  read(request: TRead): Promise<ConnectorResult<TData>>;
  write(request: TWrite, authorization: string): Promise<WriteReceipt>;
  revoke(connectionId: string): Promise<void>;
}

export interface HttpRequest { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers?: Record<string, string>; body?: unknown }
export interface HttpResponse { status: number; headers: Record<string, string>; json: unknown; text: string }
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

/** Default HttpClient over global fetch. */
export const fetchClient: HttpClient = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: { ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...req.headers },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), json, text };
};

export class ConnectorDegradedError extends Error {}
export class WriteNotAuthorizedError extends Error {
  constructor(readonly reason: string) { super(`write not authorized: ${reason}`); }
}

/** Tracks health; a degraded or revoked connector refuses all writes. */
export class HealthGate {
  private status: Health = { status: "healthy" };
  get current(): Health { return this.status; }
  set(h: Health): void { this.status = h; }
  assertWritable(): void {
    if (this.status.status !== "healthy") throw new ConnectorDegradedError(`connector ${this.status.status}: ${this.status.detail ?? ""}`);
  }
}

export interface AuthContext { secret: string; store: IdempotencyStore; now: () => number }

/** Every connector write goes through here: health gate, then signed authorization bound to the scope. */
export function authorizeWrite(gate: HealthGate, ctx: AuthContext, token: string, expect: { actionId: string; policyVersion: string; resourceScope: string }): Extract<VerifyResult, { ok: true }>["auth"] {
  gate.assertWritable();
  const r = verifyAuthorization(token, ctx.secret, { ...expect, now: ctx.now() }, ctx.store);
  if (!r.ok) throw new WriteNotAuthorizedError(r.reason);
  return r.auth;
}

/** Retry with exponential backoff for 429/5xx; token-expiry (401) marks the connector degraded. */
export async function withRetry(http: HttpClient, req: HttpRequest, gate: HealthGate, opts: { retries?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<HttpResponse> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const res = await http(req);
    if (res.status === 401 || res.status === 403) {
      gate.set({ status: "degraded", detail: `auth failed (${res.status}); owner reconnect required` });
      return res;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < (opts.retries ?? 3)) {
      await sleep(Math.min(30_000, 2 ** attempt * 500));
      continue;
    }
    return res;
  }
}
