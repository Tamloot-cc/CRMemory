DROP INDEX "record_links_source_field_uq";--> statement-breakpoint
ALTER TABLE "record_links" ADD COLUMN "is_collection" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "record_links_edge_uq" ON "record_links" USING btree ("workspace_id","source_record_id","field_id","target_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_links_single_target_uq" ON "record_links" USING btree ("source_record_id","field_id") WHERE not "record_links"."is_collection";