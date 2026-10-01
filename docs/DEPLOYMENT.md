# Deployment

For a single-project Vercel setup (UI + API + cron, no containers) see [VERCEL.md](VERCEL.md). This page covers the container topology.

## Database roles
| Role | Purpose | Notes |
|---|---|---|
| table owner (e.g. `qg_owner`) | runs migrations; **not** a superuser | `FORCE ROW LEVEL SECURITY` also binds the owner, so signup/delete set `app.org_id` first |
| login role used by API/worker | `GRANT qg_app TO <login>` | queries run as `qg_app` through `withOrg` |
| `qg_app` | NOLOGIN, NOBYPASSRLS | DML on tenant tables per migration grants |
| `qg_admin` | NOLOGIN, BYPASSRLS | cross-tenant reads for `apps/admin`; grant to a dedicated login role |

`DATABASE_URL` must connect as a role that can `SET ROLE qg_app`. Migrations: `pnpm --filter @quietgrowth/database migrate` (idempotent, transactional per file).

## Processes
`api` (3001), `web` (3000), `worker` (BullMQ consumer + 15-minute scheduler), `admin` (3002, private network only), Postgres, Redis. `infra/docker-compose.yml` runs all of them on one host with localhost-only bindings; the Dockerfile builds every service (`--build-arg APP=...`). **The compose file validates (`docker compose config`) but the images were not built in the authoring environment (no Docker daemon).**

## Required configuration
See `.env.example`. Generate secrets with `openssl rand -base64 32`. `DEEPSEEK_RATE_TABLE` (JSON) must be supplied wherever model usage is metered; rates are never hard-coded.

## Modes
- **Self-host / BYOK:** one organisation; set `RUNTIME_ATTESTED=1` to attest the runtime for the readiness check when no tenant cell exists.
- **Hosted:** provision cells with `POST /admin/cells/:orgId/provision` (pinned image, secret refs only). Suspend with `POST /admin/tenants/:orgId/status`.

## Go-live checklist
1. Migrations applied as the owner role; app roles verified non-superuser.
2. All `*_SECRET` values set and distinct; `SECRET_MASTER_KEY` backed up separately from the database.
3. TLS and rate limiting in front of `api` and `web`; admin reachable only from the private network.
4. OpenClaw image pinned (tag or digest) and listed in `OPENCLAW_ALLOWED_IMAGES`.
5. Backups and a tested restore for Postgres (and the master key).
6. M0.5/M0.6 spikes completed against the live OpenClaw and DeepSeek (see STATUS).
