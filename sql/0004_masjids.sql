-- 0004 Masjids (Islamic Centers) – shapes from web/src/lib/community/org-structure.ts (CenterSchema) and the
-- masjid CRM (BE/memory/api-contract-masjid-crm.md): address + point, service ZIPs (ZIP → masjid → zone), Jumu'ah,
-- services, contacts, and the masjid's working body (Associate Director, secretaries, Area Representatives…).

CREATE TABLE IF NOT EXISTS app.centers (
  org_id       uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  code         text NOT NULL CHECK (code ~ '^[a-z0-9-]{1,40}$'),     -- 'adel-road' (the admin's center id)
  zone_id      uuid NOT NULL,
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),   -- Masjid Bilal
  aka          text NOT NULL DEFAULT '',                              -- Adel Road Islamic Center
  kind         text NOT NULL DEFAULT 'masjid' CHECK (kind IN ('masjid', 'musalla', 'office', 'school', 'other')),
  street       text NOT NULL DEFAULT '',
  city         text NOT NULL DEFAULT '',
  state        text NOT NULL DEFAULT '',
  zip          text NOT NULL DEFAULT '',
  country      char(2) NOT NULL DEFAULT 'US',
  lat          numeric(9, 6),
  lng          numeric(9, 6),
  phone        text NOT NULL DEFAULT '',
  email        citext NOT NULL DEFAULT '',
  website      text NOT NULL DEFAULT '' CHECK (website = '' OR website ~ '^https?://'),
  services     text[] NOT NULL DEFAULT '{}' CHECK (services <@ ARRAY['daily-prayers', 'jumuah', 'weekend-school', 'full-time-school', 'clinic', 'food-pantry', 'funeral', 'zakat-office']),
  capacity     integer CHECK (capacity IS NULL OR capacity > 0),
  name_status  text NOT NULL DEFAULT 'confirmed' CHECK (name_status IN ('confirmed', 'to-confirm')),   -- "name to confirm" from the review calls
  active       boolean NOT NULL DEFAULT true,
  sort         integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, code),
  FOREIGN KEY (org_id, zone_id) REFERENCES app.zones(org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS centers_name ON app.centers (org_id, lower(name));
CREATE INDEX IF NOT EXISTS centers_zone ON app.centers (org_id, zone_id, sort, name);
SELECT app.tenant_table('app.centers');
DROP TRIGGER IF EXISTS touch ON app.centers;
CREATE TRIGGER touch BEFORE UPDATE ON app.centers FOR EACH ROW EXECUTE FUNCTION app.touch();

-- service area: every person living in one of these ZIPs belongs to this masjid. One masjid per ZIP; the ZIP must be in
-- the masjid's own zone (same rule as OrgStructureSchema).
CREATE TABLE IF NOT EXISTS app.center_zips (
  org_id     uuid NOT NULL,
  zip        text NOT NULL,
  center_id  uuid NOT NULL,
  PRIMARY KEY (org_id, zip),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, zip) REFERENCES app.zone_zips(org_id, zip) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS center_zips_center ON app.center_zips (org_id, center_id);
SELECT app.tenant_table('app.center_zips');
CREATE OR REPLACE FUNCTION app.check_center_zip() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zc uuid; cz uuid; BEGIN
  SELECT zone_id INTO zc FROM app.zone_zips WHERE org_id = NEW.org_id AND zip = NEW.zip;
  SELECT zone_id INTO cz FROM app.centers WHERE org_id = NEW.org_id AND id = NEW.center_id;
  IF zc IS DISTINCT FROM cz THEN RAISE EXCEPTION 'ZIP % is in another zone than this masjid', NEW.zip; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS check_center_zip ON app.center_zips;
CREATE TRIGGER check_center_zip BEFORE INSERT OR UPDATE ON app.center_zips FOR EACH ROW EXECUTE FUNCTION app.check_center_zip();

-- ZIP → masjid → zone in one call (join form, Zakat routing, member placement)
CREATE OR REPLACE FUNCTION app.home_for_zip(z text) RETURNS TABLE (zone_id uuid, center_id uuid, why text) LANGUAGE sql STABLE AS $$
  SELECT zz.zone_id, cz.center_id,
         CASE WHEN zz.zone_id IS NULL THEN format('ZIP %s is outside every zone.', z)
              WHEN cz.center_id IS NULL THEN format('ZIP %s is in a zone, but no masjid serves it yet.', z) ELSE '' END
  FROM (SELECT 1) one
  LEFT JOIN app.zone_zips zz ON zz.org_id = app.current_org() AND zz.zip = left(z, 5)
  LEFT JOIN app.center_zips cz ON cz.org_id = app.current_org() AND cz.zip = left(z, 5)
    AND EXISTS (SELECT 1 FROM app.centers c WHERE c.org_id = cz.org_id AND c.id = cz.center_id AND c.active)
$$;
GRANT EXECUTE ON FUNCTION app.home_for_zip(text) TO app_api, app_platform;
-- nearest active masjids to a point (border offers: "keep, or ask to join X – 3.2 miles away")
CREATE OR REPLACE FUNCTION app.nearest_centers(p_lat numeric, p_lng numeric, n integer DEFAULT 3) RETURNS TABLE (center_id uuid, name text, miles numeric) LANGUAGE sql STABLE AS $$
  SELECT c.id, c.name, geo.miles(p_lat, p_lng, c.lat, c.lng) FROM app.centers c
  WHERE c.org_id = app.current_org() AND c.active AND c.lat IS NOT NULL ORDER BY 3 LIMIT n
$$;
GRANT EXECUTE ON FUNCTION app.nearest_centers(numeric, numeric, integer) TO app_api, app_platform;

-- Jumu'ah and other recurring prayers --------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.center_jumuah (
  org_id      uuid NOT NULL,
  center_id   uuid NOT NULL,
  slot        smallint NOT NULL CHECK (slot BETWEEN 1 AND 4),
  khutbah_at  time NOT NULL,
  label       text NOT NULL DEFAULT '',          -- "Arabic/English", "Youth"
  language    text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, center_id, slot),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.center_jumuah');

