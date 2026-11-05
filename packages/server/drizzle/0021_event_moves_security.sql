-- Event moves (ARCHITECTURE.md 1.3). Applied by the migration role, like
-- 0001_security: the runtime role's grants and workspace isolation. The log
-- is only ever added to, like deletion_audit_log.

GRANT SELECT, INSERT ON "event_moves" TO retainer_app;
--> statement-breakpoint
ALTER TABLE "event_moves" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "event_moves"
  USING ("workspace_id" = "public"."retainer_current_workspace_id"())
  WITH CHECK ("workspace_id" = "public"."retainer_current_workspace_id"());
