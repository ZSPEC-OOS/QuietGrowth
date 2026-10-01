# Deploying to Vercel (single project)

One Vercel project serves everything: the Next.js UI, the control-plane API under `/api/*`, and the background loop via Vercel Cron.

```
Browser ──► Next.js (apps/web) ─┬─ pages / server components / server actions ─┐
                                ├─ /api/[...path]  (public API: SDK, cells)    ├─► in-process Fastify app ──► Postgres
                                └─ /api/cron/tick  (Vercel Cron, bearer secret)┘     (packages/*, @quietgrowth/api)
```

- The Fastify app (`@quietgrowth/api`) is created once per warm instance (`createProductionApp`) and called with `inject`: no network hop between UI and API, one DB pool, one set of env vars.
- The public API keeps its paths, now prefixed: `https://<app>/api/healthz`, `/api/v1/events`, `/api/internal/tools/:tool`, `/api/cron/tick`. Point the SDK at `https://<app>/api` and tenant cells' `controlPlaneUrl` at the same.
- Setting `API_URL` makes the web app call a remote API instead (split deployment). Leave it unset for the single deployment.
- Also served from this one app: the admin surface at `/api/admin/*` (token-gated; cross-tenant queries need `ADMIN_DATABASE_URL`, a login role in `qg_admin`) and the cron tick. There is no separate worker or admin deployment.
- Not on Vercel: OpenClaw tenant cells (they need a Docker host; cell endpoints answer `503 runtime_unavailable` here). Without them you get the **self-host/BYOK "light" mode**: funnel, SEO/lifecycle/experiment proposals with rule-based drafting, no agent runtime (`RUNTIME_ATTESTED=1`).

## 1. Database
1. Create a Postgres database (Neon / Vercel Postgres / any managed). Keep **two** URLs: pooled → `DATABASE_URL`, direct → `DATABASE_URL_UNPOOLED`.
2. The login role must **not** be a superuser (superusers bypass RLS). It needs permission to create roles (migrations create `qg_app` and `qg_admin`) and the migration `GRANT qg_app TO CURRENT_USER` lets the app `SET LOCAL ROLE qg_app` per transaction. Transaction-mode poolers support this.

## 2. Project settings
- Import the repo. **Root Directory: `apps/web`**, framework Next.js. `apps/web/vercel.json` already sets:
  - install: `cd ../.. && pnpm install --frozen-lockfile`
  - build: `node scripts/vercel-build.mjs` (builds workspace packages, optionally migrates, runs `next build` through Turborepo)
  - cron: `*/15 * * * *` → `/api/cron/tick`
- Environment variables (Production and Preview; use distinct values per environment; generate with `openssl rand -base64 32`):

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | pooled connection string |
| `DATABASE_URL_UNPOOLED` | for migrations | direct connection |
| `SESSION_SECRET`, `ACTION_AUTH_SECRET` | yes | ≥ 32 random bytes each |
| `INTERNAL_SECRET` | yes | master for per-tenant cell secrets |
| `SECRET_MASTER_KEY` | yes | base64, 32 bytes. **Back it up outside Vercel**; losing it makes stored connector credentials unreadable |
| `CRON_SECRET` | yes | ≥ 24 chars. Vercel sends it as `Authorization: Bearer …` to cron routes |
| `RUN_MIGRATIONS` | optional | `1` = run migrations during the **production** build |
| `RUNTIME_ATTESTED` | optional | `1` for light mode without tenant cells |
| `ADMIN_TOKEN`, `ADMIN_DATABASE_URL` | optional | enable `/api/admin/*`; both required, token ≥ 24 chars |
| `PG_POOL_MAX`, `TICK_BUDGET_MS`, `QG_LOG` | optional | defaults 3, 45000, on |

Without the required secrets the deployment fails closed: `/api/*` answers `503 {"error":"service_unavailable"}` and the real reason appears only in function logs.

## 3. Cron tick
`/api/cron/tick` runs the background jobs in `packages/worker` (reconcile billing, detect/propose, lifecycle, execute, experiments, evaluate) for every active tenant, stopping at `TICK_BUDGET_MS` (function limit 60 s) and resuming on the next tick. Sub-daily schedules need a Pro plan; on Hobby use a daily cron or an external scheduler calling the endpoint with the bearer secret. If tenant count outgrows one tick, shorten the schedule or add a queue-based runner behind the same `runTick` handlers.

## 4. Verify
Local, production-mode check of exactly this topology (one Next.js process, real Postgres, headless Chromium; also boots a deliberately misconfigured instance and expects the 503):
```bash
pnpm build && DATABASE_URL=<throwaway db> node tests/e2e/run.mjs
```
After the first real deploy: `GET /api/healthz`; sign up in the UI; `GET /api/cron/tick` with and without the bearer secret (expect 200 / 401); check function logs for the boot line and no errors.

## Caveats
- **No deployment was performed from the authoring environment** (no Vercel CLI or credentials). Local `next build` + `next start` and the E2E exercise the same code path, and the build output's file trace was inspected (`fastify`, `pg`, `pino` are externalised and traced; workspace packages are bundled), but confirm the first deployment end to end, particularly function size/trace completeness and the cron invocation.
- Cold starts include booting Fastify and one DB connection; keep `PG_POOL_MAX` small and use the provider's pooler.
- No in-app rate limiting: enable Vercel Firewall rules for `/api/v1/login` and `/api/v1/signup`.
- The public `/api/internal/*` routes are reachable from the internet by design (tenant cells call them); they require the per-tenant derived secret and answer 401 otherwise.
- Repo/email writes still fail closed until per-organisation connectors are wired (see STATUS.md); the tick still proposes, approves, gates on readiness and verifies.
