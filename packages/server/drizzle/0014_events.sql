CREATE TABLE "event_identity_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"hmac" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"handle" text,
	"role" text,
	"record_id" uuid,
	"unmatched_reason" text,
	"link" text NOT NULL,
	CONSTRAINT "event_links_unmatched_reason" CHECK ("event_links"."unmatched_reason" in ('no_match', 'phone_only', 'deleted_record', 'ambiguous', 'suppressed')),
	CONSTRAINT "event_links_link" CHECK ("event_links"."link" in ('participant', 'about')),
	CONSTRAINT "event_links_about_shape" CHECK ("event_links"."link" = 'participant' or ("event_links"."handle" is null and "event_links"."role" is null and "event_links"."unmatched_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "event_records" (
	"workspace_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"channel" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_records_pk" PRIMARY KEY("record_id"),
	CONSTRAINT "event_records_workspace_record_uq" UNIQUE("workspace_id","record_id")
);
--> statement-breakpoint
ALTER TABLE "fact_sources" ADD COLUMN "source_record_id" uuid;--> statement-breakpoint
ALTER TABLE "field_assertions" ADD COLUMN "source_record_id" uuid;--> statement-breakpoint
ALTER TABLE "field_assertions" ADD COLUMN "is_initial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_identity_tombstones" ADD CONSTRAINT "event_identity_tombstones_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_links" ADD CONSTRAINT "event_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_links" ADD CONSTRAINT "event_links_event_fk" FOREIGN KEY ("workspace_id","event_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_records" ADD CONSTRAINT "event_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_records" ADD CONSTRAINT "event_records_record_fk" FOREIGN KEY ("workspace_id","record_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_identity_tombstones_uq" ON "event_identity_tombstones" USING btree ("workspace_id","key_id","hmac");--> statement-breakpoint
CREATE INDEX "event_links_event_idx" ON "event_links" USING btree ("event_id","position");--> statement-breakpoint
CREATE INDEX "event_links_record_idx" ON "event_links" USING btree ("workspace_id","record_id","link");--> statement-breakpoint
CREATE INDEX "event_links_deleted_record_idx" ON "event_links" USING btree ("workspace_id") WHERE "event_links"."unmatched_reason" = 'deleted_record';--> statement-breakpoint
CREATE UNIQUE INDEX "event_records_external_uq" ON "event_records" USING btree ("workspace_id","channel","external_id") WHERE "event_records"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "event_records_workspace_time_idx" ON "event_records" USING btree ("workspace_id","occurred_at","record_id");--> statement-breakpoint
CREATE INDEX "fact_sources_source_idx" ON "fact_sources" USING btree ("source_record_id");--> statement-breakpoint
CREATE INDEX "field_assertions_source_idx" ON "field_assertions" USING btree ("source_record_id") WHERE "field_assertions"."source_record_id" is not null;--> statement-breakpoint
CREATE INDEX "field_assertions_initial_idx" ON "field_assertions" USING btree ("record_id","field_id") WHERE "field_assertions"."is_initial";