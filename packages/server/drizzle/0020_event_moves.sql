CREATE TABLE "event_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor" jsonb NOT NULL,
	"from_object_type_id" uuid NOT NULL,
	"to_object_type_id" uuid NOT NULL,
	"event_ids" uuid[] NOT NULL,
	"fields" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_moves" ADD CONSTRAINT "event_moves_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_moves" ADD CONSTRAINT "event_moves_from_object_type_fk" FOREIGN KEY ("workspace_id","from_object_type_id") REFERENCES "public"."object_types"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_moves" ADD CONSTRAINT "event_moves_to_object_type_fk" FOREIGN KEY ("workspace_id","to_object_type_id") REFERENCES "public"."object_types"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_moves_workspace_idx" ON "event_moves" USING btree ("workspace_id","created_at");