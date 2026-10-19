-- 0030 The member app (C5): its sign-in tokens, devices, crash reports, notifications and repeated-request keys. Re-runnable.
--   An access token is an ordinary member session (platform.sessions, method 'app', 15 minutes) sent as a Bearer token.
--   A refresh token (60 days) is used once: each refresh gives a new pair; using an old one again ends the whole chain
--   (`family`) – a stolen copy stops working the moment either side uses it.
ALTER TABLE platform.sessions ADD COLUMN IF NOT EXISTS app_family uuid;
CREATE INDEX IF NOT EXISTS sessions_app_family ON platform.sessions (app_family) WHERE app_family IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform.app_refresh_tokens (
  id          bytea PRIMARY KEY,                                   -- sha-256 of the token
  family      uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  member_id   text NOT NULL,
  device      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '60 days',
  used_at     timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS app_refresh_family ON platform.app_refresh_tokens (family);
CREATE INDEX IF NOT EXISTS app_refresh_user ON platform.app_refresh_tokens (user_id) WHERE revoked_at IS NULL;
SELECT app.platform_table('platform.app_refresh_tokens');

-- the phones a member signed in on (Settings › Devices) and their push address
CREATE TABLE IF NOT EXISTS app.member_devices (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  family      uuid NOT NULL,                                       -- the sign-in chain this phone holds
  member_id   text NOT NULL,
  name        text NOT NULL DEFAULT '',
  platform    text NOT NULL DEFAULT '' CHECK (platform IN ('', 'ios', 'android', 'web')),
  push_token  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, family),
  FOREIGN KEY (org_id, member_id) REFERENCES app.members(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.member_devices');

-- what the app's bell shows (receipts, registrations, office notes); written by the API, read and marked by the member
CREATE TABLE IF NOT EXISTS app.member_notifications (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  member_id   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('membership', 'masjid', 'events', 'household', 'security', 'giving')),
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  link        text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, member_id) REFERENCES app.members(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS member_notifications_member ON app.member_notifications (org_id, member_id, at DESC);
SELECT app.tenant_table('app.member_notifications');

-- crash reports the app sends (no personal data – the app strips it before sending)
CREATE TABLE IF NOT EXISTS app.app_crashes (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  version     text NOT NULL DEFAULT '',
  platform    text NOT NULL DEFAULT '',
  message     text NOT NULL DEFAULT '',
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (org_id, id)
);
SELECT app.tenant_table('app.app_crashes', true);

-- a write the app repeats with the same Idempotency-Key gets the first answer again (kept one day)
CREATE TABLE IF NOT EXISTS app.app_requests (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  who         text NOT NULL,                                       -- member id, or the visitor's address before sign-in
  key         text NOT NULL,
  path        text NOT NULL,
  status      integer NOT NULL,
  body        jsonb NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, who, key)
);
SELECT app.tenant_table('app.app_requests');

-- the sign-in history also lists the app's own steps
ALTER TABLE platform.sign_in_events DROP CONSTRAINT IF EXISTS sign_in_events_method_check;
ALTER TABLE platform.sign_in_events ADD CONSTRAINT sign_in_events_method_check CHECK (method IN ('email-code', 'sms-code', 'google', 'password', 'two-step', 'invitation', 'support', 'staff',
  'app-email-code', 'app-sms-code', 'app-refresh', 'app-sign-out-everywhere'));
