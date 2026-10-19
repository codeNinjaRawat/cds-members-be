-- 0005 Members – the core record and everything around it.
-- PRIMARY SORT for members (every list, export and report uses it unless the admin picks another column):
--     masjid (center sort, name) → zone → status (active first) → last name → first name → member number
-- so the member table carries real links to its masjid and zone (center_id, zone_id), a per-organization member number,
-- a status kept by the API/jobs, and a sort_name. Indexes below start with org_id and follow that order.
-- 0001 created app.members with text zone/center; those stay (filled from the links) so the current API keeps working.

-- per-organization counters (member numbers, receipt numbers, ticket numbers…) ----------------------------------------
CREATE TABLE IF NOT EXISTS app.counters (
  org_id  uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  name    text NOT NULL,
  value   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, name)
);
SELECT app.tenant_table('app.counters');
CREATE OR REPLACE FUNCTION app.next_no(o uuid, counter text, start bigint DEFAULT 1) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO app.counters (org_id, name, value) VALUES (o, counter, start)
  ON CONFLICT (org_id, name) DO UPDATE SET value = app.counters.value + 1
  RETURNING value
$$;
GRANT EXECUTE ON FUNCTION app.next_no(uuid, text, bigint) TO app_api, app_platform;

-- membership plans: a projection of the published membership-settings document (the API refreshes it on publish),
-- so memberships and reports can point at a plan. The document stays the source of truth.
CREATE TABLE IF NOT EXISTS app.membership_plans (
  org_id            uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id                text NOT NULL CHECK (id ~ '^[a-z0-9-]{1,40}$'),
  name              text NOT NULL,
  category          text NOT NULL DEFAULT '',            -- Checkomatic | Individual | Lifetime (the organization's words)
  term              text NOT NULL CHECK (term IN ('year', 'multi-year', 'lifetime', 'monthly')),
  years             smallint NOT NULL DEFAULT 1,
  price_cents       integer NOT NULL CHECK (price_cents >= 0),
  household_size    smallint NOT NULL DEFAULT 1 CHECK (household_size BETWEEN 1 AND 20),
  voting_eligible   boolean NOT NULL DEFAULT true,
  requires_approval boolean NOT NULL DEFAULT true,
  visible           boolean NOT NULL DEFAULT true,
  sort              integer NOT NULL DEFAULT 0,
  archived          boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, id)
);
SELECT app.tenant_table('app.membership_plans');

