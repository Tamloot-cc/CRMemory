-- Parameters: $target (logical uid), $beforeTime, $beforeUid, $limit.
-- Native graph walks are fixed: direct attachment, then at most one invoice-company hop.
LET $rollup = (
  SELECT VALUE metadata.relations.r_invoice_company.rollUp
  FROM ONLY control:main
);
LET $events = SELECT
  uid,
  occurredAt,
  array::concat(
    (
      SELECT
        kind,
        IF kind = 'participant' {
          0;
        } ELSE {
          1;
        } AS priority,
        '' AS field,
        '' AS record
      FROM ->event_link
      WHERE targetUid = $target
    ),
    (
      SELECT
        'field' AS kind,
        2 AS priority,
        'r_payment_invoice' AS field,
        '' AS record
      FROM ->r_payment_invoice
      WHERE targetUid = $target
    ),
    (
      SELECT
        'rollup' AS kind,
        3 AS priority,
        'r_invoice_company' AS field,
        targetUid AS record
      FROM ->r_payment_invoice
      WHERE
        $rollup
        AND out->r_invoice_company->o_company.uid CONTAINS $target
    ),
    (
      SELECT
        'rollup' AS kind,
        3 AS priority,
        'r_invoice_company' AS field,
        targetUid AS record
      FROM ->event_link
      WHERE
        $rollup
        AND out->r_invoice_company->o_company.uid CONTAINS $target
    )
  ) AS paths
FROM o_payment, o_meeting
WHERE
  retracted = false
  AND (
    occurredAt < $beforeTime
    OR (
      occurredAt = $beforeTime
      AND uid < $beforeUid
    )
  )
ORDER BY occurredAt DESC, uid DESC;
SELECT
  uid,
  occurredAt,
  paths
FROM $events
WHERE array::len(paths) > 0
LIMIT $limit;
