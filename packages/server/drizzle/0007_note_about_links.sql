-- The notes remember creates now link their record as `about` (1.3, 6.2).
-- Earlier notes listed it as a participant with role "subject"; move those
-- rows to the new shape so every note reads the same way.
UPDATE "interaction_participants" p
SET "link" = 'about', "role" = NULL
FROM "interactions" i
WHERE i."id" = p."interaction_id"
  AND i."kind" = 'note'
  AND i."channel" = 'retainer'
  AND p."role" = 'subject'
  AND p."handle" IS NULL
  AND p."unmatched_reason" IS NULL;
