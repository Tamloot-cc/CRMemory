-- Security and constraints that Drizzle cannot express (ARCHITECTURE.md 7, 11).
-- Applied by the migration role, which owns every table. The API and workers
-- run as `retainer_app`, which owns nothing and has no BYPASSRLS, so
-- row-level security holds them to the workspace in `app.workspace_id`.

-- Composite tenant foreign keys that clear only the referencing column on
-- delete (PostgreSQL 15+). A plain ON DELETE SET NULL would also null the
-- NOT NULL workspace_id.
ALTER TABLE "object_types" ADD CONSTRAINT "object_types_label_field_fk"
  FOREIGN KEY ("workspace_id", "label_field_id") REFERENCES "public"."fields" ("workspace_id", "id")
  ON DELETE SET NULL ("label_field_id");
--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_merged_into_fk"
  FOREIGN KEY ("workspace_id", "merged_into_id") REFERENCES "public"."records" ("workspace_id", "id")
  ON DELETE SET NULL ("merged_into_id");
--> statement-breakpoint
ALTER TABLE "interaction_participants" ADD CONSTRAINT "interaction_participants_record_fk"
  FOREIGN KEY ("workspace_id", "record_id") REFERENCES "public"."records" ("workspace_id", "id")
  ON DELETE SET NULL ("record_id");
--> statement-breakpoint
ALTER TABLE "field_assertions" ADD CONSTRAINT "field_assertions_source_interaction_fk"
  FOREIGN KEY ("workspace_id", "source_interaction_id") REFERENCES "public"."interactions" ("workspace_id", "id")
  ON DELETE SET NULL ("source_interaction_id");
--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_superseded_by_fk"
  FOREIGN KEY ("workspace_id", "superseded_by") REFERENCES "public"."facts" ("workspace_id", "id")
  ON DELETE SET NULL ("superseded_by");
--> statement-breakpoint
ALTER TABLE "fact_sources" ADD CONSTRAINT "fact_sources_interaction_fk"
  FOREIGN KEY ("workspace_id", "interaction_id") REFERENCES "public"."interactions" ("workspace_id", "id")
  ON DELETE SET NULL ("interaction_id");
--> statement-breakpoint

-- The runtime role. Roles are cluster-wide, so create it only once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retainer_app') THEN
    CREATE ROLE retainer_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- The server connects with the migration role's credentials and switches to
-- retainer_app at connection startup, which needs membership.
GRANT retainer_app TO CURRENT_USER;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO retainer_app;
--> statement-breakpoint
-- Workspaces are created by operators; at runtime only the schema engine and
-- templates update these columns.
GRANT SELECT ON "workspaces" TO retainer_app;
--> statement-breakpoint
GRANT UPDATE ("schema_version", "templates", "initialized_at", "updated_at") ON "workspaces" TO retainer_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "object_types", "fields", "schema_changes", "records", "record_links", "record_identifiers",
  "interactions", "interaction_participants", "field_assertions", "facts", "fact_sources",
  "merge_suggestions", "idempotency_keys", "suppressions"
  TO retainer_app;
--> statement-breakpoint
-- The audit log is append-only for the runtime role.
GRANT SELECT, INSERT ON "deletion_audit_log" TO retainer_app;
--> statement-breakpoint
-- No grant on api_keys: the runtime role reads keys only through
-- retainer_lookup_api_key below.

-- The workspace of the current transaction, or NULL when none is set. NULL
-- matches no row, so a query without a workspace sees nothing.
CREATE FUNCTION "public"."retainer_current_workspace_id"() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint

ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "workspaces"
  USING ("id" = "public"."retainer_current_workspace_id"())
  WITH CHECK ("id" = "public"."retainer_current_workspace_id"());
--> statement-breakpoint

-- RLS without a policy: no row is visible to any role except the owner.
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'object_types', 'fields', 'schema_changes', 'records', 'record_links', 'record_identifiers',
    'interactions', 'interaction_participants', 'field_assertions', 'facts', 'fact_sources',
    'merge_suggestions', 'idempotency_keys', 'suppressions', 'deletion_audit_log'
  ] LOOP
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

-- API-key lookup happens before the workspace is known. This is the only way
-- the runtime role can read api_keys: it takes the SHA-256 of a key and
-- returns the key's workspace, scopes and actor, or nothing when the key is
-- unknown or revoked.
CREATE FUNCTION "public"."retainer_lookup_api_key"(key_hash text)
  RETURNS TABLE (key_id uuid, workspace_id uuid, scopes text[], actor jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT k.id, k.workspace_id, k.scopes, k.actor
    FROM public.api_keys AS k
    WHERE k.hash = key_hash AND k.revoked_at IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."retainer_lookup_api_key"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."retainer_lookup_api_key"(text) TO retainer_app;
