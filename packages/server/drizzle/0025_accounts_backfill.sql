-- Every workspace belongs to an organization (accounts spec 4.2). Existing
-- workspaces move into one "Default" organization, which starts with no
-- owner: an operator adds the first with `retainer member add`. A database
-- with no workspaces gets none; bootstrap creates it with the first workspace.
INSERT INTO "organizations" ("name")
  SELECT 'Default' WHERE EXISTS (SELECT 1 FROM "workspaces");
--> statement-breakpoint
UPDATE "workspaces" SET "organization_id" = (
  SELECT "id" FROM "organizations" WHERE "name" = 'Default' ORDER BY "created_at" LIMIT 1
) WHERE "organization_id" IS NULL;
