DROP INDEX "record_links_target_idx";--> statement-breakpoint
CREATE INDEX "event_records_record_time_idx" ON "event_records" USING btree ("record_id","occurred_at");--> statement-breakpoint
CREATE INDEX "record_links_target_idx" ON "record_links" USING btree ("workspace_id","target_record_id","field_id","source_record_id");