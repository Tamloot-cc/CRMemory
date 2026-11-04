CREATE TABLE "views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"visibility" text NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "views_kind" CHECK ("views"."kind" in ('table', 'board', 'calendar')),
	CONSTRAINT "views_visibility" CHECK ("views"."visibility" in ('workspace', 'private'))
);
--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_object_type_fk" FOREIGN KEY ("workspace_id","object_type_id") REFERENCES "public"."object_types"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "views_object_idx" ON "views" USING btree ("workspace_id","object_type_id","position");