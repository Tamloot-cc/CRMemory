ALTER TABLE "interaction_participants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interactions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "interaction_participants" CASCADE;--> statement-breakpoint
DROP TABLE "interactions" CASCADE;--> statement-breakpoint
DROP INDEX "fact_sources_interaction_idx";--> statement-breakpoint
DROP INDEX "field_assertions_source_idx";--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "core_role" text;--> statement-breakpoint
ALTER TABLE "object_types" ADD COLUMN "class" text DEFAULT 'entity' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fields_core_role_uq" ON "fields" USING btree ("object_type_id","core_role") WHERE "fields"."core_role" is not null and "fields"."status" = 'active';--> statement-breakpoint
ALTER TABLE "fact_sources" DROP COLUMN "interaction_id";--> statement-breakpoint
ALTER TABLE "field_assertions" DROP COLUMN "source_interaction_id";--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_core_role" CHECK ("fields"."core_role" is null or "fields"."core_role" in ('title', 'summary'));--> statement-breakpoint
ALTER TABLE "object_types" ADD CONSTRAINT "object_types_class" CHECK ("object_types"."class" in ('entity', 'event'));