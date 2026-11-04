SELECT uid, (data->>'f_amount')::numeric AS amount, data->>'f_status' AS status
FROM __SCHEMA__.records WHERE kind = 'invoice' AND (data->>'retracted')::boolean = false
    AND ((data->>'f_amount')::numeric, uid) > ($1::numeric, $2)
ORDER BY amount, uid LIMIT $3;
