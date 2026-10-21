-- 0036 People: everyone is a contact first (app visitor, website, office); a contact may become a member and/or a donor.
-- The contact row is the person's root. Members and donors keep their own tables; the link is the email (+ mobile) and,
-- once known, member_id. Existing members and donors get their contact row here so the People list is complete.
ALTER TABLE app.contacts DROP CONSTRAINT IF EXISTS contacts_source_check;
ALTER TABLE app.contacts ADD CONSTRAINT contacts_source_check CHECK (source IN ('app', 'website', 'office', 'import', 'member', 'donation', 'event'));
ALTER TABLE app.contacts ADD COLUMN IF NOT EXISTS member_id text;                      -- set when the person became a member (or was one)
ALTER TABLE app.contacts ADD COLUMN IF NOT EXISTS became_member_at timestamptz;
ALTER TABLE app.contacts ADD COLUMN IF NOT EXISTS first_gift_at timestamptz;           -- set on the first recorded gift
ALTER TABLE app.contacts ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';     -- office tags ("youth", "new to Houston")
CREATE INDEX IF NOT EXISTS contacts_member ON app.contacts (org_id, member_id) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_email_only ON app.contacts (org_id, lower(email::text));

-- members → contacts (one per email; the member's own mobile)
INSERT INTO app.contacts (org_id, center_id, first_name, last_name, email, phone, source, member_id, became_member_at, created_at, last_seen_at)
SELECT DISTINCT ON (m.org_id, lower(m.email::text)) m.org_id, m.center_id, m.first_name, m.last_name, m.email, coalesce(regexp_replace(m.phone, '\D', '', 'g'), ''),
       'member', m.id, coalesce(m.approved_on, m.applied_on)::timestamptz, coalesce(m.applied_on::timestamptz, now()), now()
FROM app.members m
WHERE m.email <> '' AND m.archived IS NULL AND NOT EXISTS (SELECT 1 FROM app.contacts c WHERE c.org_id = m.org_id AND lower(c.email::text) = lower(m.email::text))
ORDER BY m.org_id, lower(m.email::text), m.approved_on DESC NULLS LAST
ON CONFLICT DO NOTHING;

-- contacts that already are members (same email) → link
UPDATE app.contacts c SET member_id = m.id, became_member_at = coalesce(c.became_member_at, coalesce(m.approved_on, m.applied_on)::timestamptz)
FROM app.members m
WHERE m.org_id = c.org_id AND lower(m.email::text) = lower(c.email::text) AND m.archived IS NULL AND c.member_id IS NULL;

-- donors who are not contacts yet (gifts with an email) → contacts
INSERT INTO app.contacts (org_id, center_id, first_name, last_name, email, phone, source, first_gift_at, created_at, last_seen_at)
SELECT DISTINCT ON (d.org_id, lower(d.donor_email::text)) d.org_id, d.center_id,
       coalesce(nullif(split_part(d.donor_name, ' ', 1), ''), 'Donor'), coalesce(nullif(substr(d.donor_name, length(split_part(d.donor_name, ' ', 1)) + 2), ''), ''),
       d.donor_email, '', 'donation', min(d.given_on) OVER (PARTITION BY d.org_id, lower(d.donor_email::text)), min(d.given_on) OVER (PARTITION BY d.org_id, lower(d.donor_email::text)), now()
FROM app.donations d
WHERE d.donor_email <> '' AND d.state IN ('ok', 'awaiting-payout') AND NOT EXISTS (SELECT 1 FROM app.contacts c WHERE c.org_id = d.org_id AND lower(c.email::text) = lower(d.donor_email::text))
ORDER BY d.org_id, lower(d.donor_email::text), d.given_on
ON CONFLICT DO NOTHING;

UPDATE app.contacts c SET first_gift_at = g.first
FROM (SELECT org_id, lower(donor_email::text) AS email, min(given_on)::timestamptz AS first FROM app.donations WHERE state IN ('ok', 'awaiting-payout') AND donor_email <> '' GROUP BY 1, 2) g
WHERE g.org_id = c.org_id AND g.email = lower(c.email::text) AND c.first_gift_at IS NULL;
