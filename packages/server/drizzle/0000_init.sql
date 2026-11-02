CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"actor" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "deletion_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"counts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"interaction_id" uuid,
	"premise_fact_id" uuid,
	"quote" text
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"content" text NOT NULL,
	"kind" text NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"superseded_by" uuid,
	"search" "tsvector",
	"actor" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "facts_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "field_assertions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value" jsonb,
	"actor" jsonb NOT NULL,
	"source_interaction_id" uuid,
	"confidence" real DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"review_reason" text,
	"observed_at" timestamp with time zone NOT NULL,
	"reviewed_by" jsonb,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_type_id" uuid NOT NULL,
	"universal_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_nullable" boolean DEFAULT true NOT NULL,
	"is_unique" boolean DEFAULT false NOT NULL,
	"is_filterable" boolean DEFAULT false NOT NULL,
	"is_searchable" boolean DEFAULT false NOT NULL,
	"owner" text NOT NULL,
	"status" text NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fields_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interaction_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"handle" text,
	"display_name" text,
	"role" text,
	"record_id" uuid
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"external_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"title" text,
	"summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search" "tsvector",
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "interactions_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "merge_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"record_a_id" uuid NOT NULL,
	"record_b_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"decided_by" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "merge_suggestions_sorted_pair" CHECK ("merge_suggestions"."record_a_id" < "merge_suggestions"."record_b_id")
);
--> statement-breakpoint
CREATE TABLE "object_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"universal_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"status" text NOT NULL,
	"name_singular" text NOT NULL,
	"name_plural" text NOT NULL,
	"label_singular" text NOT NULL,
	"label_plural" text NOT NULL,
	"description" text,
	"label_field_id" uuid,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "object_types_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "record_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"is_claim" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"target_record_id" uuid NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_type_id" uuid NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search" "tsvector",
	"label" text,
	"merged_into_id" uuid,
	"created_by" jsonb NOT NULL,
	"updated_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "records_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "schema_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text NOT NULL,
	"request" jsonb NOT NULL,
	"operations" jsonb NOT NULL,
	"is_destructive" boolean NOT NULL,
	"reason" text,
	"requested_by" jsonb NOT NULL,
	"decided_by" jsonb,
	"applied_version" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"hmac" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"schema_version" integer DEFAULT 0 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"templates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"initialized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_audit_log" ADD CONSTRAINT "deletion_audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_sources" ADD CONSTRAINT "fact_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_sources" ADD CONSTRAINT "fact_sources_fact_fk" FOREIGN KEY ("workspace_id","fact_id") REFERENCES "public"."facts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_sources" ADD CONSTRAINT "fact_sources_premise_fk" FOREIGN KEY ("workspace_id","premise_fact_id") REFERENCES "public"."facts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_record_fk" FOREIGN KEY ("workspace_id","record_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_assertions" ADD CONSTRAINT "field_assertions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_assertions" ADD CONSTRAINT "field_assertions_record_fk" FOREIGN KEY ("workspace_id","record_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_assertions" ADD CONSTRAINT "field_assertions_field_fk" FOREIGN KEY ("workspace_id","field_id") REFERENCES "public"."fields"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_object_type_fk" FOREIGN KEY ("workspace_id","object_type_id") REFERENCES "public"."object_types"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_participants" ADD CONSTRAINT "interaction_participants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_participants" ADD CONSTRAINT "interaction_participants_interaction_fk" FOREIGN KEY ("workspace_id","interaction_id") REFERENCES "public"."interactions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_suggestions" ADD CONSTRAINT "merge_suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_suggestions" ADD CONSTRAINT "merge_suggestions_record_a_fk" FOREIGN KEY ("workspace_id","record_a_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_suggestions" ADD CONSTRAINT "merge_suggestions_record_b_fk" FOREIGN KEY ("workspace_id","record_b_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_types" ADD CONSTRAINT "object_types_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_identifiers" ADD CONSTRAINT "record_identifiers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_identifiers" ADD CONSTRAINT "record_identifiers_record_fk" FOREIGN KEY ("workspace_id","record_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_identifiers" ADD CONSTRAINT "record_identifiers_field_fk" FOREIGN KEY ("workspace_id","field_id") REFERENCES "public"."fields"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_links" ADD CONSTRAINT "record_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_links" ADD CONSTRAINT "record_links_field_fk" FOREIGN KEY ("workspace_id","field_id") REFERENCES "public"."fields"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_links" ADD CONSTRAINT "record_links_source_fk" FOREIGN KEY ("workspace_id","source_record_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_links" ADD CONSTRAINT "record_links_target_fk" FOREIGN KEY ("workspace_id","target_record_id") REFERENCES "public"."records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_object_type_fk" FOREIGN KEY ("workspace_id","object_type_id") REFERENCES "public"."object_types"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_changes" ADD CONSTRAINT "schema_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_workspace_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "deletion_audit_log_workspace_idx" ON "deletion_audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "fact_sources_fact_idx" ON "fact_sources" USING btree ("fact_id");--> statement-breakpoint
