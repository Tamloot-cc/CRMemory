CREATE INDEX "facts_record_idx" ON "facts" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "field_assertions_field_idx" ON "field_assertions" USING btree ("workspace_id","field_id");--> statement-breakpoint
CREATE INDEX "merge_suggestions_record_b_idx" ON "merge_suggestions" USING btree ("workspace_id","record_b_id");