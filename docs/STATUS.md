# Implementation status

Verified in the authoring environment: `pnpm check` (typecheck + **345 tests**, Postgres 16 and Redis available), `pnpm build` (all apps and packages, including `next build`), and a real-stack browser E2E (`node tests/e2e/run.mjs`: Postgres + API + Next.js + headless Chromium, 13/13 steps).

## What is built, by milestone (plan: docs/IMPLEMENTATION_PLAN.md)

| Milestone | Status | Notes |
|---|---|---|
| M0 foundation | **Done**, except spikes | Monorepo, CI, identity schema + forced RLS, SQL migrations, secret store (sealed, Postgres-backed), log redaction. **M0.5 (OpenClaw) and M0.6 (DeepSeek) spikes not run** |
| M1 profile/funnel/cost | **Done** | URL analysis (SSRF-safe), growth contract, completeness evaluator, cost engine + ledger, 5-step onboarding UI |
| M2 policy / runtime bridge | **Done** against fakes | Policy engine, state machine, signed authorisation, approvals, contracts, agent allowlists, tool router, cell manager, OpenClaw adapter behind a transport interface |
| M3 evidence | **Done** against fakes/recorded shapes | Event ingestion + SDK, Stripe (signature, normalise, reconcile), GSC, GA4, GitHub, metrics/attribution, dashboard, readiness gate |
| M4 SEO closed loop | **Done** end-to-end with fakes | detect → propose → policy → PR (branch only) → PR verification → observe → evaluate. Live-page verification stage (post-merge) is implemented in `verification` but not scheduled by the worker |
| M5 activation/lifecycle/experiments | **Done** | Bottleneck + regression detectors, rule-based segments, email connector (suppression/caps/idempotency), experiment evaluation with guardrails and approval-gated winners, native assignment endpoint |
| M6 product-led growth | **Partial** | Opportunity templates (invite, share, integration pages, templates) exist; the PLG facts source returns nothing until product instrumentation provides them, and in-product prompt PRs are not generated |
| M7 hosted beta | **Partial** | Cell provisioning/health/quota/version-drift, admin app (incidents, restart, suspend, provision), entitlements, export/delete. Not built: backups/restore tooling, usage metering for billing QuietGrowth itself |
| M8 paid growth | **Guardrails only** | Gate, caps, bid-change cap, stop-loss, authorisation-bound writes. No live Google Ads API client; `AdsApi` is an interface |

## MR §25 definition of done

| Criterion | State |
|---|---|
| Sign up, add URL + DeepSeek key, define events | Done (UI + API; DeepSeek key stored sealed and testable via `/v1/integrations/deepseek/test`) |
| Connect events, billing, GSC, GA4, repo/CMS | Connectors implemented and tested against fakes; **OAuth connect flows are not built** (credentials are pasted/stored by reference); GA4 is not yet used by the worker |
| Accurate funnel; missing instrumentation explicit | Done |
| Evidence-backed opportunities tied to a funnel stage | Done |
| Policy engine blocks forbidden spend/destructive actions | Done; permanent Zero-Spend regression suite |
| OpenClaw executes ≥1 acquisition workflow with a typed contract | **Not verified**: the engine executes the SEO workflow itself through connectors; the agent path (OpenClaw → tool router → proposal) is implemented but untested against a real OpenClaw |
| Verifier independently confirms the mutation | Done (PR-content verification; live-page checks available) |
| Outcome observed through signup/activation/paid | Done (observational pre/post; experiments for causal results) |
| Receipt, cost estimate, evidence per execution | Done |
| Zero-Spend cannot create external spend | Done |
| Second SaaS onboards without code changes | Supported by design (configuration-driven; two-tenant isolation tested); not yet exercised with two real products |

## Unverified assumptions (must be settled before production)
1. **OpenClaw Gateway wire protocol, plugin registration, and config key names** are QuietGrowth's assumed shape behind `GatewayTransport` / `buildTenantConfig`. Replace after the M0.5 spike.
2. **DeepSeek V4.1 Flash** (`deepseek-flash`), its endpoint and usage fields follow the reference document and the long-standing OpenAI-compatible API; revalidate (M0.6). The rate table is configuration (`DEEPSEEK_RATE_TABLE`), not code.
3. **Docker images** are not built here (no Docker daemon); `docker compose config` validates the compose file only.
4. Stripe/GSC/GA4/GitHub request shapes follow public API documentation and are tested only with fakes; run each against sandbox accounts.

## Vercel readiness
Web (Next.js) and API (Fastify, Build Output API bundle) have Vercel configuration, a queue-free cron tick replaces the BullMQ worker, and a smoke test loads the built function as the launcher would. **No real Vercel deployment was performed**; see docs/VERCEL.md for the first-deploy checks.

## Not implemented (explicit)
OAuth connect flows; scheduled post-merge live verification; ad/Google Ads client; helpdesk connector (P2); object storage use (MinIO is provisioned but unused); OpenTelemetry/error-tracker wiring (env vars reserved); session revocation, login rate limiting and master-key rotation (see SECURITY.md); QuietGrowth's own billing for hosted plans.

## Owner decisions still open (MR §24.1)
Auth library choice (built-in scrypt+HMAC sessions used meanwhile), lifecycle email provider (Resend-style HTTP adapter + generic interface provided), first CMS beyond GitHub, open-source/self-host packaging.
