-- 0024 SaaS platform API (B6a). The panel's own documents (plans, flags, announcements, settings, team) are kept with a
-- version (edits from two staff never overwrite each other); plans and team are also projected to saas_plans / staff,
-- which the database and sign-in use. Support sign-ins get a one-time link.
CREATE TABLE IF NOT EXISTS platform.panel_docs (
  key         text PRIMARY KEY CHECK (key IN ('plans', 'flags', 'announcements', 'settings', 'team')),
  data        jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT ''
);
SELECT app.platform_table('platform.panel_docs');
ALTER TABLE platform.staff ADD COLUMN IF NOT EXISTS key text;
ALTER TABLE platform.staff ADD COLUMN IF NOT EXISTS two_factor boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS staff_key ON platform.staff (key) WHERE key IS NOT NULL;
ALTER TABLE platform.support_sessions ADD COLUMN IF NOT EXISTS token_hash bytea;
ALTER TABLE platform.support_sessions ADD COLUMN IF NOT EXISTS used_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS support_token ON platform.support_sessions (token_hash) WHERE token_hash IS NOT NULL;
ALTER TABLE platform.sessions ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false;
ALTER TABLE platform.login_codes DROP CONSTRAINT IF EXISTS login_codes_purpose_check;
ALTER TABLE platform.login_codes ADD CONSTRAINT login_codes_purpose_check CHECK (purpose IN ('sign-in', 'join', 'verify-email', 'verify-phone', 'two-step', 'staff'));
ALTER TABLE platform.invitations ADD COLUMN IF NOT EXISTS org_user_id uuid REFERENCES platform.org_admin_users(id) ON DELETE CASCADE;
INSERT INTO platform.settings (id) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE platform.sign_in_events DROP CONSTRAINT IF EXISTS sign_in_events_method_check;
ALTER TABLE platform.sign_in_events ADD CONSTRAINT sign_in_events_method_check CHECK (method IN ('email-code', 'sms-code', 'google', 'password', 'two-step', 'invitation', 'support', 'staff'));
