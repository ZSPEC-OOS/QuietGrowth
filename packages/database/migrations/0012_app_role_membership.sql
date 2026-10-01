-- Managed Postgres (Neon, Supabase, RDS) connects as a non-superuser owner. The application connects as that same login and
-- switches to qg_app per transaction (SET LOCAL ROLE), so the login must be a member of qg_app.
-- (Superusers, as in local development, can SET ROLE regardless; the grant is then a harmless no-op.)
GRANT qg_app TO CURRENT_USER;
