# QuietGrowth

Autonomous SaaS growth operations: observe the funnel, rank evidence-backed opportunities, execute low-risk work, verify side effects independently, and measure downstream subscriber outcomes. The model proposes and drafts; **deterministic code owns money, policy, identity, state and audit.**

- Product reference: the *QuietGrowth SaaS Master Reference* ("MR", section numbers are cited throughout the code and docs)
- Plan and status: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), [docs/STATUS.md](docs/STATUS.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Security: [docs/SECURITY.md](docs/SECURITY.md) · Operations: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/VERCEL.md](docs/VERCEL.md), [docs/RUNBOOKS.md](docs/RUNBOOKS.md)

## Quick start (development)

```bash
pnpm install
cp .env.example .env            # fill SESSION_SECRET, INTERNAL_SECRET, ACTION_AUTH_SECRET, SECRET_MASTER_KEY
docker compose -f infra/docker-compose.yml up -d postgres redis
export DATABASE_URL=postgres://postgres:quietgrowth@localhost:5432/quietgrowth REDIS_URL=redis://localhost:6379
pnpm build && pnpm --filter @quietgrowth/database migrate
pnpm check                      # typecheck + all tests (DB/Redis-backed suites run when the URLs are set)
node tests/e2e/run.mjs          # real-stack browser E2E (Postgres + API + Next.js + Chromium)
```

## Layout

| Path | Purpose |
|---|---|
| `apps/api` | Control-plane API (auth, onboarding, funnel, events, actions, policy, experiments, agent tool router) |
| `apps/worker` | Background loop: sync → detect → propose → execute → verify → observe; lifecycle, experiments, billing reconcile |
| `apps/web` | Customer UI (all MR §19 screens) |
| `apps/admin` | Internal tenant/runtime operations (cells, incidents, suspension) |
| `packages/*` | Domain, policy engine, growth engine, connectors, metrics, experiments, verification, secrets, cell manager, OpenClaw adapter, SDK |
| `openclaw/` | Tenant cell template, per-agent instructions, `quietgrowth-tools` plugin, evals |
| `infra/` | Dockerfile, compose, CI-adjacent assets |
