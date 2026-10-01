import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.fn();
vi.mock("./backend", () => ({ backend: (...a: unknown[]) => backend(...a), isBackendUnavailable: (e: unknown) => e instanceof Error && e.name === "BackendUnavailableError" }));
import { proxyApiRequest } from "./proxy";

const req = (method: string, url: string, init: RequestInit = {}) => new Request(`http://app${url}`, { method, ...init });
beforeEach(() => { backend.mockReset(); }); // braces: a returned function would be run as a teardown hook

describe("proxyApiRequest", () => {
  it("maps the /api path, forwards only allowlisted headers, and marks responses uncacheable", async () => {
    backend.mockResolvedValue({ status: 201, contentType: "application/json", text: '{"ok":1}' });
    const r = await proxyApiRequest(req("POST", "/api/v1/api-keys?x=1", { body: '{"a":1}', headers: { authorization: "Bearer t", "content-type": "application/json", cookie: "qg_session=secret", "x-forwarded-for": "1.2.3.4", "x-internal-secret": "s" } }), ["v1", "api-keys"]);
    expect(backend).toHaveBeenCalledWith({ method: "POST", path: "/v1/api-keys?x=1", headers: { authorization: "Bearer t", "content-type": "application/json", "x-internal-secret": "s" }, body: '{"a":1}' });
    expect(r.status).toBe(201); expect(r.headers.get("cache-control")).toBe("no-store"); expect(await r.text()).toBe('{"ok":1}');
  });
  it("re-encodes path segments so they cannot smuggle extra path or query components", async () => {
    backend.mockResolvedValue({ status: 200, contentType: "application/json", text: "{}" });
    await proxyApiRequest(req("GET", "/api/x"), ["a/b", "c?d=1", "..%2f"]);
    expect(backend.mock.calls[0]![0].path).toBe("/a%2Fb/c%3Fd%3D1/..%252f");
  });
  it("rejects other methods and oversized bodies before touching the backend", async () => {
    expect((await proxyApiRequest(req("DELETE", "/api/x"), ["x"])).status).toBe(405);
    expect((await proxyApiRequest(req("POST", "/api/x", { body: "{}", headers: { "content-length": "2000000" } }), ["x"])).status).toBe(413);
    expect((await proxyApiRequest(req("POST", "/api/x", { body: "x".repeat(1_000_001) }), ["x"])).status).toBe(413);
    expect(backend).not.toHaveBeenCalled();
  });
  it("turns an unavailable backend into a generic 503", async () => {
    backend.mockImplementation(async () => { throw Object.assign(new Error("db password in message"), { name: "BackendUnavailableError" }); });
    const r = await proxyApiRequest(req("GET", "/api/healthz"), ["healthz"]);
    expect(r.status).toBe(503); expect(await r.text()).toBe('{"error":"service_unavailable"}');
  });
  it("does not swallow unexpected errors", async () => { backend.mockImplementation(async () => { throw new Error("bug"); }); await expect(proxyApiRequest(req("GET", "/api/x"), ["x"])).rejects.toThrow("bug"); });
});
