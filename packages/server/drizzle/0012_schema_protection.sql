ALTER TABLE "fields" ADD COLUMN "is_protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "object_types" ADD COLUMN "is_protected" boolean DEFAULT false NOT NULL;