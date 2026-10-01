-- Helper: apply forced RLS keyed on organization_id and grant DML to qg_app.
CREATE FUNCTION qg_tenant_table(tbl regclass, grants text DEFAULT 'SELECT, INSERT, UPDATE, DELETE') RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (organization_id = qg_current_org()) WITH CHECK (organization_id = qg_current_org())', tbl);
  EXECUTE format('GRANT %s ON %s TO qg_app', grants, tbl);
END $$;
