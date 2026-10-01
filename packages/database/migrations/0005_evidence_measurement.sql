-- Integrations, events, revenue, metrics, content, experiments, lifecycle, economics (MR §16).
CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL, status text NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','degraded','revoked')),
  scopes jsonb NOT NULL DEFAULT '[]', sync_cursor text, last_sync_at timestamptz,
  UNIQUE (organization_id, provider)
);
CREATE TABLE credential_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id uuid REFERENCES integrations(id) ON DELETE CASCADE,
  secret_ref text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversion_events (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL, anonymous_id text, user_id text, event text NOT NULL,
  occurred_at timestamptz NOT NULL, properties jsonb NOT NULL DEFAULT '{}', context jsonb NOT NULL DEFAULT '{}',
  schema_version int NOT NULL DEFAULT 1, received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX conversion_events_lookup ON conversion_events (organization_id, event, occurred_at);
CREATE TABLE identity_links (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  anonymous_id text NOT NULL, user_id text NOT NULL, linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, anonymous_id)
);
CREATE TABLE subscriptions_observed (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_id text NOT NULL, customer_id text NOT NULL, plan text, status text NOT NULL,
  mrr_cents bigint NOT NULL DEFAULT 0, started_at timestamptz, cancelled_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, external_id)
);
CREATE TABLE revenue_events (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_event_id text NOT NULL, kind text NOT NULL, customer_id text NOT NULL,
  amount_cents bigint NOT NULL DEFAULT 0, occurred_at timestamptz NOT NULL, raw jsonb NOT NULL DEFAULT '{}',
  UNIQUE (organization_id, provider_event_id)
);
CREATE TABLE metric_points (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source text NOT NULL, metric text NOT NULL, dimension jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL, value double precision NOT NULL
);
CREATE INDEX metric_points_lookup ON metric_points (organization_id, source, metric, at);
CREATE TABLE page_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url text NOT NULL, content_hash text NOT NULL, snapshot jsonb NOT NULL, captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE content_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_id uuid REFERENCES actions(id), url text NOT NULL, before_hash text, after_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL, content text NOT NULL, version int NOT NULL DEFAULT 1
);
CREATE TABLE experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_id uuid REFERENCES actions(id), hypothesis text NOT NULL, spec jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft', result jsonb, decision text,
  start_at timestamptz, end_at timestamptz
);
CREATE TABLE experiment_assignments (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  subject_id text NOT NULL, variant text NOT NULL, assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, subject_id)
);
CREATE TABLE suppressions (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email_hash text NOT NULL, reason text NOT NULL, at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, email_hash)
);
CREATE TABLE send_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_id uuid REFERENCES actions(id), recipient_hash text NOT NULL, provider_message_id text NOT NULL,
  idempotency_key text NOT NULL, sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE TABLE model_usage (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_id uuid REFERENCES actions(id), rate_version text NOT NULL,
  cached_input_tokens int NOT NULL, uncached_input_tokens int NOT NULL, output_tokens int NOT NULL,
  reasoning_mode text, retry_count int NOT NULL DEFAULT 0, cost_usd numeric NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE external_spend_ledger (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_id uuid REFERENCES actions(id), provider text NOT NULL, amount_usd numeric NOT NULL CHECK (amount_usd >= 0), at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL, body jsonb NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

SELECT qg_tenant_table('integrations');
SELECT qg_tenant_table('credential_references');
SELECT qg_tenant_table('conversion_events', 'SELECT, INSERT');
SELECT qg_tenant_table('identity_links');
SELECT qg_tenant_table('subscriptions_observed');
SELECT qg_tenant_table('revenue_events', 'SELECT, INSERT');
SELECT qg_tenant_table('metric_points');
SELECT qg_tenant_table('page_snapshots');
SELECT qg_tenant_table('content_revisions');
SELECT qg_tenant_table('knowledge_items');
SELECT qg_tenant_table('experiments');
SELECT qg_tenant_table('experiment_assignments');
SELECT qg_tenant_table('suppressions');
SELECT qg_tenant_table('send_receipts', 'SELECT, INSERT');
SELECT qg_tenant_table('model_usage', 'SELECT, INSERT');
SELECT qg_tenant_table('external_spend_ledger', 'SELECT, INSERT');
SELECT qg_tenant_table('notifications');
DO $$ BEGIN EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA %I TO qg_app', current_schema()); END $$;
