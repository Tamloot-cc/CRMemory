-- Search folds accents on both sides (5.1). `unaccent(text)` is only
-- STABLE because it looks its dictionary up by search_path; naming the
-- dictionary makes the result fixed, so retainer_fold can be IMMUTABLE and
-- Postgres computes a query built from constants once, not once per row.
CREATE FUNCTION "public"."retainer_fold"(text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT "public"."unaccent"('"public"."unaccent"'::regdictionary, $1) $$;
--> statement-breakpoint
-- Facts and interactions are searched by their own columns, so their new
-- vectors are computed here, as memory/facts.ts and memory/interactions.ts
-- write them (test/db/search-rebuild.test.ts checks they match).
UPDATE "facts" SET "search" = to_tsvector('simple', "public"."retainer_fold"("content"));
--> statement-breakpoint
UPDATE "interactions" SET "search" =
  setweight(to_tsvector('simple', "public"."retainer_fold"(coalesce("title", ''))), 'A')
  || setweight(to_tsvector('simple', "public"."retainer_fold"(coalesce("summary", ''))), 'B');
--> statement-breakpoint
-- Records also index the domains of emails and links, which only the server
-- derives from schema metadata: mark them stale, and every boot rebuilds
-- stale ones (records/rebuild-search.ts). Merged-away records keep none.
UPDATE "records" SET "search" = NULL WHERE "merged_into_id" IS NULL;
