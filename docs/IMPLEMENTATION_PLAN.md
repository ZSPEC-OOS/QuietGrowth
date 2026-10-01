# QuietGrowth — Implementation Plan

Source: *QuietGrowth SaaS Master Reference* (hereafter **MR**), section numbers cited as §n. This plan converts MR §17–§26 into ordered, testable work packages. The repository currently contains only a README; all work is greenfield.

## 0. Summary

- **Critical path:** schema + policy engine + action state machine → connector contract → event/billing ingestion → OpenClaw bridge → SEO closed loop (MR §21.4) → measurement. Everything else is parallelisable around this spine.
- **Governing invariant (MR §1, §28):** deterministic code owns money, identity, state, and irreversible effects; OpenClaw agents only propose or execute typed, authorised contracts. Every work package below is accepted only if it preserves this invariant.
- **First vertical slice (target end of Milestone M4):** one real SaaS → events + Stripe + GSC + repo connected → bottleneck detected → SEO PR proposed → policy gate → approval → PR merged → live verification → outcome observed through signup/activation/paid events.
- **Risk-first ordering:** the two least-verified dependencies (OpenClaw Gateway protocol, DeepSeek `deepseek-flash` tool-calling) are spiked in M0, not M2 (MR §29 states both must be revalidated).

## 1. Technology decisions (fixing MR §17.1 open choices)

| Concern | Decision | Rationale |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo, TypeScript strict | per MR §17 |
| API | **Fastify** + Zod (type-provider) | MR offers Fastify or NestJS; Fastify has lower overhead and simpler contract-sharing with Zod |
| DB access | `pg` + plain SQL migrations (Drizzle deferred until query volume justifies it) | explicit SQL, straightforward Row-Level Security |
| Tenancy in DB | `organization_id` on every tenant table + PostgreSQL RLS (`SET LOCAL app.org_id`) | defence in depth beyond application filters |
| Queue | Redis + BullMQ | per MR |
| Auth | Session auth (Auth.js or Better Auth), org membership roles: owner/admin/member | MR §16 identity domain |
| Contracts | Zod schemas in `packages/agent-contracts`, exported to JSON Schema for OpenClaw tools | single source of truth for WorkContract/Result |
| Web | Next.js (App Router) + Tailwind; navy/red/white tokens (MR §2) | per MR |
| Tests | Vitest, Testcontainers (Postgres/Redis), Playwright, MSW for connector fakes | MR §20 layers |
| Observability | OpenTelemetry + Sentry-compatible tracker | MR §17.1 |
| Secrets | `SecretStore` interface; AES-GCM local-encrypted implementation first, cloud KMS adapter later | MR §14.3, Appendix A |

**Open owner decisions needed before M1** (MR §24.1 defaults assumed unless overridden): V1 customer = founder-operated web SaaS; Zero-Spend as default mode; Stripe as first billing adapter; GitHub as first repo/CMS target; Resend/Postmark-class or SMTP for lifecycle email (choose one); auth library.

## 2. Repository scaffold (M0 output)

Create the MR §17 tree incrementally; do not stub all packages up front. Initial packages: `database`, `domain`, `policy-engine`, `agent-contracts`, `connectors-core`, `runtime-manager`, `openclaw-client`, `observability`; apps: `api`, `worker`, `web`. Others are created when their milestone starts.

Dependency rules (enforced with `eslint-plugin-boundaries` or `dependency-cruiser`):

```
domain            -> (no internal deps)            # pure types, state machine, scoring
policy-engine     -> domain
cost-engine       -> domain
metrics, attribution, experiments -> domain
connectors-core   -> domain
connector-*       -> connectors-core
runtime-manager   -> domain, agent-contracts, openclaw-client
context-compiler  -> domain, database(read), cost-engine
verification      -> domain, connectors-core
apps/*            -> any package; packages never import apps
openclaw/plugins/quietgrowth-tools -> agent-contracts only (no DB, no secrets)
```

## 3. Milestones and work packages

Sizing: S ≤ 2 days, M ≈ 3–5 days, L ≈ 1–2 weeks (single engineer). Each package lists acceptance criteria (AC).

### M0 — Foundation and risk spikes (MR §21.1)

