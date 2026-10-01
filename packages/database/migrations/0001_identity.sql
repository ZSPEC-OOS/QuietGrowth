-- M0.2: identity domain + tenant isolation via row-level security (MR §16).

-- Application role. Not a superuser and not the table owner, so RLS always applies.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qg_app') THEN
    CREATE ROLE qg_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Users are global identities; membership carries tenancy.
CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

-- Current tenant. NULL when unset, so every policy below matches nothing (fail closed).
CREATE FUNCTION qg_current_org() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

ALTER TABLE organizations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations        FORCE  ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE  ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON organizations
  USING (id = qg_current_org()) WITH CHECK (id = qg_current_org());
CREATE POLICY member_isolation ON organization_members
  USING (organization_id = qg_current_org()) WITH CHECK (organization_id = qg_current_org());

-- Organization creation and user provisioning are control-plane (owner role) operations.
GRANT SELECT, UPDATE ON organizations TO qg_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_members TO qg_app;
GRANT SELECT ON users TO qg_app;
