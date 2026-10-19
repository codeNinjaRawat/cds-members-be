-- 0014 B1 sign-in: what the session needs beyond 0006, and the outbox every message leaves through.
--   sessions: one per browser; the person picks a dashboard (their membership, the organization, a zone, a masjid, an
--             area) – `dashboard` is the index into dashboardsFor(); `member_id` / `admin_id` are what that dashboard acts as.
--   outbox:   every email / text the platform sends (sign-in codes, invitations, receipts later). A provider adapter
--             sends and marks it; in development the API leaves it unsent so a developer can read the code.

ALTER TABLE platform.sessions
  ADD COLUMN IF NOT EXISTS dashboard   smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS member_id   text,
  ADD COLUMN IF NOT EXISTS admin_id    text,
  ADD COLUMN IF NOT EXISTS method      text NOT NULL DEFAULT '';
ALTER TABLE platform.sessions DROP CONSTRAINT IF EXISTS sessions_kind_check;
ALTER TABLE platform.sessions ADD CONSTRAINT sessions_kind_check CHECK (kind IN ('member', 'admin', 'platform', 'person'));
ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS phone_e164 text UNIQUE;

CREATE TABLE IF NOT EXISTS platform.outbox (
  id            bigserial PRIMARY KEY,
  org_id        uuid REFERENCES platform.organizations(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('email', 'sms')),
  to_address    citext NOT NULL,
  subject       text NOT NULL DEFAULT '',
  body          text NOT NULL,
  kind          text NOT NULL DEFAULT 'sign-in-code',
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  provider      text NOT NULL DEFAULT '',
  provider_ref  text NOT NULL DEFAULT '',
  error         text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS outbox_unsent ON platform.outbox (created_at) WHERE sent_at IS NULL;
SELECT app.platform_table('platform.outbox');

-- old sessions and codes are removed by a nightly job (kept 30 days for the sign-in history)
CREATE OR REPLACE FUNCTION platform.purge_auth(days integer DEFAULT 30) RETURNS integer LANGUAGE sql AS $$
  WITH a AS (DELETE FROM platform.login_codes WHERE created_at < now() - make_interval(days => days) RETURNING 1),
       b AS (DELETE FROM platform.sessions WHERE (revoked_at IS NOT NULL OR expires_at < now()) AND created_at < now() - make_interval(days => days) RETURNING 1)
  SELECT ((SELECT count(*) FROM a) + (SELECT count(*) FROM b))::int
$$;
GRANT EXECUTE ON FUNCTION platform.purge_auth(integer) TO app_platform;
