-- 0006 Access: roles and permissions per organization, admins with scoped assignments (masjid / zone / ZIP area),
-- sign-in (email or text code, Google, password), sessions and two-step. Shapes: web/src/lib/community/access.ts
-- (RoleSchema, AdminSchema, AssignmentSchema) and sign-in.ts. The `admin-access` document stays what the admin edits;
-- the API projects it into these tables on publish so every endpoint can check `can()` and the scope in SQL.

-- the permission catalog (same keys for every organization; PERMISSIONS in access.ts) ---------------------------------
CREATE TABLE IF NOT EXISTS platform.permissions (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z]+(\.[a-z]+)?$'),
  label      text NOT NULL,
  module     text NOT NULL,
  sensitive  boolean NOT NULL DEFAULT false
);
SELECT app.platform_table('platform.permissions', true);
INSERT INTO platform.permissions (key, label, module, sensitive) VALUES
  ('members.view', 'See members', 'Members', false), ('members.contact', 'See contact details and export', 'Members', true),
  ('members.edit', 'Edit members', 'Members', false), ('members.approve', 'Approve applications (Board)', 'Members', false),
  ('members.archive', 'Archive and import members', 'Members', true), ('groups.manage', 'Manage groups', 'Members', false),
  ('centers.manage', 'Edit zones, centers and ZIP codes', 'Zones and centers', false), ('center.content', 'Prayer times and meeting minutes', 'Zones and centers', false),
  ('zakat.view', 'See Zakat and Sadaqah cases', 'Zakat and Sadaqah', false), ('zakat.intake', 'Take applications', 'Zakat and Sadaqah', false),
  ('zakat.verify', 'Verify applicants', 'Zakat and Sadaqah', false), ('zakat.approve', 'Approve within the role''s limit', 'Zakat and Sadaqah', false),
  ('zakat.override', 'Override and fast-track', 'Zakat and Sadaqah', true), ('zakat.disburse', 'Pay out approved cases', 'Zakat and Sadaqah', true),
  ('zakat.settings', 'Change Zakat rules', 'Zakat and Sadaqah', true), ('payments.record', 'Record payments', 'Donations and finance', false),
  ('payments.refund', 'Refund payments', 'Donations and finance', true), ('donations.view', 'See donations', 'Donations and finance', false),
  ('donations.reconcile', 'Record and reconcile donations', 'Donations and finance', false), ('finance.view', 'See funds and financial reports', 'Donations and finance', false),
  ('finance.manage', 'Manage funds and transfers', 'Donations and finance', true), ('fundraising.manage', 'Run fundraising campaigns', 'Donations and finance', false),
  ('events.manage', 'Manage events', 'Events', false), ('events.checkin', 'Check people in at events', 'Events', false),
  ('comms.send', 'Send messages to members', 'Communication', false), ('comms.settings', 'Change email settings and templates', 'Communication', false),
  ('content.publish', 'Publish website content', 'Website', false), ('benefits.manage', 'Manage member benefits and discounts', 'Benefits and community', false),
  ('officials.manage', 'Manage elected officials', 'Benefits and community', false), ('reports.view', 'See reports', 'Reports', false),
  ('voters.freeze', 'Freeze and correct the voter list', 'Elections', true), ('settings.manage', 'Change membership rules and configuration', 'Settings', false),
  ('integrations.manage', 'Manage integrations', 'Settings', true), ('team.manage', 'Build the masjid''s working body', 'Settings', false),
  ('admins.manage', 'Manage admins and roles', 'Settings', true), ('billing', 'Billing and the subscription', 'Settings', true)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, sensitive = EXCLUDED.sensitive;

-- roles of an organization (built-in + custom) ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.admin_roles (
  org_id         uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id             text NOT NULL CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  name           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  permissions    text[] NOT NULL CHECK (cardinality(permissions) > 0),
  area           text NOT NULL DEFAULT 'general',
  zone_scoped    boolean NOT NULL DEFAULT false,
  center_scoped  boolean NOT NULL DEFAULT false,
  area_scoped    boolean NOT NULL DEFAULT false,
  zakat_level    smallint NOT NULL DEFAULT 0 CHECK (zakat_level BETWEEN 0 AND 3),
  built_in       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, id),
  CHECK (NOT (zone_scoped AND center_scoped)),
  CHECK (NOT area_scoped OR center_scoped)
);
SELECT app.tenant_table('app.admin_roles');
CREATE OR REPLACE FUNCTION app.check_role_permissions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad text; BEGIN
  SELECT p INTO bad FROM unnest(NEW.permissions) p WHERE p NOT IN (SELECT key FROM platform.permissions) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Unknown permission %', bad; END IF;
  IF NEW.id = 'owner' AND EXISTS (SELECT 1 FROM platform.permissions WHERE key <> ALL (NEW.permissions)) THEN RAISE EXCEPTION 'The Owner role must keep every permission'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS check_role_permissions ON app.admin_roles;
CREATE TRIGGER check_role_permissions BEFORE INSERT OR UPDATE ON app.admin_roles FOR EACH ROW EXECUTE FUNCTION app.check_role_permissions();

-- admins of an organization (a person; may also be a member) ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.admins (
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id            text NOT NULL CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  user_id       uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  name          text NOT NULL,
  email         citext NOT NULL,
  member_id     text,
  home_zip      text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended')),
  two_step      boolean NOT NULL DEFAULT false,
  last_active   date,
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, email)
);
SELECT app.tenant_table('app.admins');

