# Deploying to Vercel

QuietGrowth is two Vercel projects from one repository. Everything that needs a long-running process or a container runtime stays **off** Vercel.

| Component | Where | Why |
|---|---|---|
| `apps/web` (Next.js) | Vercel project **quietgrowth-web** | Standard Next.js; no workspace dependencies |
| `apps/api` (Fastify) | Vercel project **quietgrowth-api** (Node 22 function, Build Output API v3) | Stateless HTTP; one warm Fastify instance per container |
| Background loop | **Vercel Cron → `GET /cron/tick`** | Replaces the BullMQ worker (no Redis needed). Same idempotent handlers, time-boxed per tick |
| Postgres | Neon / Vercel Postgres / any managed Postgres | Use a pooled connection string for runtime |
| `apps/admin`, OpenClaw tenant cells | A container host (Fly, Railway, ECS, VM) | Docker/long-running; cannot run on Vercel |

This split gives the **self-host/BYOK "light" mode**: SEO/lifecycle/experiments/funnel with rule-based drafting and no agent runtime (`RUNTIME_ATTESTED=1`). Agent execution (OpenClaw cells) needs the container host and is out of scope for Vercel.

## 1. Database
1. Create a Postgres database. Keep two URLs: pooled → `DATABASE_URL`, direct → `DATABASE_URL_UNPOOLED`.
2. The login role must be allowed to create roles/extensions-free objects (migrations create `qg_app` / `qg_admin` and `GRANT qg_app TO CURRENT_USER`, so the app can `SET LOCAL ROLE qg_app`). It must **not** be a superuser in production (superusers bypass RLS).
3. Migrations run either manually (`DATABASE_URL=<direct> pnpm --filter @quietgrowth/database migrate`) or during the API production build with `RUN_MIGRATIONS=1`.

## 2. API project
- Import the repo; **Root Directory: `apps/api`**; framework preset *Other*. `apps/api/vercel.json` sets install and build commands (`node scripts/vercel-build.mjs` → builds workspace packages, optional migrations, writes `.vercel/output`).
- Environment variables (Production and Preview; use distinct values per environment):
  `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `SESSION_SECRET`, `INTERNAL_SECRET`, `ACTION_AUTH_SECRET`, `SECRET_MASTER_KEY`, `CRON_SECRET`, optional `PG_POOL_MAX`, `TICK_BUDGET_MS`, `RUN_MIGRATIONS`, `RUNTIME_ATTESTED`.
- Generate secrets with `openssl rand -base64 32`. **Back up `SECRET_MASTER_KEY` outside Vercel**: losing it makes stored connector credentials unreadable.
- Cron: `config.json` registers `*/15 * * * *` for `/cron/tick`. Sub-daily schedules need a Pro plan; on Hobby, change the schedule in `scripts/build-vercel.mjs` to daily or trigger the endpoint from an external scheduler with the bearer secret. `CRON_SECRET` is injected automatically by Vercel Cron when the variable exists.
- A tick is limited by `maxDuration` (60s) and `TICK_BUDGET_MS`; with many tenants it resumes on the next tick (handlers are idempotent). Move to the container worker (`apps/worker`) when tenants outgrow this.

## 3. Web project
- **Root Directory: `apps/web`**, framework Next.js (`apps/web/vercel.json`).
- Environment: `API_URL` = the API project's production URL. The browser never calls the API directly; server components and server actions do, using the httpOnly session cookie, so no CORS configuration is needed.
- Put both projects behind the same parent domain if you want first-party cookies on a custom domain.

## 4. Verify before pointing users at it
```bash
pnpm turbo run build --filter=@quietgrowth/api...
cd apps/api && pnpm build:vercel                       # emits .vercel/output
DATABASE_URL=<throwaway db> node scripts/smoke-vercel.mjs   # loads the bundle as the launcher would; checks 503-on-misconfig, signup, auth, cron
```
After deploy: `GET <api>/healthz`; sign up through the web app; call `GET <api>/cron/tick` with and without the bearer secret (expect 200 / 401).

## Limits and caveats
- **Not verified on Vercel itself**: no deployment was possible from the authoring environment (no Vercel CLI/credentials). The function bundle, routing config and cron registration follow the Build Output API v3 format and were exercised locally by `smoke-vercel.mjs`; confirm the first deployment end to end (route rewrites preserving the original path, cron invocation, function logs).
- Cold starts include booting Fastify and one DB connection; keep `PG_POOL_MAX` small and use the provider's pooler to avoid exhausting connections under concurrency.
- Request-level rate limiting is not implemented in the app: enable Vercel Firewall / rate limiting on `/v1/login` and `/v1/signup`.
- The cron tick uses fail-closed executors: proposals, approvals, readiness and verification run, but repository/email writes require per-organisation connector wiring (see STATUS.md).
- No Redis is used on Vercel. `REDIS_URL` is only for the container worker.
