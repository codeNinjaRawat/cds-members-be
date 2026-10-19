-- 0002 SaaS platform (Masajid Solutions runs one product for every client; ISGH = client #1).
-- Shapes follow saas/src/lib/platform/platform.ts (zod) and BE/memory/saas-architecture.md §3.
-- Schema `platform` = the SaaS panel's data. The API role (app_api) may read only what an organization needs about itself.
-- Additive: 0001 created platform.organizations; this file extends it instead of replacing it.

-- helper used by every later migration: tenant isolation + grants in one call -----------------------------------
CREATE OR REPLACE FUNCTION app.tenant_table(tbl regclass, append_only boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_append ON %s', tbl);
  EXECUTE format('DROP POLICY IF EXISTS platform_all ON %s', tbl);
  IF append_only THEN
    EXECUTE format('CREATE POLICY tenant_isolation ON %s FOR SELECT TO app_api USING (org_id = app.current_org())', tbl);
    EXECUTE format('CREATE POLICY tenant_append ON %s FOR INSERT TO app_api WITH CHECK (org_id = app.current_org())', tbl);
    EXECUTE format('GRANT SELECT, INSERT ON %s TO app_api', tbl);
    EXECUTE format('REVOKE UPDATE, DELETE ON %s FROM app_api', tbl);
  ELSE
    EXECUTE format('CREATE POLICY tenant_isolation ON %s TO app_api USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO app_api', tbl);
  END IF;
  EXECUTE format('CREATE POLICY platform_all ON %s TO app_platform USING (true) WITH CHECK (true)', tbl);
  EXECUTE format('GRANT ALL ON %s TO app_platform', tbl);
END $$;
-- platform-only table: no RLS needed, the API role simply has no grant (or read-only where stated)
CREATE OR REPLACE FUNCTION app.platform_table(tbl regclass, api_can_read boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('GRANT ALL ON %s TO app_platform', tbl);
  IF api_can_read THEN EXECUTE format('GRANT SELECT ON %s TO app_api', tbl); ELSE EXECUTE format('REVOKE ALL ON %s FROM app_api', tbl); END IF;
END $$;
CREATE OR REPLACE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO app_api, app_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO app_api, app_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT USAGE, SELECT ON SEQUENCES TO app_platform;

-- SaaS plans (what an organization pays the platform – not a membership plan) ---------------------------------
CREATE TABLE IF NOT EXISTS platform.saas_plans (
  id                   text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,30}$'),     -- starter | growth | network
  name                 text NOT NULL,
  tagline              text NOT NULL DEFAULT '',
  price_monthly_cents  integer NOT NULL CHECK (price_monthly_cents >= 0),
  price_annual_cents   integer NOT NULL CHECK (price_annual_cents >= 0),
  limit_members        integer,                                               -- null = no limit
  limit_centers        integer,
  limit_admins         integer,
  limit_sms            integer,
  modules              text[] NOT NULL DEFAULT '{}',
  highlight            boolean NOT NULL DEFAULT false,
  hidden               boolean NOT NULL DEFAULT false,
  sort                 integer NOT NULL DEFAULT 0,
  stripe_price_monthly text NOT NULL DEFAULT '',
  stripe_price_annual  text NOT NULL DEFAULT ''
);
SELECT app.platform_table('platform.saas_plans', true);
-- the three plans (demo prices from saas/; the SaaS panel edits them) – needed before any organization row
INSERT INTO platform.saas_plans (id, name, tagline, price_monthly_cents, price_annual_cents, limit_members, limit_centers, limit_admins, limit_sms, modules, highlight, sort) VALUES
  ('starter', 'Starter', 'One masjid, the essentials', 4900, 49000, 500, 1, 3, 500, ARRAY['website', 'membership', 'members', 'giving', 'events', 'joinForm'], false, 1),
  ('growth', 'Growth', 'A busy masjid with programs', 14900, 149000, 3000, 3, 10, 5000, ARRAY['website', 'membership', 'members', 'giving', 'events', 'joinForm', 'queues', 'families', 'sms', 'reports', 'helpdesk', 'tasks'], true, 2),
  ('network', 'Network', 'Many masjids, zones and elections', 39900, 399000, NULL, NULL, NULL, 25000, ARRAY['website', 'membership', 'members', 'giving', 'events', 'joinForm', 'queues', 'families', 'idScan', 'sms', 'reports', 'elections', 'customDomain', 'api', 'zakat', 'finance', 'helpdesk', 'tasks', 'officials', 'benefits'], false, 3)
ON CONFLICT (id) DO NOTHING;

-- organizations: extend the 0001 table to the full tenant shape ---------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS platform.client_no_seq START 2;              -- ISGH is client #1 (seed), the rest from 2
ALTER TABLE platform.organizations
  ADD COLUMN IF NOT EXISTS client_no          integer UNIQUE,
  ADD COLUMN IF NOT EXISTS short_name         text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS type               text NOT NULL DEFAULT 'society' CHECK (type IN ('society', 'masjid', 'association', 'school')),
  ADD COLUMN IF NOT EXISTS country            char(2) NOT NULL DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS state              text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS city               text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS address            text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone              text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email              citext NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS locale             text NOT NULL DEFAULT 'en-US',
  ADD COLUMN IF NOT EXISTS currency           char(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS color              text NOT NULL DEFAULT '#0E5A45',
  ADD COLUMN IF NOT EXISTS billing_cycle      text NOT NULL DEFAULT 'annual' CHECK (billing_cycle IN ('monthly', 'annual')),
  ADD COLUMN IF NOT EXISTS trial_ends_on      date,
  ADD COLUMN IF NOT EXISTS created_on         date NOT NULL DEFAULT current_date,
  ADD COLUMN IF NOT EXISTS cancelled_on       date,
  ADD COLUMN IF NOT EXISTS template           text NOT NULL DEFAULT 'simple-masjid' CHECK (template IN ('bylaws-society', 'simple-masjid', 'blank')),
  ADD COLUMN IF NOT EXISTS suspended_reason   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS notes              text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS legacy_web_host    citext,
  ADD COLUMN IF NOT EXISTS legacy_admin_host  citext,
  ADD COLUMN IF NOT EXISTS is_sample          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS db_shard           text NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS stripe_customer_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_at         timestamptz NOT NULL DEFAULT now();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_plan_fk') THEN
    ALTER TABLE platform.organizations ADD CONSTRAINT organizations_plan_fk FOREIGN KEY (plan) REFERENCES platform.saas_plans(id) NOT VALID;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_legacy_web ON platform.organizations (legacy_web_host) WHERE legacy_web_host IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_legacy_admin ON platform.organizations (legacy_admin_host) WHERE legacy_admin_host IS NOT NULL;
-- slugs the platform keeps for itself (RESERVED_SLUGS in platform.ts)
CREATE TABLE IF NOT EXISTS platform.reserved_slugs (slug citext PRIMARY KEY);
INSERT INTO platform.reserved_slugs (slug) SELECT unnest(ARRAY['www', 'api', 'admin', 'saas', 'app', 'mail', 'help', 'support', 'status', 'docs', 'billing', 'orgs', 'static', 'cdn', 'member-web', 'member-admin']) ON CONFLICT DO NOTHING;
SELECT app.platform_table('platform.reserved_slugs', true);
CREATE OR REPLACE FUNCTION platform.check_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM platform.reserved_slugs r WHERE r.slug = NEW.slug) THEN RAISE EXCEPTION 'The address name "%" is reserved', NEW.slug; END IF;
  IF NEW.client_no IS NULL THEN
    NEW.client_no := CASE WHEN NEW.founding AND NOT EXISTS (SELECT 1 FROM platform.organizations WHERE client_no = 1) THEN 1 ELSE nextval('platform.client_no_seq') END;
  END IF;
  IF NEW.status = 'cancelled' AND NEW.cancelled_on IS NULL THEN NEW.cancelled_on := current_date; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS check_org ON platform.organizations;
CREATE TRIGGER check_org BEFORE INSERT OR UPDATE ON platform.organizations FOR EACH ROW EXECUTE FUNCTION platform.check_org();
-- client #1 (the founding client) can never be deleted or cancelled – extend the 0001 guard to client_no too
CREATE OR REPLACE FUNCTION platform.guard_founding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (OLD.founding OR OLD.client_no = 1) THEN RAISE EXCEPTION 'The founding organization cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.founding OR OLD.client_no = 1) AND NEW.status = 'cancelled' THEN RAISE EXCEPTION 'The founding organization cannot be cancelled'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;

-- modules switched on (add-on) or off per organization -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.org_modules (
  org_id  uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  module  text NOT NULL CHECK (module IN ('website', 'membership', 'members', 'giving', 'events', 'joinForm', 'queues', 'families', 'idScan', 'sms', 'reports', 'elections', 'customDomain', 'api', 'zakat', 'finance', 'helpdesk', 'tasks', 'officials', 'benefits')),
  value   text NOT NULL CHECK (value IN ('on', 'off')),
  PRIMARY KEY (org_id, module)
);
SELECT app.platform_table('platform.org_modules', true);

-- own domains --------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.org_domains (
  host          citext PRIMARY KEY CHECK (host ~ '^[a-z0-9.-]{3,253}$'),
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  app           text NOT NULL DEFAULT 'web' CHECK (app IN ('web', 'admin')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
  verify_token  text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  cert_status   text NOT NULL DEFAULT 'none' CHECK (cert_status IN ('none', 'requested', 'issued', 'failed')),
  added_on      date NOT NULL DEFAULT current_date,
  checked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS org_domains_org ON platform.org_domains (org_id);
SELECT app.platform_table('platform.org_domains', true);
-- which organization serves a host (edge + API use it; only verified own domains)
CREATE OR REPLACE FUNCTION platform.org_for_host(h text, base text DEFAULT 'nextgrow.pro') RETURNS TABLE (org_id uuid, app text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = platform, pg_temp AS $$
  SELECT o.id, 'web' FROM platform.organizations o WHERE o.legacy_web_host = lower(h)
  UNION ALL SELECT o.id, 'admin' FROM platform.organizations o WHERE o.legacy_admin_host = lower(h)
  UNION ALL SELECT d.org_id, d.app FROM platform.org_domains d WHERE d.host = lower(h) AND d.status = 'verified'
  UNION ALL SELECT o.id, CASE WHEN lower(h) LIKE '%-admin.' || base THEN 'admin' ELSE 'web' END FROM platform.organizations o
    WHERE lower(h) IN (o.slug || '.' || base, o.slug || '-admin.' || base)
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION platform.org_for_host(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.org_for_host(text, text) TO app_api, app_platform;

-- people: one global user per email (an admin of two organizations is one user) ----------------------------------
CREATE TABLE IF NOT EXISTS platform.users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext UNIQUE NOT NULL,
  name           text NOT NULL DEFAULT '',
  phone          text NOT NULL DEFAULT '',
  google_sub     text UNIQUE,
  two_step       boolean NOT NULL DEFAULT false,
  totp_secret    bytea,                                   -- encrypted by the API (pgp_sym_encrypt), never plain
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
SELECT app.platform_table('platform.users');

-- staff of an organization in the SaaS sense (owner / admin / editor / viewer); detailed roles live in app.admin_roles
CREATE TABLE IF NOT EXISTS platform.org_admin_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  status          text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'revoked')),
  invited_on      date NOT NULL DEFAULT current_date,
  last_active_on  date,
  UNIQUE (org_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_owner_per_org ON platform.org_admin_users (org_id) WHERE role = 'owner' AND status <> 'revoked';
SELECT app.platform_table('platform.org_admin_users', true);

CREATE TABLE IF NOT EXISTS platform.invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  email        citext NOT NULL,
  name         text NOT NULL DEFAULT '',
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  token_hash   bytea NOT NULL UNIQUE,                     -- sha-256 of the token sent by email; the raw token is never stored
  invited_by   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at  timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS invitations_org ON platform.invitations (org_id, email);
SELECT app.platform_table('platform.invitations');

-- feature flags with rollout -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.flags (
  key      text PRIMARY KEY CHECK (key ~ '^[a-z][a-zA-Z0-9.-]{1,60}$'),
  label    text NOT NULL,
  help     text NOT NULL DEFAULT '',
  module   text,
  rollout  text NOT NULL DEFAULT 'off' CHECK (rollout IN ('off', 'some', 'all'))
);
CREATE TABLE IF NOT EXISTS platform.flag_orgs (
  flag_key text NOT NULL REFERENCES platform.flags(key) ON DELETE CASCADE,
  org_id   uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (flag_key, org_id)
);
SELECT app.platform_table('platform.flags', true);
SELECT app.platform_table('platform.flag_orgs', true);

CREATE TABLE IF NOT EXISTS platform.announcements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  tone       text NOT NULL DEFAULT 'info' CHECK (tone IN ('info', 'success', 'warning')),
  audience   text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'plans', 'orgs')),
  ids        text[] NOT NULL DEFAULT '{}',              -- plan ids or org ids for the audience
  starts_on  date NOT NULL DEFAULT current_date,
  ends_on    date,
  active     boolean NOT NULL DEFAULT true,
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
SELECT app.platform_table('platform.announcements', true);

-- platform staff and settings ----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.staff (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL UNIQUE REFERENCES platform.users(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('owner', 'support', 'billing', 'readonly')),
  active    boolean NOT NULL DEFAULT true
);
SELECT app.platform_table('platform.staff');
CREATE TABLE IF NOT EXISTS platform.settings (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),     -- exactly one row
  product_name        text NOT NULL DEFAULT 'NextGrow Members',
  company_name        text NOT NULL DEFAULT 'Masajid Solutions',
  base_domain         text NOT NULL DEFAULT 'nextgrow.pro',
  support_email       citext NOT NULL DEFAULT 'support@masajidsolutions.com',
  support_hours       text NOT NULL DEFAULT 'Mon–Fri 9 AM–5 PM Central',
  default_template    text NOT NULL DEFAULT 'simple-masjid',
  require_reason      boolean NOT NULL DEFAULT true,
  support_session_minutes integer NOT NULL DEFAULT 120 CHECK (support_session_minutes BETWEEN 5 AND 1440)
);
SELECT app.platform_table('platform.settings', true);

CREATE TABLE IF NOT EXISTS platform.support_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  staff_id    uuid NOT NULL REFERENCES platform.staff(id),
  reason      text NOT NULL CHECK (length(reason) >= 5),
  mode        text NOT NULL DEFAULT 'read-only' CHECK (mode IN ('read-only', 'full')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz NOT NULL,
  ended_at    timestamptz,
  CHECK (ends_at > started_at)
);
CREATE INDEX IF NOT EXISTS support_sessions_open ON platform.support_sessions (org_id) WHERE ended_at IS NULL;
SELECT app.platform_table('platform.support_sessions', true);

-- platform audit: append-only, kept 7 years -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.audit (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text NOT NULL,
  staff_id uuid,
  action   text NOT NULL,
  org_id   uuid,
  detail   text NOT NULL DEFAULT '',
  before   jsonb,
  after    jsonb
);
CREATE INDEX IF NOT EXISTS platform_audit_org ON platform.audit (org_id, at DESC);
CREATE OR REPLACE FUNCTION platform.no_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'This log is append-only'; END $$;
DROP TRIGGER IF EXISTS append_only ON platform.audit;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON platform.audit FOR EACH ROW EXECUTE FUNCTION platform.no_change();
SELECT app.platform_table('platform.audit');

-- billing mirror of Stripe and daily usage --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.invoices (
  id            text PRIMARY KEY,                      -- Stripe invoice id
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  period        text NOT NULL,                         -- '2026-10' or '2026/27'
  issued_on     date NOT NULL,
  amount_cents  integer NOT NULL CHECK (amount_cents >= 0),
  status        text NOT NULL CHECK (status IN ('paid', 'open', 'failed', 'void')),
  method        text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS invoices_org ON platform.invoices (org_id, issued_on DESC);
SELECT app.platform_table('platform.invoices');
CREATE TABLE IF NOT EXISTS platform.org_usage_daily (
  org_id    uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  day       date NOT NULL,
  members   integer NOT NULL DEFAULT 0,
  centers   integer NOT NULL DEFAULT 0,
  admins    integer NOT NULL DEFAULT 0,
  sms_sent  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day)
);
SELECT app.platform_table('platform.org_usage_daily');

-- effective modules of an organization: plan + add-ons − switched off (always-on modules stay on) -------------------
CREATE OR REPLACE FUNCTION platform.effective_modules(o uuid) RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = platform, pg_temp AS $$
  SELECT array_agg(DISTINCT m ORDER BY m) FROM (
    SELECT unnest(p.modules) AS m FROM platform.organizations g JOIN platform.saas_plans p ON p.id = g.plan WHERE g.id = o
    UNION SELECT module FROM platform.org_modules WHERE org_id = o AND value = 'on'
    UNION SELECT unnest(ARRAY['website', 'membership', 'members'])
  ) x WHERE m NOT IN (SELECT module FROM platform.org_modules WHERE org_id = o AND value = 'off' AND module NOT IN ('website', 'membership', 'members'))
$$;
GRANT EXECUTE ON FUNCTION platform.effective_modules(uuid) TO app_api, app_platform;
