-- Parameters: $deal (logical uid), $limit. Fixed path length, with supporting meetings.
SELECT
  uid AS buyer,
  <-(event_link WHERE kind = 'participant')<-o_meeting[WHERE retracted = false].{ uid, contacts: ->(event_link WHERE kind = 'participant')->o_person.uid } AS meetings
FROM o_person
WHERE
  uid IN (
    SELECT VALUE out.uid
    FROM r_stakeholder_person
    WHERE
      in.f_role = 'decision_maker'
      AND in->r_stakeholder_deal->o_deal.uid CONTAINS $deal
  )
ORDER BY buyer
LIMIT $limit;
