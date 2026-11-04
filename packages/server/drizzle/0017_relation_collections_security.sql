-- Collection relations (ARCHITECTURE.md 1.1, spec 5.3). Applied by the
-- migration role, like 0001_security.

-- Every existing inverse relation field is marked as such: the engine now
-- tells the read-only side by `isInverse`, not by its cardinality, since the
-- inverse of a many_to_many field is many_to_many too.
UPDATE "fields"
SET "settings" = "settings" || '{"isInverse": true}'::jsonb
WHERE "type" = 'relation' AND "settings" ->> 'relationCardinality' = 'one_to_many';
--> statement-breakpoint

-- An edge belongs to the owning side of a relation, and whether it is one
-- of a set comes from its field, never from the writer. With the partial
-- unique index on (source_record_id, field_id) where not is_collection, the
-- database itself holds a single-record field to one target, even for a
-- writer that bypasses the application or claims is_collection.
CREATE FUNCTION "public"."retainer_check_record_link"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  field_type text;
  field_settings jsonb;
BEGIN
  SELECT f.type, f.settings INTO field_type, field_settings
  FROM public.fields f
  WHERE f.id = NEW.field_id AND f.workspace_id = NEW.workspace_id;
  IF NOT FOUND OR field_type <> 'relation' THEN
    RAISE EXCEPTION 'record_links.field_id must be a relation field of the same workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce((field_settings ->> 'isInverse')::boolean, false) THEN
    RAISE EXCEPTION 'record_links belong to the owning side of a relation, not its inverse'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.is_collection := (field_settings ->> 'relationCardinality') = 'many_to_many';
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "record_links_check" BEFORE INSERT OR UPDATE ON "record_links"
  FOR EACH ROW EXECUTE FUNCTION "public"."retainer_check_record_link"();
