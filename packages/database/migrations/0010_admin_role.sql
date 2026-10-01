-- Internal operations role (apps/admin): cross-tenant reads for support and incident tooling, narrow writes only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qg_admin') THEN
    CREATE ROLE qg_admin NOLOGIN NOSUPERUSER BYPASSRLS;
  END IF;
END $$;
DO $$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO qg_admin', current_schema()); END $$;
GRANT SELECT ON organizations, subscriptions, runtime_cells, integrations, actions, audit_logs, executions TO qg_admin;
GRANT UPDATE (status) ON subscriptions TO qg_admin;
GRANT INSERT, UPDATE ON runtime_cells TO qg_admin;
GRANT INSERT ON audit_logs TO qg_admin;
DO $$ BEGIN EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA %I TO qg_admin', current_schema()); END $$;
