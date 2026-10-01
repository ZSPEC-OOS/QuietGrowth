# Security notes

Controls and the tests that enforce them. This is an engineering summary, not an external audit. MR §22.4 requires an independent review before public launch.

| Area | Control | Evidence |
|---|---|---|
| Tenant isolation (DB) | Forced RLS on every `organization_id` table, fail-closed when no tenant is bound; SECURITY DEFINER helpers expose only org ids for API keys and memberships | `packages/database/src/identity.test.ts` (schema-wide invariant) |
| Tenant isolation (runtime) | Cell per org; contract org must match the cell; hardened container flags; pinned images | `cell-manager`, `openclaw-client` tests |
| SSRF | Public-address validation on every hop, redirects re-validated, size/redirect caps | `packages/saas-profile` tests, E2E |
| AuthN/Z | scrypt passwords, HMAC session tokens with expiry, role checks (owner/admin/member), httpOnly cookie, constant-time compares | `packages/api` tests, E2E |
| Mutation authorisation | Signed scoped tokens, replay-proof idempotency, health-gated connectors, branch-only repo writes with path allowlist | `policy-engine`, `connectors-core`, `connector-cms` tests |
| Spend | Zero-Spend has no path to external spend (permanent regression suite); paid mode behind a six-condition gate, caps and stop-loss | `growth-engine/src/zero-spend.regression.test.ts`, `connector-google-ads` |
| Cell → control plane | Per-tenant derived internal secret (`HMAC(master, "internal:"+orgId)`): a compromised cell cannot act as another tenant; timing-safe compare | `packages/api` tests (tool router), `packages/admin` provisioning |
| Agent-supplied payloads | Zod validation of SEO payloads, repo coordinates and file paths before any URL or patch is built; branch-only writes under `qg/` | `packages/acquisition`, `packages/connector-cms` tests |
| Prompt injection | Authorisation independent of content; injection corpus across all agents | `openclaw/evals` |
| Webhooks | Stripe signature + replay tolerance; out-of-order/replay convergent reconcile | `connector-billing` tests |
| Email | Suppression, frequency/daily caps, unsubscribe required, per-recipient idempotency | `connector-email`, worker tests |
| Secrets & logs | Sealed at rest, org-bound AAD, redaction of keys/tokens in logs and agent event payloads | `packages/secrets` tests, API tests |
| Web | CSP, frame denial, nosniff, httpOnly cookie; server actions only | E2E |

## Known limitations (do not ship past these without addressing)
- **Action-authorisation replay protection is per process.** `InMemoryIdempotencyStore` resets on restart; a Postgres-backed store (the interface would need to become async) is required for crash-safe replay refusal. Today safety after a restart relies on provider-side idempotency (branch/PR creation returns 422 when it already exists, email receipts are looked up by key).
- **CSP allows inline scripts** (`'unsafe-inline'`) because the app does not yet use nonces with Next.js; tighten with a nonce-based CSP.
- **Sessions are stateless tokens** with a 12h expiry; there is no server-side revocation list (logout clears the cookie only). Add a session table if immediate revocation is required.
- **No rate limiting / lockout** on `/v1/login` and `/v1/signup`; put a gateway rate limiter in front or add one.
- **No CSRF token beyond SameSite=Lax + server actions.** Review before exposing state-changing GET routes (there are none today).
- **Secret master key rotation** is not implemented (single key; re-encryption job needed).
- **OpenClaw wire protocol and plugin registration are unverified** against a live install (see STATUS).
- **DB roles:** production must run the API as a non-superuser that can `SET ROLE qg_app`; superusers bypass RLS. The test suites run as superuser and verify policy behaviour through `SET ROLE`.
- Browser-reachable SSRF protection depends on resolving DNS before connecting; a DNS-rebinding window between validation and connection remains unless egress is also network-restricted (the cell config and deployment should enforce this at the network layer).