| ID | Work package | Size | AC |
|---|---|---|---|
| M0.1 | Monorepo, lint/format/typecheck, CI (`.github/workflows`), Docker Compose (Postgres, Redis, MinIO) | M | `pnpm check` green on clean clone; boundaries lint active |
| M0.2 | `database` package: migrations framework, base schema for **Identity** domain (organizations, users, organization_members), RLS helper | M | cross-org read blocked in an integration test |
| M0.3 | `api` skeleton: auth, org context, `/healthz`, OTel traces, request-scoped org binding | M | authenticated request sets `app.org_id`; unauthenticated denied |
| M0.4 | `SecretStore` interface + local encrypted implementation; credential_references table | S | secrets never returned by any API; log redaction test |
| **M0.5** | **Spike: OpenClaw** — run a single local Gateway via Docker, start a run from an external app, stream events, cancel (MR §29, `gateway/external-apps`) | M | written findings in `docs/spikes/openclaw.md`: protocol, auth, config surface, cell resource footprint |
| **M0.6** | **Spike: DeepSeek** — BYOK call to `deepseek-flash`, tool calling, structured output, token/cache usage fields | S | recorded fixtures; confirms usage fields available for cost ledger |

Exit gate: spikes either confirm MR assumptions or produce a documented deviation; the `AgentRuntimeManager` interface (MR §7.2) is adjusted accordingly *before* M2.

### M1 — SaaS profile, funnel model, cost ledger (MR §21.1, §3, §6)

| ID | Work package | Size | AC |
|---|---|---|---|
| M1.1 | Schema: products, product_profiles, plan_catalog, feature_catalog, customer_segments, funnel_definitions, funnel_stages, event_mappings, activation_definitions (versioned) | M | version history retained; unique active version per org/product |
| M1.2 | Domain: canonical funnel (visitor→signup→activated→paid→retained) with optional B2B/freemium stages; **instrumentation completeness evaluator** returning explicit missing-event flags (MR §3 principle) | M | unit tests: missing activation event ⇒ conclusions flagged "incomplete"; never reports signup as subscriber |
| M1.3 | `POST /v1/onboarding/analyze`: URL crawler (SSRF-safe: block private ranges, redirect limits, size/time caps) + classifier job producing draft profile | L | SSRF test suite passes; draft profile stored with evidence refs |
| M1.4 | `POST /v1/funnel/define` + growth-contract validation (MR §3.3) | S | rejects contract missing primary conversion/activation/retention window |
| M1.5 | `cost-engine`: configurable rate table, `model_usage`, `model_cost_ledger`, per-tenant monthly cap, per-action token ceiling | M | cap breach ⇒ background AI work paused (MR §27); rates loaded from config, not hard-coded |
| M1.6 | Web: 5-stage onboarding wizard, Product Profile screen | L | URL + DeepSeek key → draft profile → confirm funnel events end-to-end in Playwright |

### M2 — Policy, action ledger, runtime bridge (MR §21.3, §14, §7, §9)

Built before connectors so that no write path can exist without the gate.

| ID | Work package | Size | AC |
|---|---|---|---|
| M2.1 | Schema: marketing_policies, policy_versions, budget_policies, approvals, opportunities, evidence_items, actions, executions, execution_events, external_changes, rollback_records, audit_logs | M | `actions` carries every field in MR §16.1 |
| M2.2 | Domain: **action state machine** (MR §8.2) with exhaustive transition table; invalid transitions throw | M | property-based test: only legal transitions reachable |
| M2.3 | `policy-engine`: pure function `evaluate(action, policy, spendState) → DENY | NEEDS_APPROVAL | ALLOW` implementing Zero-Spend policy (MR §5.2), high-risk table (MR §14.2), spend/model caps | L | policy test matrix (MR §20): every spend/pricing/destructive/cold-outreach case **fails closed**; unknown action type ⇒ DENY |
| M2.4 | **Action authorisation token**: signed envelope {actionId, policyVersion, resourceScope, idempotencyKey, expiry}; verification library used by connectors | M | tampered/expired/out-of-scope tokens rejected; replay with same idempotency key is a no-op |
| M2.5 | Approvals API (`approve`, `reject`, `run`, `GET actions/:id`) + audit logging | M | approval binds to policy version; policy change invalidates pending approvals |
| M2.6 | `agent-contracts`: WorkContract, WorkResult, Proposal, ToolCall/ToolResult Zod schemas; schema versioning | M | contracts round-trip; unknown fields rejected |
| M2.7 | `openclaw-client` + `runtime-manager`: implement `AgentRuntimeManager` for local Docker mode; health, run, cancel, stream events; `/internal/openclaw/events` ingestion | L | integration test with real local Gateway: run → events persisted → cancel works |
| M2.8 | `openclaw/tenant-template`: per-tenant config (model pin `deepseek/deepseek-flash`, tool allowlists per agent, host-exec deny-by-default), secrets injected by reference | M | agent without mutation rights cannot call mutation tool (negative test) |
| M2.9 | `openclaw/plugins/quietgrowth-tools`: thin tool plugin that calls the QuietGrowth control plane with the authorisation token; no direct DB or provider credentials | M | plugin has no network route to Postgres/billing; verified in compose network config |
| M2.10 | Context compiler v1 (MR §13.1) with priority truncation to a token budget | M | deterministic output for same inputs; budget never exceeded |