-- households -----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.households (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  name        text NOT NULL,                              -- "The Rahman family"
  head_id     text,                                       -- member id of the primary member
  street      text NOT NULL DEFAULT '',
  city        text NOT NULL DEFAULT '',
  state       text NOT NULL DEFAULT '',
  zip         text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
SELECT app.tenant_table('app.households');

-- members: extend ------------------------------------------------------------------------------------------------------
ALTER TABLE app.members
  ADD COLUMN IF NOT EXISTS member_no           bigint,
  ADD COLUMN IF NOT EXISTS middle_name         text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS preferred_name      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS gender              text NOT NULL DEFAULT '' CHECK (gender IN ('', 'male', 'female')),
  ADD COLUMN IF NOT EXISTS state               text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS country             char(2) NOT NULL DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS lat                 numeric(9, 6),
  ADD COLUMN IF NOT EXISTS lng                 numeric(9, 6),
  ADD COLUMN IF NOT EXISTS zone_id             uuid,
  ADD COLUMN IF NOT EXISTS center_id           uuid,
  ADD COLUMN IF NOT EXISTS center_override     jsonb,                 -- { reason, by, at, lockedUntil } when staff placed them by hand
  ADD COLUMN IF NOT EXISTS household_id        uuid,
  ADD COLUMN IF NOT EXISTS status              text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'active', 'life', 'expired', 'resigned', 'expelled', 'archived')),
  ADD COLUMN IF NOT EXISTS paid_through        date,                  -- end of the last paid membership term (null = lifetime or never)
  ADD COLUMN IF NOT EXISTS language            text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS photo_ref           text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS external_ids        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { "wildapricot": "10234" }
  ADD COLUMN IF NOT EXISTS user_id             uuid REFERENCES platform.users(id) ON DELETE SET NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'app.members'::regclass AND attname = 'sort_name') THEN
    ALTER TABLE app.members ADD COLUMN sort_name text GENERATED ALWAYS AS (lower(last_name || ' ' || first_name)) STORED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'members_center_fk') THEN
    ALTER TABLE app.members ADD CONSTRAINT members_center_fk FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id);
    ALTER TABLE app.members ADD CONSTRAINT members_zone_fk FOREIGN KEY (org_id, zone_id) REFERENCES app.zones(org_id, id);
    ALTER TABLE app.members ADD CONSTRAINT members_household_fk FOREIGN KEY (org_id, household_id) REFERENCES app.households(org_id, id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS members_no ON app.members (org_id, member_no);
-- the primary sort and its common filters
CREATE INDEX IF NOT EXISTS members_primary_sort ON app.members (org_id, center_id, status, sort_name, member_no);
CREATE INDEX IF NOT EXISTS members_zone_sort ON app.members (org_id, zone_id, status, sort_name);
CREATE INDEX IF NOT EXISTS members_status_sort ON app.members (org_id, status, sort_name);
CREATE INDEX IF NOT EXISTS members_household ON app.members (org_id, household_id);
CREATE INDEX IF NOT EXISTS members_phone_digits ON app.members (org_id, regexp_replace(phone, '\D', '', 'g'));

-- placement: a new or moved member gets a member number and their masjid + zone from the ZIP (unless staff placed them
-- by hand); the legacy text columns follow the links.
CREATE OR REPLACE FUNCTION app.place_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE z uuid; c uuid; BEGIN
  IF NEW.member_no IS NULL THEN NEW.member_no := app.next_no(NEW.org_id, 'member', 100001); END IF;
  IF NEW.center_override IS NULL AND NEW.zip <> '' AND (TG_OP = 'INSERT' OR NEW.zip IS DISTINCT FROM OLD.zip OR NEW.center_id IS NULL) THEN
    SELECT zone_id INTO z FROM app.zone_zips WHERE org_id = NEW.org_id AND zip = left(NEW.zip, 5);
    SELECT cz.center_id INTO c FROM app.center_zips cz JOIN app.centers ce ON ce.org_id = cz.org_id AND ce.id = cz.center_id AND ce.active
      WHERE cz.org_id = NEW.org_id AND cz.zip = left(NEW.zip, 5);
    IF z IS NOT NULL THEN NEW.zone_id := z; END IF;
    IF c IS NOT NULL THEN NEW.center_id := c; END IF;
  END IF;
  IF NEW.center_id IS NOT NULL THEN
    SELECT ce.name, zo.code, ce.zone_id INTO NEW.center, NEW.zone, z FROM app.centers ce JOIN app.zones zo ON zo.org_id = ce.org_id AND zo.id = ce.zone_id
      WHERE ce.org_id = NEW.org_id AND ce.id = NEW.center_id;
    NEW.zone_id := z;                                  -- a masjid decides the zone
  ELSIF NEW.zone_id IS NOT NULL THEN
    SELECT code INTO NEW.zone FROM app.zones WHERE org_id = NEW.org_id AND id = NEW.zone_id;
  END IF;
  IF NEW.archived IS NOT NULL THEN NEW.status := 'archived'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS place_member ON app.members;
CREATE TRIGGER place_member BEFORE INSERT OR UPDATE ON app.members FOR EACH ROW EXECUTE FUNCTION app.place_member();

-- family links: membership family (spouse, children who can join) and the wider family history (both layers of the
-- family tree; a relative does not have to be a member) ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.relationships (
  org_id         uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  member_id      text NOT NULL,
  relation       text NOT NULL CHECK (relation IN ('spouse', 'parent', 'child', 'sibling', 'grandparent', 'grandchild', 'other')),
  related_id     text,                                   -- a member, or null for a relative who is not a member
  related_name   text NOT NULL DEFAULT '',
  related_dob    date,
  deceased       boolean NOT NULL DEFAULT false,
  layer          text NOT NULL DEFAULT 'membership' CHECK (layer IN ('membership', 'history')),
  private        boolean NOT NULL DEFAULT false,          -- family-history notes the member keeps for themselves
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, member_id) REFERENCES app.members(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, related_id) REFERENCES app.members(org_id, id) ON DELETE SET NULL (related_id),
  CHECK (related_id IS NOT NULL OR related_name <> '')
);
CREATE INDEX IF NOT EXISTS relationships_member ON app.relationships (org_id, member_id);
CREATE INDEX IF NOT EXISTS relationships_related ON app.relationships (org_id, related_id);
SELECT app.tenant_table('app.relationships');

