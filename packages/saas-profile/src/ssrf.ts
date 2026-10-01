// SSRF-safe URL validation for crawlers (MR §20.1 security tests).
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  return true; // not an IP: caller must resolve first; treat as unsafe
}

export type Resolver = (host: string) => Promise<string[]>;

/** Validates scheme, port, credentials and that every resolved address is public. */
export async function assertPublicUrl(raw: string, resolve: Resolver): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UnsafeUrlError("invalid url"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UnsafeUrlError("scheme not allowed");
  if (u.username || u.password) throw new UnsafeUrlError("credentials in url not allowed");
  if (u.port && !["80", "443"].includes(u.port)) throw new UnsafeUrlError("port not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new UnsafeUrlError("host not allowed");
  const addrs = isIP(host) ? [host] : await resolve(host);
  if (addrs.length === 0) throw new UnsafeUrlError("host did not resolve");
  if (addrs.some(isPrivateAddress)) throw new UnsafeUrlError("address not public");
  return u;
}

export interface SafeFetchOptions { resolve: Resolver; fetchImpl: (url: string) => Promise<{ status: number; headers: Record<string, string>; body: string }>; maxRedirects?: number; maxBytes?: number }

/** Follows redirects manually, re-validating every hop; enforces a response size cap. */
export async function safeFetch(url: string, o: SafeFetchOptions): Promise<{ status: number; headers: Record<string, string>; body: string; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= (o.maxRedirects ?? 3); hop++) {
    const u = await assertPublicUrl(current, o.resolve);
    const r = await o.fetchImpl(u.toString());
    if (r.status >= 300 && r.status < 400 && r.headers["location"]) {
      current = new URL(r.headers["location"], u).toString();
      continue;
    }
    if (r.body.length > (o.maxBytes ?? 2_000_000)) throw new UnsafeUrlError("response too large");
    return { ...r, finalUrl: u.toString() };
  }
  throw new UnsafeUrlError("too many redirects");
}
