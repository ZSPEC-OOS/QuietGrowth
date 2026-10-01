-- Login must find a user's memberships before any tenant is bound. Expose only (org, role) for a user id.
CREATE FUNCTION qg_memberships_for_user(uid uuid) RETURNS TABLE (organization_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS
  $$ SELECT m.organization_id, m.role FROM organization_members m WHERE m.user_id = uid ORDER BY m.created_at $$;
REVOKE ALL ON FUNCTION qg_memberships_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qg_memberships_for_user(uuid) TO qg_app;

-- Experiment assignment is idempotent; first assignment wins.
CREATE UNIQUE INDEX IF NOT EXISTS experiment_assignments_pk_idx ON experiment_assignments (experiment_id, subject_id);
