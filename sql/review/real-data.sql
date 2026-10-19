-- Review queries for the imported Wild Apricot records. Counts only – no names, emails or phones are printed.
-- Run all of them:  cd BE && npm run report:members      (one organization; DEFAULT_ORG or --org <slug>)
-- Or in psql / pgAdmin: SET app.org_id = '<organization uuid>';  then run any block (each starts with "-- name:").

-- name: Totals
SELECT count(*) AS members,
       count(*) FILTER (WHERE external_ids ? 'wildapricot') AS from_wild_apricot,
       count(*) FILTER (WHERE status IN ('active', 'life')) AS current,
       count(*) FILTER (WHERE status = 'pending') AS waiting_for_approval
FROM app.members;

-- name: Status here vs status in Wild Apricot
SELECT coalesce(nullif(record->'wildapricot'->>'status', ''), '(blank)') AS wild_apricot_status, status AS status_here, count(*) AS people
FROM app.members GROUP BY 1, 2 ORDER BY 1, 3 DESC;

-- name: Plans vs Wild Apricot levels
SELECT coalesce(nullif(record->'wildapricot'->>'level', ''), '(blank)') AS wild_apricot_level, plan, count(*) AS people
FROM app.members GROUP BY 1, 2 ORDER BY 3 DESC;

-- name: People by zone and masjid
SELECT coalesce(z.name, '(no zone)') AS zone, coalesce(c.name, '(no masjid)') AS masjid, count(*) AS people,
       count(*) FILTER (WHERE m.status IN ('active', 'life')) AS current,
       count(*) FILTER (WHERE m.center_override IS NOT NULL) AS chose_another_masjid
FROM app.members m LEFT JOIN app.centers c ON c.org_id = m.org_id AND c.id = m.center_id
LEFT JOIN app.zones z ON z.org_id = c.org_id AND z.id = c.zone_id
GROUP BY 1, 2 ORDER BY 1, 3 DESC;

-- name: Renewals due (current members, next 12 months)
SELECT to_char(paid_through, 'YYYY-MM') AS month, count(*) AS people
FROM app.members WHERE status = 'active' AND paid_through < current_date + 365 GROUP BY 1 ORDER BY 1;

-- name: Expired by year the membership ended
SELECT coalesce(t.ended::text, '(no end date)') AS ended, count(*) AS people
FROM app.members m LEFT JOIN LATERAL (SELECT extract(year FROM max(ms.ends_on))::int AS ended FROM app.memberships ms WHERE ms.org_id = m.org_id AND ms.member_id = m.id) t ON true
WHERE m.status = 'expired' GROUP BY 1 ORDER BY 1 DESC;

-- name: Joined by year
SELECT joined_year, count(*) AS people FROM app.members GROUP BY 1 ORDER BY 1 DESC LIMIT 30;

-- name: Missing or doubtful details
SELECT count(*) FILTER (WHERE coalesce(email::text, '') = '') AS no_email,
       count(*) FILTER (WHERE coalesce(phone, '') = '') AS no_phone,
       count(*) FILTER (WHERE dob IS NULL) AS no_birth_date,
       count(*) FILTER (WHERE dob > current_date - interval '18 years') AS under_18,
       count(*) FILTER (WHERE coalesce(zip, '') = '') AS no_zip,
       count(*) FILTER (WHERE center_id IS NULL) AS no_masjid,
       count(*) FILTER (WHERE coalesce(gender, '') = '') AS no_gender
FROM app.members;

-- name: Shared emails (households using one address)
SELECT people_per_email, count(*) AS emails FROM (
  SELECT lower(email::text) AS e, count(*) AS people_per_email FROM app.members WHERE coalesce(email::text, '') <> '' GROUP BY 1 HAVING count(*) > 1) x
GROUP BY 1 ORDER BY 1;

-- name: Households
SELECT count(*) FILTER (WHERE spouse_id IS NOT NULL) / 2 AS couples_linked,
       count(*) FILTER (WHERE plan = 'family') AS on_family_plan,
       count(*) FILTER (WHERE plan = 'family' AND spouse_id IS NULL) AS family_plan_without_spouse_link
FROM app.members;

-- name: Contact preferences
SELECT count(*) FILTER (WHERE (prefs->>'email')::boolean) AS email_ok,
       count(*) FILTER (WHERE (prefs->>'sms')::boolean) AS sms_ok,
       count(*) FILTER (WHERE prefs->'optOut' ? 'newsletter') AS no_newsletter,
       count(*) FILTER (WHERE prefs->'optOut' ? 'events') AS no_event_mail
FROM app.members;

-- name: Membership terms
SELECT status, how, count(*) AS terms, count(*) FILTER (WHERE ends_on IS NULL) AS lifetime, min(ends_on) AS earliest_end, max(ends_on) AS latest_end
FROM app.memberships GROUP BY 1, 2 ORDER BY 3 DESC;

-- name: Imports
SELECT preset, rows_total, rows_created, rows_skipped, status, at FROM app.imports ORDER BY at DESC LIMIT 5;
