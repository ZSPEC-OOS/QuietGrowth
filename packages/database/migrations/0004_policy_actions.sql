-- Policy, opportunities, actions, executions, audit (MR §16, §16.1).
CREATE TABLE policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version text NOT NULL, policy jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, version)
);
CREATE TABLE opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain text NOT NULL, funnel_stage text, kind text NOT NULL, dedupe_key text NOT NULL,
  evidence_json jsonb NOT NULL, score numeric, status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key)
);
CREATE TABLE actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunities(id),
  domain text NOT NULL, type text NOT NULL, channel text,
  target_metric text NOT NULL, guardrail_metrics jsonb NOT NULL DEFAULT '[]',
  rationale text NOT NULL, evidence_json jsonb NOT NULL,
  expected_incremental_impact numeric, confidence_score numeric,
  risk_level text NOT NULL DEFAULT 'low',
  estimated_external_cost_usd numeric NOT NULL DEFAULT 0 CHECK (estimated_external_cost_usd >= 0),
  estimated_model_cost_usd numeric NOT NULL DEFAULT 0 CHECK (estimated_model_cost_usd >= 0),
  status text NOT NULL DEFAULT 'DISCOVERED',
  requires_approval boolean NOT NULL DEFAULT true,
  policy_version_id uuid REFERENCES policy_versions(id),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, executed_at timestamptz,
  UNIQUE (organization_id, idempotency_key)
);
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  policy_version text NOT NULL, decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_by uuid REFERENCES users(id), reason text, decided_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz
);
CREATE TABLE executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  status text NOT NULL, receipt jsonb, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE execution_events (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE external_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  provider text NOT NULL, resource_id text NOT NULL, receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rollback_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  status text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
-- Audit log is append-only for the application role.
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor text NOT NULL, event text NOT NULL, subject_type text, subject_id text,
  detail jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now()
);

SELECT qg_tenant_table('policy_versions', 'SELECT, INSERT');
SELECT qg_tenant_table('opportunities');
SELECT qg_tenant_table('actions');
SELECT qg_tenant_table('approvals');
SELECT qg_tenant_table('executions');
SELECT qg_tenant_table('execution_events', 'SELECT, INSERT');
SELECT qg_tenant_table('external_changes', 'SELECT, INSERT');
SELECT qg_tenant_table('rollback_records');
SELECT qg_tenant_table('audit_logs', 'SELECT, INSERT');
DO $$ BEGIN EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA %I TO qg_app', current_schema()); END $$;
