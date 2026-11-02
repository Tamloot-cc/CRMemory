ALTER TABLE "interaction_participants" ADD COLUMN "position" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "interaction_participants" ADD COLUMN "unmatched_reason" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "request_hash" text NOT NULL;--> statement-breakpoint
CREATE INDEX "field_assertions_source_idx" ON "field_assertions" USING btree ("source_interaction_id") WHERE "field_assertions"."source_interaction_id" is not null;--> statement-breakpoint
CREATE INDEX "interaction_participants_deleted_record_idx" ON "interaction_participants" USING btree ("workspace_id") WHERE "interaction_participants"."unmatched_reason" = 'deleted_record';--> statement-breakpoint
ALTER TABLE "interaction_participants" ADD CONSTRAINT "interaction_participants_unmatched_reason" CHECK ("interaction_participants"."unmatched_reason" in ('no_match', 'phone_only', 'deleted_record', 'ambiguous'));