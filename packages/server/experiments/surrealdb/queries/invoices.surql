-- Parameters: $afterAmount, $afterUid, $limit. One currency, integer minor units in fixture.
SELECT
  uid,
  f_amount AS amount,
  f_status AS status
FROM o_invoice
WHERE
  retracted = false
  AND (
    f_amount > $afterAmount
    OR (
      f_amount = $afterAmount
      AND uid > $afterUid
    )
  )
ORDER BY amount, uid
LIMIT $limit;
