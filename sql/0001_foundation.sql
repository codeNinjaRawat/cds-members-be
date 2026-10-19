-- B0 Foundation: organizations, published documents with versions, members, payments, tickets, audit.
-- Multi-tenant: every tenant table carries org_id; Row Level Security is ENABLED and FORCED; the API sets
-- `SET LOCAL app.org_id` per transaction and runs as role app_api (no BYPASSRLS). The SaaS panel runs as app_platform.
-- Run as the database owner (migrate.ts). Idempotent where PostgreSQL allows it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS platform;

-- roles ---------------------------------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN CREATE ROLE app_api NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform') THEN CREATE ROLE app_platform NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA app TO app_api, app_platform;
GRANT USAGE ON SCHEMA platform TO app_platform, app_api;

-- the tenant of this transaction ('' outside a tenant request → every tenant policy is false)
CREATE OR REPLACE FUNCTION app.current_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;

-- organizations (owned by the platform; the API reads only its own row) ------------------------------------------
CREATE TABLE IF NOT EXISTS platform.organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        citext UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled')),
  plan        text NOT NULL DEFAULT 'network',
  founding    boolean NOT NULL DEFAULT false,          -- ISGH: client #1, can never be deleted or cancelled (guard below)
  timezone    text NOT NULL DEFAULT 'America/Chicago',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION platform.guard_founding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.founding THEN RAISE EXCEPTION 'The founding organization cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.founding AND NEW.status = 'cancelled' THEN RAISE EXCEPTION 'The founding organization cannot be cancelled'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_founding ON platform.organizations;
CREATE TRIGGER guard_founding BEFORE UPDATE OR DELETE ON platform.organizations FOR EACH ROW EXECUTE FUNCTION platform.guard_founding();
GRANT SELECT ON platform.organizations TO app_api;
GRANT ALL ON platform.organizations TO app_platform;

-- documents: what the admin publishes (one row per org × key, the data as JSON, validated by the API with the shared zod schema)
CREATE TABLE IF NOT EXISTS app.documents (
  org_id       uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,40}$'),
  version      integer NOT NULL DEFAULT 1,
  data         jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, key)
);
CREATE TABLE IF NOT EXISTS app.document_versions (
  org_id       uuid NOT NULL,
  key          text NOT NULL,
  version      integer NOT NULL,
  data         jsonb NOT NULL,
  published_at timestamptz NOT NULL,
  published_by text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, key, version),
  FOREIGN KEY (org_id, key) REFERENCES app.documents(org_id, key) ON DELETE CASCADE
);
-- publishing keeps the last 20 versions
CREATE OR REPLACE FUNCTION app.keep_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO app.document_versions (org_id, key, version, data, published_at, published_by, note)
  VALUES (NEW.org_id, NEW.key, NEW.version, NEW.data, NEW.published_at, NEW.published_by, NEW.note)
  ON CONFLICT (org_id, key, version) DO UPDATE SET data = EXCLUDED.data, published_at = EXCLUDED.published_at, published_by = EXCLUDED.published_by, note = EXCLUDED.note;
  DELETE FROM app.document_versions v WHERE v.org_id = NEW.org_id AND v.key = NEW.key AND v.version <= NEW.version - 20;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS keep_versions ON app.documents;
CREATE TRIGGER keep_versions AFTER INSERT OR UPDATE ON app.documents FOR EACH ROW EXECUTE FUNCTION app.keep_versions();

