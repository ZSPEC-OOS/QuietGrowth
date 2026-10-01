-- Encrypted secret blobs shared by the API and worker processes (AES-GCM sealed by the application; DB never sees plaintext).
CREATE TABLE secrets (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ref text NOT NULL, iv text NOT NULL, tag text NOT NULL, data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, ref)
);
SELECT qg_tenant_table('secrets', 'SELECT, INSERT, DELETE');
