-- How the API checks a person's session (accounts spec 4.4). The runtime role
-- has no access to the account tables, so it asks this one function. It
-- takes the session token, not a user ID, so the runtime role cannot ask
-- about an arbitrary person. The API checks the cookie's signature first: a
-- token read from the database alone is refused there.
--
-- No row: the session is unknown, expired or revoked, or the person is
-- disabled. A row with a null role: the person has no access to that
-- workspace, or it does not exist or is being deleted. Otherwise the
-- effective role (shared/roles.ts): admin for organization owners and
-- admins, else the role set in the workspace.
CREATE FUNCTION "public"."retainer_session_access"(session_token text, workspace text)
  RETURNS TABLE (user_id uuid, user_name text, workspace_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT u.id, u.name, w.id,
      CASE
        WHEN om.role IN ('owner', 'admin') THEN 'admin'
        WHEN om.role = 'member' THEN wm.role
      END
    FROM public.sessions AS s
    JOIN public.users AS u ON u.id = s.user_id AND u.disabled_at IS NULL
    LEFT JOIN public.workspaces AS w
      ON (
        w.id = CASE WHEN workspace ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
          THEN workspace::uuid END
        OR w.slug = workspace
      )
      AND w.deletion_scheduled_at IS NULL
    LEFT JOIN public.organization_members AS om
      ON om.organization_id = w.organization_id AND om.user_id = u.id
    LEFT JOIN public.workspace_members AS wm
      ON wm.workspace_id = w.id AND wm.user_id = u.id
    WHERE s.token = session_token AND s.expires_at > now()
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."retainer_session_access"(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."retainer_session_access"(text, text) TO retainer_app;
