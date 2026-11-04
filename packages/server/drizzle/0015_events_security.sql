-- Event records (ARCHITECTURE.md 1.3). Applied by the migration role, like
-- 0001_security: tenant foreign keys that clear one column, the runtime
-- role's grants, workspace isolation, and the rule that event-class records
-- and only they carry an `event_records` row.

-- Composite tenant foreign keys that clear only the referencing column on
-- delete (PostgreSQL 15+), as in 0001_security.
ALTER TABLE "event_links" ADD CONSTRAINT "event_links_record_fk"
  FOREIGN KEY ("workspace_id", "record_id") REFERENCES "public"."records" ("workspace_id", "id")
  ON DELETE SET NULL ("record_id");
--> statement-breakpoint
ALTER TABLE "field_assertions" ADD CONSTRAINT "field_assertions_source_record_fk"
  FOREIGN KEY ("workspace_id", "source_record_id") REFERENCES "public"."records" ("workspace_id", "id")
  ON DELETE SET NULL ("source_record_id");
--> statement-breakpoint
ALTER TABLE "fact_sources" ADD CONSTRAINT "fact_sources_source_record_fk"
  FOREIGN KEY ("workspace_id", "source_record_id") REFERENCES "public"."records" ("workspace_id", "id")
  ON DELETE SET NULL ("source_record_id");
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "event_records", "event_links" TO retainer_app;
--> statement-breakpoint
-- Tombstones are only ever added; erasure never undoes a suppression.
GRANT SELECT, INSERT ON "event_identity_tombstones" TO retainer_app;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_records', 'event_links', 'event_identity_tombstones'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON public.%I '
      'USING (workspace_id = public.retainer_current_workspace_id()) '
      'WITH CHECK (workspace_id = public.retainer_current_workspace_id())',
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- An event_records row belongs to an event-class record, and its time and
-- record never change. Erasure may clear the raw channel and external ID
-- (2.1); nothing may set new ones.
CREATE FUNCTION "public"."retainer_check_event_record"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.record_id IS DISTINCT FROM OLD.record_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
      OR (NEW.channel IS DISTINCT FROM OLD.channel AND NEW.channel IS NOT NULL)
      OR (NEW.external_id IS DISTINCT FROM OLD.external_id AND NEW.external_id IS NOT NULL) THEN
      RAISE EXCEPTION 'event_records columns are immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.records r
    JOIN public.object_types o ON o.id = r.object_type_id AND o.workspace_id = r.workspace_id
    WHERE r.id = NEW.record_id AND r.workspace_id = NEW.workspace_id AND o.class = 'event'
  ) THEN
    RAISE EXCEPTION 'record % is not an event record', NEW.record_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "event_records_check"
  BEFORE INSERT OR UPDATE ON "event_records"
  FOR EACH ROW EXECUTE FUNCTION "public"."retainer_check_event_record"();
--> statement-breakpoint

-- Every event-class record gets its event_records row in the transaction
-- that creates it. Checked at commit, so the record can be inserted first.
CREATE FUNCTION "public"."retainer_check_event_has_columns"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.object_types o
    WHERE o.id = NEW.object_type_id AND o.workspace_id = NEW.workspace_id AND o.class = 'event'
  ) AND EXISTS (SELECT 1 FROM public.records r WHERE r.id = NEW.id)
    AND NOT EXISTS (SELECT 1 FROM public.event_records e WHERE e.record_id = NEW.id) THEN
    RAISE EXCEPTION 'event record % has no event_records row', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "records_event_columns"
  AFTER INSERT ON "records"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."retainer_check_event_has_columns"();