CREATE INDEX "fact_sources_interaction_idx" ON "fact_sources" USING btree ("interaction_id");--> statement-breakpoint
CREATE INDEX "facts_record_current_idx" ON "facts" USING btree ("record_id","valid_from") WHERE "facts"."valid_to" is null and "facts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "facts_search_gin" ON "facts" USING gin ("workspace_id","search");--> statement-breakpoint
CREATE INDEX "field_assertions_record_field_idx" ON "field_assertions" USING btree ("record_id","field_id","status");--> statement-breakpoint
CREATE INDEX "field_assertions_review_idx" ON "field_assertions" USING btree ("workspace_id","created_at") WHERE "field_assertions"."status" = 'pending_review';--> statement-breakpoint
CREATE UNIQUE INDEX "fields_universal_uq" ON "fields" USING btree ("workspace_id","universal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_key_uq" ON "fields" USING btree ("object_type_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_name_uq" ON "fields" USING btree ("object_type_id","name") WHERE "fields"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_uq" ON "idempotency_keys" USING btree ("workspace_id","operation","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "interaction_participants_interaction_idx" ON "interaction_participants" USING btree ("interaction_id");--> statement-breakpoint
CREATE INDEX "interaction_participants_record_idx" ON "interaction_participants" USING btree ("record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_external_uq" ON "interactions" USING btree ("workspace_id","channel","external_id") WHERE "interactions"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "interactions_workspace_time_idx" ON "interactions" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "interactions_search_gin" ON "interactions" USING gin ("workspace_id","search");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_suggestions_pair_uq" ON "merge_suggestions" USING btree ("workspace_id","record_a_id","record_b_id");--> statement-breakpoint
CREATE INDEX "merge_suggestions_pending_idx" ON "merge_suggestions" USING btree ("workspace_id","created_at") WHERE "merge_suggestions"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "object_types_universal_uq" ON "object_types" USING btree ("workspace_id","universal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "object_types_singular_uq" ON "object_types" USING btree ("workspace_id","name_singular") WHERE "object_types"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "object_types_plural_uq" ON "object_types" USING btree ("workspace_id","name_plural") WHERE "object_types"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "record_identifiers_claim_uq" ON "record_identifiers" USING btree ("workspace_id","field_id","value") WHERE "record_identifiers"."is_claim";--> statement-breakpoint
CREATE INDEX "record_identifiers_lookup_idx" ON "record_identifiers" USING btree ("workspace_id","kind","value");--> statement-breakpoint
CREATE INDEX "record_identifiers_record_idx" ON "record_identifiers" USING btree ("record_id","field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_links_source_field_uq" ON "record_links" USING btree ("source_record_id","field_id");--> statement-breakpoint
CREATE INDEX "record_links_target_idx" ON "record_links" USING btree ("target_record_id","field_id");--> statement-breakpoint
CREATE INDEX "records_workspace_object_idx" ON "records" USING btree ("workspace_id","object_type_id","created_at");--> statement-breakpoint
CREATE INDEX "records_data_gin" ON "records" USING gin ("workspace_id","object_type_id","data" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "records_search_gin" ON "records" USING gin ("workspace_id","search");--> statement-breakpoint
CREATE INDEX "records_label_trgm" ON "records" USING gin ("workspace_id","label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "schema_changes_workspace_status_idx" ON "schema_changes" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_uq" ON "suppressions" USING btree ("workspace_id","kind","hmac");