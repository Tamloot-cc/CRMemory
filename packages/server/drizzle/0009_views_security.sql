-- Saved views (ARCHITECTURE.md 1.4). Applied by the migration role, like
-- 0001_security: the runtime role's grants and workspace isolation.

GRANT SELECT, INSERT, UPDATE, DELETE ON "views" TO retainer_app;
--> statement-breakpoint
ALTER TABLE "views" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "views"
  USING ("workspace_id" = "public"."retainer_current_workspace_id"())
  WITH CHECK ("workspace_id" = "public"."retainer_current_workspace_id"());
