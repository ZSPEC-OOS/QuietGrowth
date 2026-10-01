import "server-only";

/**
 * Transport to the QuietGrowth control-plane API.
 *
 * Default (single deployment): the Fastify app runs **in-process** and is called with `inject`, so server components,
 * server actions and the public /api route share one instance, one DB pool and no network hop.
 * If API_URL is set, requests go to that remote API instead (split deployment); nothing else changes.
 */
export interface BackendRequest { method: "GET" | "POST"; path: string; headers?: Record<string, string>; body?: string }
export interface BackendResponse { status: number; contentType: string; text: string }

export class BackendUnavailableError extends Error { override name = "BackendUnavailableError"; }
/** Name-based check: stays correct even if the class is duplicated across bundles. */
export const isBackendUnavailable = (e: unknown): boolean => e instanceof Error && e.name === "BackendUnavailableError";

type Booted = { app: { inject(o: { method: string; url: string; headers?: Record<string, string>; payload?: string }): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> } };
const g = globalThis as unknown as { __qgBoot?: Promise<Booted> };

function boot(): Promise<Booted> {
  // Cached on globalThis so the route handler and server components (separate bundles) share one instance.
  g.__qgBoot ??= import("@quietgrowth/api/production")
    .then((m) => m.createProductionApp(process.env) as unknown as Promise<Booted>)
    .catch((e: unknown) => {
      g.__qgBoot = undefined; // a failed boot is retried on the next request, never cached
      console.error("QuietGrowth API failed to start:", e instanceof Error ? e.message : e); // details stay in server logs
      throw new BackendUnavailableError("backend unavailable");
    });
  return g.__qgBoot;
}

export async function backend(r: BackendRequest): Promise<BackendResponse> {
  const remote = process.env.API_URL;
  if (remote) {
    let res: Response;
    try { res = await fetch(`${remote.replace(/\/$/, "")}${r.path}`, { method: r.method, headers: r.headers, body: r.body, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(55_000) }); }
    catch { throw new BackendUnavailableError("backend unavailable"); }
    return { status: res.status, contentType: res.headers.get("content-type") ?? "application/json", text: await res.text() };
  }
  const { app } = await boot();
  const res = await app.inject({ method: r.method, url: r.path, headers: r.headers, payload: r.body });
  return { status: res.statusCode, contentType: String(res.headers["content-type"] ?? "application/json"), text: res.body };
}
