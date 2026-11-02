-- Build step 5: the consolidator's run table and how workers find work
-- (ARCHITECTURE.md 4.2). Applied by the migration role, like 0001_security.

GRANT SELECT, INSERT, UPDATE ON "consolidator_runs" TO retainer_app;
--> statement-breakpoint
ALTER TABLE "consolidator_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "consolidator_runs"
  USING ("workspace_id" = "public"."retainer_current_workspace_id"())
  WITH CHECK ("workspace_id" = "public"."retainer_current_workspace_id"());
--> statement-breakpoint

-- Workers run as retainer_app, which sees one workspace at a time. This is
-- its only way to learn which workspaces exist: the IDs of those whose last
-- consolidator run started more than `min_interval` ago, or never ran,
-- oldest first. It returns IDs only.
CREATE FUNCTION "public"."retainer_workspaces_due"(min_interval interval)
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT w.id
    FROM public.workspaces AS w
    LEFT JOIN public.consolidator_runs AS r ON r.workspace_id = w.id
    WHERE r.started_at IS NULL OR r.started_at < now() - min_interval
    ORDER BY r.started_at NULLS FIRST, w.id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."retainer_workspaces_due"(interval) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."retainer_workspaces_due"(interval) TO retainer_app;
