-- QuietGrowth's own commercial model (MR §16, §23).
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('self_host','hosted_starter','growth','team')),
  status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE entitlements (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (organization_id, key)
);
CREATE TABLE usage_records (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meter text NOT NULL, quantity numeric NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE runtime_cells (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  instance_id text NOT NULL, image text NOT NULL, status text NOT NULL, port int, updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT qg_tenant_table('subscriptions');
SELECT qg_tenant_table('entitlements');
SELECT qg_tenant_table('usage_records', 'SELECT, INSERT');
SELECT qg_tenant_table('runtime_cells', 'SELECT');
DO $$ BEGIN EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA %I TO qg_app', current_schema()); END $$;