### M3 — Evidence: events, billing, analytics, repo (MR §21.2, §12)

| ID | Work package | Size | AC |
|---|---|---|---|
| M3.1 | `connectors-core`: `Connector<TRead,TWrite>` (MR §12.2), health state machine (healthy/degraded/revoked), token-refresh handling, fake-provider test harness | M | token expiry ⇒ degraded + writes stopped (MR §27) |
| M3.2 | `POST /v1/events`: idempotency keys, schema versioning, identity merge (anonymousId→userId), server-side events; partitioned `conversion_events` | L | duplicate delivery stored once; merge links pre-signup sessions; schema-version migration test |
| M3.3 | JS browser SDK + Node server SDK (`packages/sdk-*`) with batching/retry | M | sample app instrumented in <10 lines; offline retry test |
| M3.4 | Stripe adapter (webhooks + backfill) → normalized `revenue_events`, `subscriptions` (started, upgraded, cancelled, refunded, involuntary churn) | L | webhook signature verified; replay/out-of-order events reconciled; **conversions never inferred from client events alone** (MR §27) |
| M3.5 | GA4 and Search Console connectors (OAuth, read-only) with scheduled sync into `metric_points` | L | quota/backoff handled; per-tenant sync cursor |
| M3.6 | GitHub repo connector: clone/read, branch + patch + PR creation, rollback = revert PR; CMS adapter interface (second implementation deferred) | L | write requires authorisation token; PR opened on a branch only, never to default |
| M3.7 | `metrics` + `attribution`: funnel/cohort aggregation, D7/D30, retained-customer definition, first-touch/last-touch with explicit "unattributed" bucket | L | arithmetic unit tests; cohort counts reproducible from raw events |
| M3.8 | Web: Dashboard, Funnel, Integrations screens on real data (MR §19.1 KPI priority; diagnostics subordinate) | L | top row shows retained customers, MRR delta, activation, paid conversion, retention; incomplete-instrumentation banner visible |
| M3.9 | Readiness checker implementing Appendix B; blocks Autopilot writes until passed | S | each checklist row has an automated or explicit-attestation check |

### M4 — First closed loop: SEO acquisition (MR §21.4, §10.1)

| ID | Work package | Size | AC |
|---|---|---|---|
| M4.1 | Site crawler + `page_snapshots`, `content_assets`, `content_revisions` (hash-versioned) | M | snapshot diffs detect change; respects robots/crawl limits |
| M4.2 | Opportunity detection (deterministic first): GSC high-impression/low-CTR, ranking 8–20, orphan pages, missing metadata/schema, internal-link gaps; each tagged with funnel stage and segment | L | opportunities carry evidence refs; dedupe stable across runs |
| M4.3 | Scoring per MR §8.3 (weights as config), risk as gate not score, evidence quality caps confidence | S | scoring is inspectable and unit-tested |
| M4.4 | Agents: Growth Director (proposal only), Research Scout (read-only), SEO & Acquisition Operator (bounded repo writes) with prompts + tool allowlists; one operation per action (metadata, refresh, internal link, FAQ/schema, intent page) | L | agent output validated against schema; free-form text never executed |
| M4.5 | Pre-publish checks: factual-claim check against `knowledge_items`, duplication, link validity, competitor-claim rules | M | failing check ⇒ action returns to PROPOSED with reasons |
| M4.6 | Side-effect protocol (MR §15.1): precondition/resource-version, idempotency lock, single mutation, receipt, postcondition, observation scheduling | M | crash-injection test: no double publish, state recoverable |
| M4.7 | `verification` service + `/internal/verify/:actionId`: HTTP 200, hash/marker, canonical, indexability, analytics tag, sitemap (MR §15.2) — **independent of the executing agent** | M | verifier uses its own credentials/read-only connector |
| M4.8 | Observation engine: impressions → qualified visits → signup → activation → paid/retained, and `EVALUATED` transition with observational-vs-experimental label | M | outcome record links action → cohort → metric deltas |
| M4.9 | Web: Opportunities, Actions (approval inbox, receipts, rollback), Acquisition screens | L | owner can approve and see receipt + verification evidence |
| M4.10 | E2E test (MR §20.1): seeded synthetic SaaS fixture → opportunity → policy → approval → PR → verify → outcome | M | runs in CI against mocked GitHub/GSC and real OpenClaw with recorded model fixtures |

