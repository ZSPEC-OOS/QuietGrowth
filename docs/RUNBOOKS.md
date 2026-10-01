# Operational runbooks (MR §27)

| Failure | Automatic response | Escalation / operator steps |
|---|---|---|
| DeepSeek unavailable | the job fails and is retried on the next cron tick; action state preserved; **no mutation** | If repeated, check `/api/admin/incidents`; verify provider status and the tenant key with `POST /v1/integrations/deepseek/test` |
| OpenClaw cell unhealthy | dispatch stops (`OpenClawRuntimeManager.run` refuses); health-restart policy | `POST /api/admin/cells/:orgId/restart` (bounded to 3 attempts); inspect `docker logs qg-cell-*`; check `versionDrift` in `/api/admin/incidents` |
| Connector token expired/revoked | integration marked `degraded`, writes stopped, notification created | Owner reconnects in Integrations; verify with a read; degraded connectors are not used until healthy |
| Verification failure | action → FAILED; rollback only if a safe, pre-authorised handler exists | Open the action detail (checks + audit trail); revert the PR/change manually if no rollback; re-propose after fixing |
| Product event outage | measurement flagged incomplete; experiment evaluation frozen | Check SDK/ingestion errors; once healthy, set the experiment back to `running` |
| Billing webhook lag | never infer conversions from client events | Backfill via the worker's `reconcile_billing`; reconcile is idempotent and order-independent |
| Model budget cap reached | all background AI work pauses (`paused: true`) | Owner raises the cap on Autopilot (bounded by plan) |
| External-spend cap reached | spend actions blocked | Owner approval required to change policy; Zero-Spend can never be raised above $0 |
| Experiment instrumentation broken | evaluation frozen (`freeze_instrumentation`) | Repair events, then restart the experiment |

## Procedures
**Suspend a tenant** (abuse, unpaid): `POST /api/admin/tenants/:orgId/status {"status":"suspended","reason":"..."}`. Workers skip it, its cell stops, data is retained. Reinstate with `"active"`.

**Customer data export/deletion:** owner uses Settings → export (`GET /v1/settings/export`, no credentials included) and deletion (`POST /v1/settings/delete` with the exact organisation name). Deletion cascades all tenant rows and removes sealed secrets. Backups age out per the retention policy; document the window to the customer.

**Cross-tenant incident:** suspend both tenants, preserve `audit_logs` and cell logs, rotate `INTERNAL_SECRET` and `ACTION_AUTH_SECRET`, and review RLS policies with the schema-wide invariant test before reinstating.

**Key rotation:** `ACTION_AUTH_SECRET` and `SESSION_SECRET` can be rotated by restart (invalidates in-flight tokens). `SECRET_MASTER_KEY` rotation requires a re-encryption job (not implemented).