-- contacts of a masjid (office, imam, facilities…) – public ones show on the website ---------------------------------
CREATE TABLE IF NOT EXISTS app.center_contacts (
  org_id      uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  center_id   uuid NOT NULL,
  label       text NOT NULL,                     -- Office, Imam, Facilities, Janazah
  name        text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  email       citext NOT NULL DEFAULT '',
  public      boolean NOT NULL DEFAULT false,
  sort        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.center_contacts');

-- the masjid's working body: seats (Associate Director, Membership Secretary, Area Representative for some ZIPs…) ----
-- Elected seats and their history live in officials (0011); this is the day-to-day team a masjid leader builds.
CREATE TABLE IF NOT EXISTS app.center_positions (
  org_id      uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  center_id   uuid NOT NULL,
  title       text NOT NULL,                     -- the organization's own words
  role_id     text NOT NULL DEFAULT '',          -- admin role it grants (app.admin_roles.id) – '' = no admin access
  zips        text[] NOT NULL DEFAULT '{}',      -- Area Representative: the ZIPs they represent
  seats       smallint NOT NULL DEFAULT 1 CHECK (seats BETWEEN 1 AND 50),
  sort        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.center_positions');
CREATE TABLE IF NOT EXISTS app.center_assignments (
  org_id       uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  position_id  uuid NOT NULL,
  member_id    text,                             -- app.members.id when the person is a member
  name         text NOT NULL,
  email        citext NOT NULL DEFAULT '',
  phone        text NOT NULL DEFAULT '',
  starts_on    date NOT NULL DEFAULT current_date,
  ends_on      date,
  given_by     text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, position_id) REFERENCES app.center_positions(org_id, id) ON DELETE CASCADE,
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS center_assignments_current ON app.center_assignments (org_id, position_id) WHERE ends_on IS NULL;
SELECT app.tenant_table('app.center_assignments');