**Pre-alpha proof (MR §22.1)** is run here against one real SaaS, including deliberate exercise of rollback and failed-verification paths.

### M5 — Activation, lifecycle, experiments (MR §21.5, §10.2–10.3, §10.6, §11)

| ID | Work package | Size | AC |
|---|---|---|---|
| M5.1 | `experiments` package + schema (MR §11.1), assignment (deterministic hash), sample/observation-window rules, no auto-winner on small samples, **pricing/entitlement changes never auto-applied** | L | stats tests for fixed-window and sequential modes; guardrail breach stops experiment |
| M5.2 | Feature-flag adapter (native SDK first; one external provider P1) | M | assignment endpoint + event capture verified (MR §15.2) |
| M5.3 | Activation bottleneck detector: milestone decomposition, highest-drop stage, cohort anomaly detection | M | detects growth-eval fixtures 1–3 (MR §20.2) |
| M5.4 | Lifecycle: deterministic segment rules (new, not-activated, activated-not-paid, trial-ending, dormant, churn-risk, cancelled, reactivated), `suppressions`, frequency caps, unsubscribe | L | suppression honoured in 100% of send tests; model cannot add sensitive traits |
| M5.5 | Email connector (one provider) + `send_receipts`; duplicate-send prevention via idempotency | M | provider accepted-ID recorded; second send with same key no-ops |
| M5.6 | Lifecycle Operator + Conversion Operator agents; contracts and allowlists | M | outbound to new contacts ⇒ NEEDS_APPROVAL (MR §5.2) |
| M5.7 | Retention/win-back detector; measure retained revenue, not opens/clicks | M | fixture 5 (high clicks, no lift) not scored as success |
| M5.8 | Web: Lifecycle, Experiments, Analytics screens | L | — |

### M6 — Product-led growth (MR §21.6, §10.5)

Referral/invite opportunity templates; integration/use-case page engine (reuses M4 pipeline); in-product prompt and upgrade *proposals* only (approval mandatory; delivered as PRs). Size L total; AC: templates produce evidence-linked opportunities and never mutate pricing/entitlements.

### M7 — Hosted multi-tenant beta (MR §21.7, §7.1, §14.3)

| ID | Work package | Size |
|---|---|---|
| M7.1 | Tenant-cell provisioning via runtime-manager (container per org; private network; Gateway on loopback/private only; credentials never reach browser) | L |
| M7.2 | Quotas, health checks, restart policy, runtime/model version pinning + compatibility test suite | M |
| M7.3 | Backups/restore, tenant data export and deletion (MR §19 Settings) | M |
| M7.4 | Hosted billing/entitlements for QuietGrowth itself (`subscriptions`, `entitlements`, `usage_records`) | L |
| M7.5 | `apps/admin` incident tooling; runbooks per MR §27 | M |
| M7.6 | Security review: tenant isolation, SSRF, path traversal, prompt injection, token leakage (MR §20.1) | L |

AC gate: cross-tenant isolation test suite (attempt cross-cell session access, cross-org DB reads, shared-volume leakage) passes.

### M8 — Paid growth (MR §21.8, §10.8) — post-MVP

Google Ads connector behind spend-constrained write scope; `external_spend_ledger`; CAC/payback dashboards; paid-growth gate and stop-loss rules from MR §10.8; mode exposure only when readiness checks pass. Zero-Spend regression test must continue to prove **no spend path is reachable**.

## 4. Cross-cutting engineering requirements