-- members: the core columns the Bylaws rules need; everything else (extra profile fields, notes, audit) as JSON ----
CREATE TABLE IF NOT EXISTS app.members (
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id            text NOT NULL,                                   -- HOU-204781 (the organization's own id pattern)
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  email         citext NOT NULL,
  phone         text NOT NULL DEFAULT '',
  dob           date,
  street        text NOT NULL DEFAULT '',
  city          text NOT NULL DEFAULT '',
  zip           text NOT NULL DEFAULT '' CHECK (zip = '' OR zip ~ '^[0-9]{5}$'),
  zone          text NOT NULL DEFAULT '',
  center        text NOT NULL DEFAULT '',
  plan          text NOT NULL,
  joined_year   integer NOT NULL,
  applied_on    date NOT NULL,
  approved_on   date,
  id_check      text NOT NULL DEFAULT 'not_started' CHECK (id_check IN ('verified', 'pending', 'not_started')),
  standing      text NOT NULL DEFAULT 'good' CHECK (standing IN ('good', 'resigned', 'expelled')),
  spouse_id     text,
  commitment    text NOT NULL DEFAULT 'programs',
  source        text NOT NULL DEFAULT 'website',
  archived      jsonb,                                            -- { on, reason, by } or null
  extra         jsonb NOT NULL DEFAULT '{}'::jsonb,
  prefs         jsonb,
  record        jsonb NOT NULL DEFAULT '{}'::jsonb,               -- the rest of the Member shape (notes, audit, overrides…)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS members_email ON app.members (org_id, email);
CREATE INDEX IF NOT EXISTS members_zip ON app.members (org_id, zip);
CREATE INDEX IF NOT EXISTS members_name_trgm ON app.members USING gin ((first_name || ' ' || last_name) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS app.payments (
  org_id        uuid NOT NULL,
  member_id     text NOT NULL,
  year          integer NOT NULL,
  paid_on       date NOT NULL,
  amount_cents  integer NOT NULL CHECK (amount_cents >= 0),
  method        text NOT NULL CHECK (method IN ('card', 'check', 'cash', 'ach')),
  payer         text NOT NULL DEFAULT 'self' CHECK (payer IN ('self', 'spouse', 'parent', 'other')),
  ref           text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, member_id, ref, paid_on),
  FOREIGN KEY (org_id, member_id) REFERENCES app.members(org_id, id) ON DELETE CASCADE
);

-- tasks and tickets ----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.tickets (
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id            text NOT NULL,                                   -- T-1041
  kind          text NOT NULL CHECK (kind IN ('complaint', 'feedback', 'request', 'task')),
  title         text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  detail        text NOT NULL DEFAULT '',
  from_name     text NOT NULL DEFAULT '',
  from_member   text NOT NULL DEFAULT '',
  from_email    citext NOT NULL DEFAULT '',
  center        text NOT NULL DEFAULT '',
  assignee      text NOT NULL DEFAULT '',                        -- admin id from the admin-access document
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
  due           date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in-progress', 'waiting', 'done')),
  source        text NOT NULL DEFAULT 'website' CHECK (source IN ('website', 'admin', 'email', 'phone')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS app.ticket_updates (
  org_id        uuid NOT NULL,
  ticket_id     text NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  by            text NOT NULL,
  text          text NOT NULL,
  status        text CHECK (status IS NULL OR status IN ('open', 'in-progress', 'waiting', 'done')),
  FOREIGN KEY (org_id, ticket_id) REFERENCES app.tickets(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ticket_updates_ticket ON app.ticket_updates (org_id, ticket_id, at);

-- audit: who did what (append-only for the API) ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.audit_log (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,
  area          text NOT NULL,
  action        text NOT NULL,
  detail        text NOT NULL DEFAULT '',
  target        text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_org_at ON app.audit_log (org_id, at DESC);

-- row level security ---------------------------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['documents', 'document_versions', 'members', 'payments', 'tickets', 'ticket_updates', 'audit_log'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON app.%I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON app.%I TO app_api', t);
    EXECUTE format('GRANT ALL ON app.%I TO app_platform', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE app.audit_log_id_seq TO app_api, app_platform;
-- the audit log is append-only for the API
DROP POLICY IF EXISTS tenant_isolation ON app.audit_log;
CREATE POLICY tenant_isolation ON app.audit_log FOR SELECT USING (org_id = app.current_org());
DROP POLICY IF EXISTS audit_append ON app.audit_log;
CREATE POLICY audit_append ON app.audit_log FOR INSERT WITH CHECK (org_id = app.current_org());
REVOKE UPDATE, DELETE ON app.audit_log FROM app_api;
-- the platform role sees every tenant (the SaaS panel), the API only its own
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['documents', 'document_versions', 'members', 'payments', 'tickets', 'ticket_updates', 'audit_log'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS platform_all ON app.%I', t);
    EXECUTE format('CREATE POLICY platform_all ON app.%I TO app_platform USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
-- the API may read only the organization of its transaction
ALTER TABLE platform.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_org ON platform.organizations;
CREATE POLICY own_org ON platform.organizations FOR SELECT TO app_api USING (id = app.current_org() OR app.current_org() IS NULL);
DROP POLICY IF EXISTS platform_all ON platform.organizations;
CREATE POLICY platform_all ON platform.organizations TO app_platform USING (true) WITH CHECK (true);

-- updated_at ------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS touch ON app.members;
CREATE TRIGGER touch BEFORE UPDATE ON app.members FOR EACH ROW EXECUTE FUNCTION app.touch();