-- memberships: one row per paid (or granted) term – what renewals, voting eligibility and dues reports read ------------
CREATE TABLE IF NOT EXISTS app.memberships (
  org_id         uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  member_id      text NOT NULL,
  plan_id        text NOT NULL,
  starts_on      date NOT NULL,
  ends_on        date,                                   -- null = lifetime
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'cancelled', 'refunded')),
  price_cents    integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  covers         text[] NOT NULL DEFAULT '{}',           -- household members this term also covers (member ids)
  how            text NOT NULL DEFAULT 'paid' CHECK (how IN ('paid', 'monthly-gifts', 'lifetime-by-donation', 'granted', 'imported')),
  payment_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, member_id) REFERENCES app.members(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, plan_id) REFERENCES app.membership_plans(org_id, id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS memberships_member ON app.memberships (org_id, member_id, starts_on DESC);
CREATE INDEX IF NOT EXISTS memberships_ends ON app.memberships (org_id, ends_on) WHERE status = 'active';
SELECT app.tenant_table('app.memberships');
-- paid_through follows the memberships
CREATE OR REPLACE FUNCTION app.refresh_paid_through() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m text := COALESCE(NEW.member_id, OLD.member_id); o uuid := COALESCE(NEW.org_id, OLD.org_id); life boolean; pt date; BEGIN
  SELECT bool_or(ends_on IS NULL), max(ends_on) INTO life, pt FROM app.memberships WHERE org_id = o AND member_id = m AND status = 'active';
  UPDATE app.members SET paid_through = CASE WHEN life THEN NULL ELSE pt END,
    status = CASE WHEN status IN ('resigned', 'expelled', 'archived') OR (status = 'pending' AND approved_on IS NULL) THEN status
                  WHEN life THEN 'life' WHEN pt >= current_date THEN 'active' ELSE 'expired' END
  WHERE org_id = o AND id = m;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS refresh_paid_through ON app.memberships;
CREATE TRIGGER refresh_paid_through AFTER INSERT OR UPDATE OR DELETE ON app.memberships FOR EACH ROW EXECUTE FUNCTION app.refresh_paid_through();

-- payments: 0001 kept dues per year; add an id, a link to the membership term, a state and a receipt number ----------
ALTER TABLE app.payments
  ADD COLUMN IF NOT EXISTS id             uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS membership_id  uuid,
  ADD COLUMN IF NOT EXISTS status         text NOT NULL DEFAULT 'paid' CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'disputed')),
  ADD COLUMN IF NOT EXISTS processor      text NOT NULL DEFAULT '' ,                -- stripe | paypal | zeffy | cash-desk
  ADD COLUMN IF NOT EXISTS processor_ref  text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS receipt_no     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS center_id      uuid,
  ADD COLUMN IF NOT EXISTS recorded_by    text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_at     timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS payments_id ON app.payments (org_id, id);
CREATE INDEX IF NOT EXISTS payments_member_year ON app.payments (org_id, member_id, year);
CREATE UNIQUE INDEX IF NOT EXISTS payments_processor_ref ON app.payments (org_id, processor, processor_ref) WHERE processor_ref <> '';

-- applications (the join form) ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.applications (
  org_id           uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id               text NOT NULL,                        -- APP-2027-4182
  member_id        text,                                 -- set when approved (or for a renewal)
  kind             text NOT NULL DEFAULT 'new' CHECK (kind IN ('new', 'renewal', 'plan-change', 'household-add')),
  email            citext NOT NULL,
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  zip              text NOT NULL DEFAULT '',
  center_id        uuid,
  plan_id          text NOT NULL,
  data             jsonb NOT NULL,                       -- the whole answer set (validated by the join-form schema)
  consents         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { identity: 'v3', sms: 'v1', pledge: 'v2' }
  status           text NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft', 'submitted', 'id-check', 'needs-info', 'board', 'approved', 'rejected', 'withdrawn')),
  paid             boolean NOT NULL DEFAULT false,
  submitted_at     timestamptz,
  decided_at       timestamptz,
  decided_by       text NOT NULL DEFAULT '',
  decision_reason  text NOT NULL DEFAULT '',
  resume_token     bytea,                                -- "save and continue later" (sha-256)
  source           text NOT NULL DEFAULT 'website',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, member_id) REFERENCES app.members(org_id, id) ON DELETE SET NULL (member_id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id)
);
CREATE INDEX IF NOT EXISTS applications_queue ON app.applications (org_id, status, submitted_at);
SELECT app.tenant_table('app.applications');
DROP TRIGGER IF EXISTS touch ON app.applications;
CREATE TRIGGER touch BEFORE UPDATE ON app.applications FOR EACH ROW EXECUTE FUNCTION app.touch();