1. **Fail-closed policy:** unknown action type, missing policy, or evaluation exception ⇒ DENY. Covered by a dedicated policy test suite that gates every merge.
2. **Idempotency everywhere:** all mutating endpoints, connector writes, and queue jobs accept/derive idempotency keys.
3. **Untrusted-content handling:** crawled/retrieved text is wrapped as data in contracts; a prompt-injection eval set (M2.8 onward) asserts that tool authorisation never changes based on content.
4. **Auditability:** every state transition writes `audit_logs`; execution receipts include evidence, model-cost estimate, and external-cost estimate (MR §25).
5. **Replay harness:** persist model I/O traces (redacted) so changes to model, runtime, or prompts can be replayed against fixtures (MR §20.1).
6. **Agent evals:** `openclaw/evals` with the seven growth fixtures (MR §20.2); CI runs recorded-fixture mode, nightly runs live-model mode with cost cap.
7. **Config over code for new SaaS:** onboarding a second SaaS must require no code change (MR §25); enforce by running the E2E suite against two differently shaped fixtures from M4 onward.
8. **Version pinning:** OpenClaw image tag, DeepSeek model name, and rate table are pinned in config and checked at boot.

## 5. Test strategy by milestone

| Layer (MR §20.1) | Introduced | Tooling |
|---|---|---|
| Unit | M0 | Vitest; property tests (fast-check) for state machine/policy |
| Contract | M2 | Zod/JSON-Schema fixtures; provider webhook recordings |
| Integration | M3 | Testcontainers; Stripe test mode; MSW fakes for GSC/GA4/GitHub |
| Policy | M2 | table-driven matrix, merge-blocking |
| Replay / agent eval | M4 | recorded traces, nightly live runs |
| Security | M2 (SSRF, token leakage), M7 (isolation) | dedicated suites + external review before beta |
| E2E | M4 | Playwright + API-driven pipeline test |

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| OpenClaw protocol/plugin surface differs from MR assumptions (MR §29 flags time-sensitivity) | High | M0.5 spike; `AgentRuntimeManager` abstraction isolates change |
| `deepseek-flash` tool-calling/structured-output reliability lower than assumed | High | M0.6 spike; schema validation + retry/re-plan; replay harness; keep model name configurable |
| Insufficient first-party event volume for meaningful causal inference | Medium | small-sample rules (MR §11.2); label observational results; dogfood across several products |
| Attribution gaps (privacy, cookie loss) | Medium | explicit "unattributed" bucket; billing-source truth over client events |
| Scope breadth (9 agents, 9 connectors) | High | agents/connectors added only when their milestone's workflow exists; MR §9 states agent count should stay small |
| Cost of agent loops | Medium | per-action token ceilings, tenant cap, background pause (M1.5) |
| Prompt injection via crawled content | High | untrusted-data contracts, no tool authorisation from content, eval set |
| Per-tenant cell cost at scale | Medium | measure in M7.1; resource limits; consider idle-stop |

## 7. Proposed first sprint (M0 + start of M1)

1. M0.1 monorepo/CI/compose
2. M0.5 and M0.6 spikes (parallel)
3. M0.2 identity schema + RLS; M0.3 API skeleton; M0.4 secret store
4. M2.2 domain state machine and M2.3 policy-engine skeleton (pure packages, no infra dependency — can start immediately)
5. M1.1 schema and M1.2 funnel completeness evaluator

Rationale: the pure-domain packages (state machine, policy, scoring, metrics arithmetic) have no external dependencies and carry the highest correctness requirement, so they are started early and test-driven.

## 8. Definition of done mapping (MR §25)

| MR §25 criterion | Delivered by |
|---|---|
| Sign up, add URL + DeepSeek key, define events | M1.3, M1.4, M1.6 |
| Connect events, billing, GSC, GA4, repo | M3.2–M3.6 |
| Accurate funnel; missing instrumentation explicit | M1.2, M3.7, M3.8 |
| Evidence-backed opportunities tied to funnel stage | M4.2 |
| Policy engine blocks forbidden spend/destructive actions | M2.3 |
| OpenClaw executes acquisition workflow with typed contract | M2.6–M2.9, M4.4 |
| Verifier independently confirms mutation | M4.7 |
| Outcome observed through signup/activation/paid | M4.8 |
| Receipt, cost estimate, evidence per execution | M2.1, M4.6 |
| Zero-Spend cannot create external spend | M2.3 + permanent regression test |
| Second SaaS onboarded without code changes | §4 item 7 |

## 9. Reference

1. *QuietGrowth SaaS Master Reference* (Master Product, Architecture & Launch Reference), revised SaaS-first baseline; external assumptions dated 30 September 2026 (MR §29). Time-sensitive interfaces (OpenClaw Gateway, DeepSeek V4.1 Flash) are taken from that document and not independently verified here.
