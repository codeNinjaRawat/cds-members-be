-- 0034 Contacts: people who use the member app as visitors of a masjid (no account). The app asks first name, last name,
-- email and mobile once ("My masjid"); from then on donations, the join form and event registrations start filled in.
-- One row per person and organization (email + mobile); a later sign-in or application is matched by email.
CREATE TABLE IF NOT EXISTS app.contacts (
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  center_id     uuid,                                  -- the masjid they chose (app.centers.id), null = organization
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  email         citext NOT NULL,
  phone         text NOT NULL DEFAULT '',              -- 10 digits, US
  source        text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'website', 'office', 'import')),
  note          text NOT NULL DEFAULT '',              -- the office's note
  ip            text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id) ON DELETE SET NULL,
  CHECK (email <> ''), CHECK (phone = '' OR phone ~ '^[0-9]{10}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_person ON app.contacts (org_id, lower(email::text), phone);
CREATE INDEX IF NOT EXISTS contacts_recent ON app.contacts (org_id, created_at DESC);
SELECT app.tenant_table('app.contacts');