-- photo ID checks: the file is purged after the check (Identity Collection and Verification Policy) -------------------
CREATE TABLE IF NOT EXISTS app.id_checks (
  org_id          uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  member_id       text,
  application_id  text,
  doc_type        text NOT NULL DEFAULT 'driver-license' CHECK (doc_type IN ('driver-license', 'state-id', 'passport', 'other')),
  file_ref        text NOT NULL DEFAULT '',             -- private storage key; emptied when purged
  name_on_id      text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  reason          text NOT NULL DEFAULT '',
  checked_by      text NOT NULL DEFAULT '',
  checked_at      timestamptz,
  purge_after     date,
  purged_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CHECK (member_id IS NOT NULL OR application_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS id_checks_queue ON app.id_checks (org_id, status, created_at);
SELECT app.tenant_table('app.id_checks');

-- center changes (border requests and moves; Bylaws: a 5-year lock after a change) -----------------------------------
CREATE TABLE IF NOT EXISTS app.center_changes (
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  member_id     text NOT NULL,
  from_center   uuid,
  to_center     uuid NOT NULL,
  reason        text NOT NULL CHECK (length(reason) >= 3),
  miles         numeric(6, 2),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
  locked_until  date,
  decided_by    text NOT NULL DEFAULT '',
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, member_id) REFERENCES app.members(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, to_center) REFERENCES app.centers(org_id, id)
);
CREATE INDEX IF NOT EXISTS center_changes_queue ON app.center_changes (org_id, status, created_at);
SELECT app.tenant_table('app.center_changes');

-- possible duplicates -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.duplicate_pairs (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  a           text NOT NULL,
  b           text NOT NULL,
  score       smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasons     text[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'not-duplicate')),
  decided_by  text NOT NULL DEFAULT '',
  decided_at  timestamptz,
  PRIMARY KEY (org_id, a, b),
  CHECK (a < b),
  FOREIGN KEY (org_id, a) REFERENCES app.members(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, b) REFERENCES app.members(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.duplicate_pairs');

-- consents (identity policy, text messages, pledge, privacy) – append-only proof ---------------------------------------
CREATE TABLE IF NOT EXISTS app.consents (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  member_id    text,
  email        citext NOT NULL DEFAULT '',
  kind         text NOT NULL CHECK (kind IN ('identity', 'sms', 'email', 'pledge', 'privacy', 'terms', 'photo')),
  version      text NOT NULL,
  given        boolean NOT NULL DEFAULT true,          -- false = withdrawn
  text_sha256  bytea,
  at           timestamptz NOT NULL DEFAULT now(),
  ip           inet,
  source       text NOT NULL DEFAULT 'website'
);
CREATE INDEX IF NOT EXISTS consents_member ON app.consents (org_id, member_id, kind, at DESC);
SELECT app.tenant_table('app.consents', true);

-- notes on a member (staff only) -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.member_notes (
  org_id     uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  member_id  text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  by         text NOT NULL,
  text       text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, member_id) REFERENCES app.members(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.member_notes');

-- the list everyone reads, already in the primary sort order (RLS of the base tables applies – security_invoker) ------
CREATE OR REPLACE VIEW app.member_list WITH (security_invoker = true) AS
  SELECT m.org_id, m.id, m.member_no, m.first_name, m.last_name, m.preferred_name, m.email, m.phone, m.zip, m.city,
         m.status, m.plan, m.paid_through, m.approved_on, m.id_check, m.household_id,
         m.center_id, c.name AS center_name, c.sort AS center_sort,
         m.zone_id, z.name AS zone_name, z.sort AS zone_sort,
         CASE m.status WHEN 'active' THEN 1 WHEN 'life' THEN 2 WHEN 'pending' THEN 3 WHEN 'expired' THEN 4 ELSE 5 END AS status_rank,
         m.sort_name
  FROM app.members m
  LEFT JOIN app.centers c ON c.org_id = m.org_id AND c.id = m.center_id
  LEFT JOIN app.zones z ON z.org_id = m.org_id AND z.id = m.zone_id;
GRANT SELECT ON app.member_list TO app_api, app_platform;
COMMENT ON VIEW app.member_list IS 'Primary sort: ORDER BY center_sort, center_name, zone_sort, status_rank, sort_name, member_no';
