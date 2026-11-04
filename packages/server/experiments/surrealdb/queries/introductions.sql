SELECT DISTINCT person.target AS buyer, meeting.uid AS meeting, participant.target AS introducer
FROM __SCHEMA__.records stakeholder
JOIN __SCHEMA__.edges deal ON deal.source = stakeholder.uid AND deal.field = 'r_stakeholder_deal'
JOIN __SCHEMA__.edges person ON person.source = stakeholder.uid AND person.field = 'r_stakeholder_person'
JOIN __SCHEMA__.edges attendance ON attendance.target = person.target
    AND attendance.field = 'event_link' AND attendance.data->>'kind' = 'participant'
JOIN __SCHEMA__.records meeting ON meeting.uid = attendance.source AND meeting.kind = 'meeting'
JOIN __SCHEMA__.edges participant ON participant.source = meeting.uid
    AND participant.field = 'event_link' AND participant.data->>'kind' = 'participant'
WHERE stakeholder.data->>'f_role' = 'decision_maker' AND deal.target = $1
    AND (meeting.data->>'retracted')::boolean = false
    AND participant.target != person.target
ORDER BY buyer, meeting, introducer LIMIT $2;
