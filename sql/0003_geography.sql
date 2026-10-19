-- 0003 Geography ("city"): shared reference places for every client + each organization's own zones.
--   geo.*   = the same for everyone (countries, states, cities, ZIP / postal codes with a center point). Read-only for the API,
--             loaded by the platform (US Census ZCTA file for the US; other countries later). No tenant data here.
--   app.zones, app.zone_zips, app.org_cities = an organization's own map (ISGH: five zones in Greater Houston).
-- Distances use a plain haversine function; zone boundary polygons are kept as GeoJSON (PostGIS can be added later
-- without changing the columns).

CREATE SCHEMA IF NOT EXISTS geo;
GRANT USAGE ON SCHEMA geo TO app_api, app_platform;

CREATE TABLE IF NOT EXISTS geo.countries (
  code       char(2) PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),     -- ISO 3166-1
  name       text NOT NULL,
  postal_re  text NOT NULL DEFAULT '',                             -- e.g. ^[0-9]{5}$ for US
  currency   char(3) NOT NULL DEFAULT 'USD',
  phone_code text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS geo.states (
  country    char(2) NOT NULL REFERENCES geo.countries(code),
  code       text NOT NULL,                                        -- TX
  name       text NOT NULL,
  PRIMARY KEY (country, code)
);
CREATE TABLE IF NOT EXISTS geo.cities (
  id         serial PRIMARY KEY,
  country    char(2) NOT NULL,
  state      text NOT NULL,
  name       text NOT NULL,
  county     text NOT NULL DEFAULT '',
  lat        numeric(9, 6),
  lng        numeric(9, 6),
  timezone   text NOT NULL DEFAULT '',
  population integer,
  FOREIGN KEY (country, state) REFERENCES geo.states(country, code),
  UNIQUE (country, state, name)
);
CREATE INDEX IF NOT EXISTS cities_name_trgm ON geo.cities USING gin (name gin_trgm_ops);
CREATE TABLE IF NOT EXISTS geo.postal_codes (
  country    char(2) NOT NULL REFERENCES geo.countries(code),
  code       text NOT NULL,                                        -- 77036
  city_id    integer REFERENCES geo.cities(id),
  city       text NOT NULL DEFAULT '',                             -- the "preferred" city name of the ZIP
  state      text NOT NULL DEFAULT '',
  county     text NOT NULL DEFAULT '',
  lat        numeric(9, 6),
  lng        numeric(9, 6),
  timezone   text NOT NULL DEFAULT '',
  PRIMARY KEY (country, code)
);
CREATE INDEX IF NOT EXISTS postal_codes_city ON geo.postal_codes (city_id);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['geo.countries', 'geo.states', 'geo.cities', 'geo.postal_codes'] LOOP
    EXECUTE format('GRANT SELECT ON %s TO app_api', t);
    EXECUTE format('GRANT ALL ON %s TO app_platform', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE geo.cities_id_seq TO app_platform;

-- great-circle distance in miles (US) – used for "near a zone border" and "nearest masjid"
CREATE OR REPLACE FUNCTION geo.miles(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN lat1 IS NULL OR lat2 IS NULL THEN NULL ELSE
    round((3958.8 * 2 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))::numeric, 2) END
$$;
GRANT EXECUTE ON FUNCTION geo.miles(numeric, numeric, numeric, numeric) TO app_api, app_platform;

-- reference rows needed by every client (the full ZIP list is loaded by a script, not by a migration)
INSERT INTO geo.countries (code, name, postal_re, currency, phone_code) VALUES
  ('US', 'United States', '^[0-9]{5}$', 'USD', '+1'), ('CA', 'Canada', '^[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9]$', 'CAD', '+1'), ('GB', 'United Kingdom', '^[A-Z0-9 ]{5,8}$', 'GBP', '+44')
ON CONFLICT (code) DO NOTHING;
INSERT INTO geo.states (country, code, name) SELECT 'US', s[1], s[2] FROM (VALUES
  (ARRAY['AL','Alabama']),(ARRAY['AK','Alaska']),(ARRAY['AZ','Arizona']),(ARRAY['AR','Arkansas']),(ARRAY['CA','California']),(ARRAY['CO','Colorado']),(ARRAY['CT','Connecticut']),
  (ARRAY['DE','Delaware']),(ARRAY['DC','District of Columbia']),(ARRAY['FL','Florida']),(ARRAY['GA','Georgia']),(ARRAY['HI','Hawaii']),(ARRAY['ID','Idaho']),(ARRAY['IL','Illinois']),
  (ARRAY['IN','Indiana']),(ARRAY['IA','Iowa']),(ARRAY['KS','Kansas']),(ARRAY['KY','Kentucky']),(ARRAY['LA','Louisiana']),(ARRAY['ME','Maine']),(ARRAY['MD','Maryland']),
  (ARRAY['MA','Massachusetts']),(ARRAY['MI','Michigan']),(ARRAY['MN','Minnesota']),(ARRAY['MS','Mississippi']),(ARRAY['MO','Missouri']),(ARRAY['MT','Montana']),(ARRAY['NE','Nebraska']),
  (ARRAY['NV','Nevada']),(ARRAY['NH','New Hampshire']),(ARRAY['NJ','New Jersey']),(ARRAY['NM','New Mexico']),(ARRAY['NY','New York']),(ARRAY['NC','North Carolina']),
  (ARRAY['ND','North Dakota']),(ARRAY['OH','Ohio']),(ARRAY['OK','Oklahoma']),(ARRAY['OR','Oregon']),(ARRAY['PA','Pennsylvania']),(ARRAY['RI','Rhode Island']),
  (ARRAY['SC','South Carolina']),(ARRAY['SD','South Dakota']),(ARRAY['TN','Tennessee']),(ARRAY['TX','Texas']),(ARRAY['UT','Utah']),(ARRAY['VT','Vermont']),(ARRAY['VA','Virginia']),
  (ARRAY['WA','Washington']),(ARRAY['WV','West Virginia']),(ARRAY['WI','Wisconsin']),(ARRAY['WY','Wyoming']),(ARRAY['PR','Puerto Rico'])
) v(s) ON CONFLICT DO NOTHING;

-- an organization's cities (where it works – shown on the website, used to suggest ZIPs) -------------------------
CREATE TABLE IF NOT EXISTS app.org_cities (
  org_id    uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  city_id   integer NOT NULL REFERENCES geo.cities(id),
  is_main   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, city_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS org_cities_main ON app.org_cities (org_id) WHERE is_main;
SELECT app.tenant_table('app.org_cities');

-- zones (ISGH: North, Northwest, Southwest, South, Southeast) -------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.zones (
  org_id          uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  code            text NOT NULL CHECK (code ~ '^[a-z0-9-]{1,30}$'),           -- 'sw' (the admin's zone id)
  name            text NOT NULL,
  areas           text NOT NULL DEFAULT '',                                     -- "Alief, Sharpstown, Bellaire…"
  color           text NOT NULL DEFAULT '',
  boundary        jsonb,                                                        -- GeoJSON polygon from the Zones map (KML import)
  director_name   text NOT NULL DEFAULT '',                                     -- shown on the website; the seat itself is in officials
  director_email  citext NOT NULL DEFAULT '',
  term_ends_on    date,
  active          boolean NOT NULL DEFAULT true,
  sort            integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, code)
);
SELECT app.tenant_table('app.zones');
DROP TRIGGER IF EXISTS touch ON app.zones;
CREATE TRIGGER touch BEFORE UPDATE ON app.zones FOR EACH ROW EXECUTE FUNCTION app.touch();

-- one ZIP belongs to one zone of an organization (ZIP is the first guess; the address point decides near borders)
CREATE TABLE IF NOT EXISTS app.zone_zips (
  org_id    uuid NOT NULL,
  zone_id   uuid NOT NULL,
  zip       text NOT NULL CHECK (zip ~ '^[0-9A-Z -]{3,10}$'),
  PRIMARY KEY (org_id, zip),
  FOREIGN KEY (org_id, zone_id) REFERENCES app.zones(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS zone_zips_zone ON app.zone_zips (org_id, zone_id);
SELECT app.tenant_table('app.zone_zips');

-- zone of a ZIP for the current organization
CREATE OR REPLACE FUNCTION app.zone_for_zip(z text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT zone_id FROM app.zone_zips WHERE org_id = app.current_org() AND zip = z
$$;
GRANT EXECUTE ON FUNCTION app.zone_for_zip(text) TO app_api, app_platform;
