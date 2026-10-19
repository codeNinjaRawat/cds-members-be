-- 0013 Content and the rest: files (private storage index), records library, meeting minutes, prayer times,
-- member benefits (partners, offers, use log), imports (Wild Apricot, any spreadsheet) and the help for jobs.
-- Website pages, news, home, theme and every settings document stay in app.documents (0001).

-- files: every upload (photo IDs, records, minutes, event images) – the bytes live in object storage --------------------
CREATE TABLE IF NOT EXISTS app.files (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  storage_key text NOT NULL,                                 -- org/<org_id>/<area>/<uuid>.<ext>
  area        text NOT NULL CHECK (area IN ('id-check', 'record', 'minutes', 'event', 'brand', 'website', 'zakat', 'finance', 'ticket', 'other')),
  name        text NOT NULL,
  mime        text NOT NULL,
  bytes       bigint NOT NULL CHECK (bytes > 0 AND bytes <= 52428800),
  sha256      bytea NOT NULL,
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'members', 'public')),
  uploaded_by text NOT NULL DEFAULT '',
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  purge_after date,
  PRIMARY KEY (org_id, id),
  UNIQUE (storage_key)
);
SELECT app.tenant_table('app.files');

-- records library (R1) ----------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.records (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          text NOT NULL CHECK (id ~ '^[a-z0-9-]{2,60}$'),
  title       text NOT NULL,
  category    text NOT NULL CHECK (category IN ('minutes', 'report', 'financial', 'bylaws', 'policy', 'newsletter', 'form', 'election', 'other')),
  center_id   uuid,
  doc_date    date NOT NULL,
  audience    text NOT NULL DEFAULT 'members' CHECK (audience IN ('public', 'members', 'leaders')),
  url         text NOT NULL CHECK (url ~ '^(https://|/)'),
  file_id     uuid,
  summary     text NOT NULL DEFAULT '',
  source      text NOT NULL DEFAULT 'link' CHECK (source IN ('upload', 'link', 'wildapricot')),
  archived    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id)
);
CREATE INDEX IF NOT EXISTS records_list ON app.records (org_id, audience, doc_date DESC) WHERE NOT archived;
SELECT app.tenant_table('app.records');

-- meetings and minutes ----------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.meetings (
  org_id       uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id           text NOT NULL,
  body         text NOT NULL,                                 -- board | council | joint | general-assembly | masjid
  center_id    uuid,
  title        text NOT NULL,
  held_on      date NOT NULL,
  quorum       boolean,
  attendees    integer,
  notes        text NOT NULL DEFAULT '',
  decisions    jsonb NOT NULL DEFAULT '[]'::jsonb,            -- [{ text, result: Passed|Failed, votes }]
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published')),
  audience     text NOT NULL DEFAULT 'members' CHECK (audience IN ('members', 'leaders')),
  approved_on  date,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id)
);
CREATE INDEX IF NOT EXISTS meetings_list ON app.meetings (org_id, held_on DESC);
SELECT app.tenant_table('app.meetings');

-- prayer times: iqamah per masjid per day (adhan times are calculated; iqamah is set by each masjid) --------------------
CREATE TABLE IF NOT EXISTS app.iqamah (
  org_id      uuid NOT NULL,
  center_id   uuid NOT NULL,
  day         date NOT NULL,
  fajr        time, dhuhr time, asr time, maghrib time, isha time,
  note        text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, center_id, day),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.iqamah');
CREATE TABLE IF NOT EXISTS app.special_prayers (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  center_id   uuid,                                          -- null = all masjids
  kind        text NOT NULL CHECK (kind IN ('eid-fitr', 'eid-adha', 'taraweeh', 'janazah', 'tahajjud', 'other')),
  title       text NOT NULL,
  starts_at   timestamptz NOT NULL,
  place       text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, id)
);
SELECT app.tenant_table('app.special_prayers');

-- member benefits: partner businesses, offers, and when a member used one -----------------------------------------------
CREATE TABLE IF NOT EXISTS app.benefit_partners (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          text NOT NULL,
  name        text NOT NULL,
  category    text NOT NULL DEFAULT '',
  website     text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  address     text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, id)
);
SELECT app.tenant_table('app.benefit_partners');
CREATE TABLE IF NOT EXISTS app.benefit_offers (
  org_id      uuid NOT NULL,
  id          text NOT NULL,
  partner_id  text NOT NULL,
  title       text NOT NULL,
  details     text NOT NULL DEFAULT '',
  plan_ids    text[] NOT NULL DEFAULT '{}',                  -- empty = every current member
  code        text NOT NULL DEFAULT '',                       -- shown to signed-in members only
  starts_on   date,
  ends_on     date,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, partner_id) REFERENCES app.benefit_partners(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.benefit_offers');
CREATE TABLE IF NOT EXISTS app.benefit_uses (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL,
  offer_id    text NOT NULL,
  member_id   text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  how         text NOT NULL DEFAULT 'card-shown',
  FOREIGN KEY (org_id, offer_id) REFERENCES app.benefit_offers(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.benefit_uses', true);

-- imports (Members › Import: Wild Apricot, Breeze / Planning Center, any spreadsheet) ------------------------------------
CREATE TABLE IF NOT EXISTS app.imports (
  org_id       uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  preset       text NOT NULL DEFAULT 'spreadsheet',           -- wildapricot | breeze | planning-center | spreadsheet
  file_id      uuid,
  mapping      jsonb NOT NULL DEFAULT '{}'::jsonb,
  rows_total   integer NOT NULL DEFAULT 0,
  rows_created integer NOT NULL DEFAULT 0,
  rows_updated integer NOT NULL DEFAULT 0,
  rows_skipped integer NOT NULL DEFAULT 0,
  problems     jsonb NOT NULL DEFAULT '[]'::jsonb,            -- [{ row, field, message }]
  status       text NOT NULL DEFAULT 'checked' CHECK (status IN ('checked', 'running', 'done', 'failed')),
  by           text NOT NULL DEFAULT '',
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
SELECT app.tenant_table('app.imports');

-- background jobs (renewal lifecycle, reminders, platform syncs, escalation, auto-close) – one queue for all ---------
CREATE TABLE IF NOT EXISTS platform.jobs (
  id          bigserial PRIMARY KEY,
  org_id      uuid REFERENCES platform.organizations(id) ON DELETE CASCADE,
  kind        text NOT NULL,                                   -- renewal-lifecycle | send-message | sync-giving | hd-escalate …
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at      timestamptz NOT NULL DEFAULT now(),
  attempts    smallint NOT NULL DEFAULT 0,
  locked_at   timestamptz,
  done_at     timestamptz,
  error       text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS jobs_due ON platform.jobs (run_at) WHERE done_at IS NULL;
SELECT app.platform_table('platform.jobs');
