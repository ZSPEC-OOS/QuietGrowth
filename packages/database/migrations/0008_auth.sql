-- Auth: password credentials and ingest API keys.
ALTER TABLE users ADD COLUMN password_hash text;

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL, key_hash text NOT NULL UNIQUE, prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
SELECT qg_tenant_table('api_keys', 'SELECT, INSERT, UPDATE');

-- API-key lookup happens before a tenant is known; expose only the org id for a hash.
CREATE FUNCTION qg_org_for_api_key(h text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS
  $$ SELECT organization_id FROM api_keys WHERE key_hash = h AND revoked_at IS NULL $$;
REVOKE ALL ON FUNCTION qg_org_for_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qg_org_for_api_key(text) TO qg_app;