-- what a person may do where: one row per role they hold (main role + "more") ------------------------------------------
CREATE TABLE IF NOT EXISTS app.admin_assignments (
  org_id       uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  admin_id     text NOT NULL,
  role_id      text NOT NULL,
  is_main      boolean NOT NULL DEFAULT false,
  zone_ids     uuid[] NOT NULL DEFAULT '{}',
  center_ids   uuid[] NOT NULL DEFAULT '{}',
  zips         text[] NOT NULL DEFAULT '{}',
  expires_on   date,
  given_by     text NOT NULL DEFAULT '',
  holder_id    text NOT NULL DEFAULT '',                  -- the elected/appointed seat this access comes from
  reviewed_on  date,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, admin_id) REFERENCES app.admins(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, role_id) REFERENCES app.admin_roles(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_assignments_main ON app.admin_assignments (org_id, admin_id) WHERE is_main;
SELECT app.tenant_table('app.admin_assignments');

-- the two questions every endpoint asks -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.can(p_admin text, p_perm text, p_on date DEFAULT current_date) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.admin_assignments a JOIN app.admins d ON d.org_id = a.org_id AND d.id = a.admin_id AND d.status = 'active'
    JOIN app.admin_roles r ON r.org_id = a.org_id AND r.id = a.role_id
    WHERE a.org_id = app.current_org() AND a.admin_id = p_admin AND p_perm = ANY (r.permissions) AND (a.expires_on IS NULL OR a.expires_on >= p_on))
$$;
-- is a record (zone, masjid, ZIP) inside what this admin may see?
CREATE OR REPLACE FUNCTION app.in_scope(p_admin text, p_zone uuid, p_center uuid, p_zip text DEFAULT '') RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.admin_assignments a JOIN app.admins d ON d.org_id = a.org_id AND d.id = a.admin_id AND d.status = 'active'
    JOIN app.admin_roles r ON r.org_id = a.org_id AND r.id = a.role_id
    WHERE a.org_id = app.current_org() AND a.admin_id = p_admin AND (a.expires_on IS NULL OR a.expires_on >= current_date)
      AND CASE WHEN r.zone_scoped THEN p_zone = ANY (a.zone_ids)
               WHEN r.center_scoped AND r.area_scoped THEN p_center = ANY (a.center_ids) AND left(p_zip, 5) = ANY (a.zips)
               WHEN r.center_scoped THEN p_center = ANY (a.center_ids)
               ELSE true END)
$$;
GRANT EXECUTE ON FUNCTION app.can(text, text, date), app.in_scope(text, uuid, uuid, text) TO app_api, app_platform;

-- sign-in -------------------------------------------------------------------------------------------------------------
-- one-time codes by email or text (6 digits, hashed, 10 minutes, 5 tries)
CREATE TABLE IF NOT EXISTS platform.login_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES platform.organizations(id) ON DELETE CASCADE,   -- the site it was asked on
  channel     text NOT NULL CHECK (channel IN ('email', 'sms')),
  address     citext NOT NULL,                                             -- email or E.164 phone
  purpose     text NOT NULL DEFAULT 'sign-in' CHECK (purpose IN ('sign-in', 'join', 'verify-email', 'verify-phone', 'two-step')),
  code_hash   bytea NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  used_at     timestamptz,
  ip          inet
);
CREATE INDEX IF NOT EXISTS login_codes_address ON platform.login_codes (address, created_at DESC);
SELECT app.platform_table('platform.login_codes');
-- password sign-in (optional per organization) – argon2id hash made by the API
CREATE TABLE IF NOT EXISTS platform.passwords (
  user_id     uuid PRIMARY KEY REFERENCES platform.users(id) ON DELETE CASCADE,
  hash        text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
SELECT app.platform_table('platform.passwords');
-- sessions: a hashed cookie token; the active organization and dashboard (role) live on the session
CREATE TABLE IF NOT EXISTS platform.sessions (
  id                  bytea PRIMARY KEY,                    -- sha-256 of the cookie token
  user_id             uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  org_id              uuid REFERENCES platform.organizations(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('member', 'admin', 'platform')),
  assignment_id       uuid,                                 -- which role the admin works in ("Switch dashboard")
  two_step_ok         boolean NOT NULL DEFAULT false,
  support_session_id  uuid REFERENCES platform.support_sessions(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_minutes        integer NOT NULL DEFAULT 30,
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '12 hours',
  revoked_at          timestamptz,
  ip                  inet,
  user_agent          text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user ON platform.sessions (user_id) WHERE revoked_at IS NULL;
SELECT app.platform_table('platform.sessions');
-- sign-in attempts (rate limits, lock-outs, the "new device" email)
CREATE TABLE IF NOT EXISTS platform.sign_in_events (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  user_id  uuid,
  org_id   uuid,
  address  citext NOT NULL DEFAULT '',
  method   text NOT NULL CHECK (method IN ('email-code', 'sms-code', 'google', 'password', 'two-step', 'invitation', 'support')),
  ok       boolean NOT NULL,
  reason   text NOT NULL DEFAULT '',
  ip       inet
);
CREATE INDEX IF NOT EXISTS sign_in_events_address ON platform.sign_in_events (address, at DESC);
SELECT app.platform_table('platform.sign_in_events');
