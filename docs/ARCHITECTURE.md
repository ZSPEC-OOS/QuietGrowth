# Architecture

## Control principle
QuietGrowth owns the business state, funnel model, policy, budget, experiments, action ledger and measurement. OpenClaw is an execution runtime, not the source of truth (MR §1). Agents never receive credentials, and every mutation passes the same gate.

## The action loop (`packages/growth-engine`)
```
DISCOVERED → SCORED → PROPOSED → POLICY_CHECK ─┬─ BLOCKED (deny, or owner rejection)
                                                ├─ NEEDS_APPROVAL → APPROVED ─┐
                                                └─ AUTO_APPROVED ─────────────┤
                                                                              ▼
                                       QUEUED → RUNNING → VERIFYING ─┬─ FAILED (rollback if safe + pre-authorised)
                                                                     └─ SUCCEEDED → OBSERVING → EVALUATED
```
- The transition table lives in `packages/domain/src/action-state.ts`; illegal transitions throw. `NEEDS_APPROVAL → BLOCKED` is the one extension to MR §8.2 (owner rejection).
- `policy-engine.evaluate` is pure and fails closed: unknown types, invalid costs, missing policy, or any exception ⇒ DENY. Spend and model caps are checked before any rule, so an approval can never authorise spend.
- Approvals are bound to a policy version; a policy change voids them (checked again at queue and run time).
- The executor receives a signed, scoped, expiring **action authorisation token** (action id, policy version, resource scope, idempotency key). Connectors verify it before any write and claim the idempotency key last.
- Verification is a separate component using read-only access; a failed verification marks the action FAILED and attempts rollback only when a safe handler exists.

## Trust boundaries
| Boundary | Mechanism |
|---|---|
| Tenant ↔ tenant (data) | `organization_id` on every tenant table + forced Postgres RLS; application queries run as non-bypass `qg_app` via `withOrg` |
| Tenant ↔ tenant (runtime) | One OpenClaw cell per organisation (`packages/cell-manager`); loopback publish, read-only FS, dropped caps, resource limits, egress deny-by-default |
| Agent ↔ control plane | `quietgrowth-tools` plugin → `/internal/tools/:tool` (shared secret, org fixed by cell config). Reads return tenant data; writes are **proposals only**; mutation tools are never executed through this API |
| Untrusted content ↔ authority | Crawled/retrieved text lives in `contract.untrusted`; tool authorisation is a pure function of agent id and token, so content cannot widen it (covered by an injection corpus in `openclaw/evals`) |
| Secrets | Stored AES-256-GCM sealed (org bound as AAD) in Postgres; referenced by id; redacted from logs |

## Data flow
1. Product events (SDK → `POST /v1/events`, API key) and billing (Stripe) feed canonical facts; GSC/GA4 feed search and traffic evidence.
2. The worker detects opportunities deterministically (SEO, funnel bottleneck vs. planning priors, churn drivers, PLG templates), persists them, and drafts bounded proposals (rule-based fallback or agent).
3. Proposals go through the engine above. Low-risk operations are auto-approved within limits; everything else waits for an owner.
4. Outcomes are evaluated after an observation window and labelled *experimental* or *observational*.

## Measurement honesty
A client-reported `paid` event is never described as a subscriber; the UI and API label customers as confirmed only when a billing source is connected and healthy. Funnel stages are not ranked when instrumentation is incomplete, and small samples are reported as insufficient data.
