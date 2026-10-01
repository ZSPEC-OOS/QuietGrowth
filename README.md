# QuietGrowth

Autonomous SaaS growth operations: observe the funnel, rank evidence-backed opportunities, execute low-risk work, verify side effects independently, and measure downstream subscriber outcomes. The model proposes and drafts; **deterministic code owns money, policy, identity, state and audit.**

- Product reference: the *QuietGrowth SaaS Master Reference* ("MR", section numbers are cited throughout the code and docs)
- Plan and status: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), [docs/STATUS.md](docs/STATUS.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Security: [docs/SECURITY.md](docs/SECURITY.md) · Operations: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/VERCEL.md](docs/VERCEL.md), [docs/RUNBOOKS.md](docs/RUNBOOKS.md)

## Quick start (development)

```bash
pnpm install
cp .env.example .env            # fill SESSION_SECRET, INTERNAL_SECRET, ACTION_AUTH_SECRET, SECRET_MASTER_KEY
docker compose -f infra/docker-compose.yml up -d postgres
export DATABASE_URL=postgres://postgres:quietgrowth@localhost:5432/quietgrowth
pnpm build && pnpm --filter @quietgrowth/database migrate
pnpm check                      # typecheck + all tests (Postgres-backed suites run when DATABASE_URL is set)
node tests/e2e/run.mjs          # real-stack browser E2E (Postgres + the single Next.js app + Chromium)
```

## One deployable

`apps/web` is the only application. It serves the UI, the control-plane API under `/api/*`, the internal admin surface under `/api/admin/*`, and the background loop at `/api/cron/tick` (Vercel Cron, or the `cron` service in compose). Everything else is a library.

| Path | Purpose |
|---|---|
| `apps/web` | **The deployable.** Next.js UI + in-process API host |
| `packages/api` | Control-plane API (auth, onboarding, funnel, events, actions, policy, experiments, agent tool router); `createProductionApp` |
| `packages/worker` | Background jobs: sync → detect → propose → execute → verify → observe; lifecycle, experiments, billing reconcile; `runTick` |
| `packages/admin` | Internal tenant/runtime operations (incidents, suspension, cell provisioning) as a Fastify plugin |
| `packages/*` (rest) | Domain, policy engine, growth engine, connectors, metrics, experiments, verification, secrets, cell manager, OpenClaw adapter, SDK |
| `openclaw/` | Tenant cell template, per-agent instructions, `quietgrowth-tools` plugin, evals (not deployed with the app) |
| `infra/` | Dockerfile (one image) and compose (app + Postgres + cron) for self-hosting |
