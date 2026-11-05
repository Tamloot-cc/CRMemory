-- Comments (ARCHITECTURE.md 1.3). Applied by the migration role, like
-- 0001_security: the runtime role's grants and workspace isolation. DELETE is
-- for forget, which hard-deletes the comments on what it erases (2.1).

GRANT SELECT, INSERT, UPDATE, DELETE ON "comments" TO retainer_app;
--> statement-breakpoint
ALTER TABLE "comments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "comments"
  USING ("workspace_id" = "public"."retainer_current_workspace_id"())
  WITH CHECK ("workspace_id" = "public"."retainer_current_workspace_id"());
