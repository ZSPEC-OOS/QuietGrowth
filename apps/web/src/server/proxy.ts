import "server-only";
import { backend, isBackendUnavailable } from "./backend";

const MAX_BODY = 1_000_000; // matches the API's own limit; reject early without buffering more
const FORWARD = ["authorization", "content-type", "x-internal-secret", "user-agent"];

/** Public /api/* adapter: web Request in, web Response out. Only an allowlist of headers crosses the boundary. */
export async function proxyApiRequest(req: Request, segments: string[]): Promise<Response> {
  const method = req.method === "GET" ? "GET" : req.method === "POST" ? "POST" : null;
  if (!method) return json(405, { error: "method_not_allowed" }, { allow: "GET, POST" });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) return json(413, { error: "payload_too_large" });

  const path = "/" + segments.map(encodeURIComponent).join("/") + new URL(req.url).search;
  const headers: Record<string, string> = {};
  for (const h of FORWARD) { const v = req.headers.get(h); if (v) headers[h] = v; }
  const body = method === "POST" ? await req.text() : undefined;
  if (body !== undefined && body.length > MAX_BODY) return json(413, { error: "payload_too_large" });

  try {
    const r = await backend({ method, path, headers, body });
    return new Response(r.text, { status: r.status, headers: { "content-type": r.contentType, "cache-control": "no-store" } });
  } catch (e) {
    if (isBackendUnavailable(e)) return json(503, { error: "service_unavailable" });
    throw e;
  }
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
