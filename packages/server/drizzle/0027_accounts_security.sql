-- Account tables and the control role (accounts spec 4.2, 4.9). Applied by
-- the migration role, like 0001_security.
--
-- The account tables are not tenant tables. Row-level security is on with no
-- policy and no grants for the runtime role, so the API and workers cannot
-- read them; they ask through SECURITY DEFINER functions instead.
--
-- retainer_control does account work: sign-in, organizations, members,
-- invitations, and creating workspaces and keys. It owns nothing, has no
-- BYPASSRLS and no DDL. It holds retainer_app without inheriting its
-- privileges, so it can SET LOCAL ROLE retainer_app to seed a new workspace
-- under RLS, and has policies of its own on workspaces and api_keys.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retainer_control') THEN
    CREATE ROLE retainer_control NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- A container connects with the migration role and switches to the control
-- role at connection startup, as it does to the runtime role.
GRANT retainer_control TO CURRENT_USER;
--> statement-breakpoint
GRANT retainer_app TO retainer_control WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO retainer_control;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'sessions', 'auth_accounts', 'auth_verifications', 'passkeys',
    'auth_rate_limits', 'organizations', 'organization_members',
    'workspace_members', 'invitations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO retainer_control', t);
    EXECUTE format(
      'CREATE POLICY "control_access" ON %I TO retainer_control USING (true) WITH CHECK (true)',
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- Workspaces: the control role creates them, renames them, schedules and
-- carries out their deletion, and moves them between organizations. Seeding
-- runs as retainer_app, under the existing workspace policy.
GRANT SELECT, INSERT, DELETE ON "workspaces" TO retainer_control;
--> statement-breakpoint
GRANT UPDATE ("name", "organization_id", "deletion_scheduled_at", "updated_at")
  ON "workspaces" TO retainer_control;
--> statement-breakpoint
CREATE POLICY "control_access" ON "workspaces" TO retainer_control
  USING (true) WITH CHECK (true);
--> statement-breakpoint

-- API keys: workspace admins create, list and revoke them in the web app.
GRANT SELECT, INSERT ON "api_keys" TO retainer_control;
--> statement-breakpoint
GRANT UPDATE ("revoked_at") ON "api_keys" TO retainer_control;
--> statement-breakpoint
CREATE POLICY "control_access" ON "api_keys" TO retainer_control
  USING (true) WITH CHECK (true);
