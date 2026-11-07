-- retainer_session_access finds the workspace by its ID only. The API already
-- requires an ID in X-Retainer-Workspace; matching slugs too could find two
-- workspaces when one's slug is another's ID. Same signature and grants as
-- 0028, so CREATE OR REPLACE keeps them.
CREATE OR REPLACE FUNCTION "public"."retainer_session_access"(session_token text, workspace text)
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
      ON w.id = CASE WHEN workspace ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
          THEN workspace::uuid END
      AND w.deletion_scheduled_at IS NULL
    LEFT JOIN public.organization_members AS om
      ON om.organization_id = w.organization_id AND om.user_id = u.id
    LEFT JOIN public.workspace_members AS wm
      ON wm.workspace_id = w.id AND wm.user_id = u.id
    WHERE s.token = session_token AND s.expires_at > now()
  $$;
