CREATE TABLE "consolidator_runs" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"compared_until" timestamp with time zone NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interaction_participants" DROP CONSTRAINT "interaction_participants_unmatched_reason";--> statement-breakpoint
ALTER TABLE "consolidator_runs" ADD CONSTRAINT "consolidator_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_participants" ADD CONSTRAINT "interaction_participants_unmatched_reason" CHECK ("interaction_participants"."unmatched_reason" in ('no_match', 'phone_only', 'deleted_record', 'ambiguous', 'suppressed'));