WITH direct AS (
    SELECT e.source AS event, e.target,
        e.data->>'kind' AS kind,
        CASE WHEN e.data->>'kind' = 'participant' THEN 0 ELSE 1 END AS priority,
        '' AS field, '' AS record
    FROM __SCHEMA__.edges e WHERE e.field = 'event_link'
    UNION ALL
    SELECT source, target, 'field', 2, 'r_payment_invoice', ''
    FROM __SCHEMA__.edges WHERE field = 'r_payment_invoice'
), attached AS (
    SELECT * FROM direct
    UNION ALL
    SELECT d.event, r.target, 'rollup', 3, r.field, r.source
    FROM direct d JOIN __SCHEMA__.edges r ON r.source = d.target
    WHERE r.field = 'r_invoice_company' AND $5::boolean
), ranked AS (
    SELECT r.uid, (r.data->>'occurredAt')::bigint AS "occurredAt",
        a.kind, a.priority, a.field, a.record,
        row_number() OVER (PARTITION BY r.uid ORDER BY a.priority, a.field, a.record) AS rank
    FROM attached a JOIN __SCHEMA__.records r ON r.uid = a.event
    WHERE a.target = $1 AND (r.data->>'retracted')::boolean = false
        AND ((r.data->>'occurredAt')::bigint, r.uid) < ($2::bigint, $3)
)
SELECT uid, "occurredAt", kind, priority, field, record FROM ranked
WHERE rank = 1 ORDER BY "occurredAt" DESC, uid DESC LIMIT $4;
