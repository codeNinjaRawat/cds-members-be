-- 0011 Governance: elected officials (current holders + full history by year), elections (seats, nominations, results,
-- certification), and the frozen voter list (record date, SHA-256 fingerprint, versioned corrections with reasons).
-- Shapes: web/src/lib/community/officials.ts (HolderSchema, TermSchema), elections.ts, and A9 reports (voter snapshot).

-- seats served: one row per person per term (current holders have status 'serving'; history = ended terms) -------------
CREATE TABLE IF NOT EXISTS app.official_terms (
  org_id         uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id             text NOT NULL CHECK (id ~ '^[a-z0-9-]{2,60}$'),
  year           integer NOT NULL CHECK (year BETWEEN 1900 AND 2200),     -- election year
  kind           text NOT NULL CHECK (kind IN ('officer', 'board', 'zonal-director', 'associate-director', 'area-rep', 'secretary', 'other')),
  office         text NOT NULL DEFAULT '',                                  -- president, treasurer… (officer/secretary key)
  title          text NOT NULL DEFAULT '',                                  -- as written by the organization
  zone_id        uuid,
  center_id      uuid,
  zips           text[] NOT NULL DEFAULT '{}',
  at_large       text NOT NULL DEFAULT '' CHECK (at_large IN ('', 'general', 'youth', 'female')),
  name           text NOT NULL,
  member_id      text,
  public_email   citext NOT NULL DEFAULT '',
  how            text NOT NULL DEFAULT 'elected' CHECK (how IN ('elected', 'appointed', 'confirmed', 'acting')),
  term_start     date,
  term_end       date,
  oath_on        date,
  orientation_on date,
  status         text NOT NULL DEFAULT 'serving' CHECK (status IN ('serving', 'vacant', 'ended')),
  end_reason     text NOT NULL DEFAULT '',
  board_terms    smallint NOT NULL DEFAULT 0,
  show_on_website boolean NOT NULL DEFAULT true,
  source         text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'upload', 'election')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, zone_id) REFERENCES app.zones(org_id, id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id),
  CHECK (term_end IS NULL OR term_start IS NULL OR term_end > term_start)
);
CREATE INDEX IF NOT EXISTS official_terms_year ON app.official_terms (org_id, year DESC, kind, office);
CREATE INDEX IF NOT EXISTS official_terms_member ON app.official_terms (org_id, member_id);
-- one serving elected office per member (secretaries and area representatives excluded – Bylaws)
CREATE UNIQUE INDEX IF NOT EXISTS one_office_per_member ON app.official_terms (org_id, member_id)
  WHERE status = 'serving' AND member_id IS NOT NULL AND kind NOT IN ('secretary', 'area-rep');
SELECT app.tenant_table('app.official_terms');

-- elections ------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.elections (
  org_id          uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  year            integer NOT NULL,
  election_day    date NOT NULL,
  record_date     date NOT NULL,                             -- voter eligibility date (ISGH: June 30)
  rules           jsonb NOT NULL DEFAULT '{}'::jsonb,        -- ElectionRulesSchema snapshot used for this election
  status          text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'nominations', 'ballot', 'voting', 'counting', 'certified', 'sworn-in')),
  certified_by    text NOT NULL DEFAULT '',
  certified_on    date,
  sworn_in_on     date,
  PRIMARY KEY (org_id, year)
);
SELECT app.tenant_table('app.elections');
CREATE TABLE IF NOT EXISTS app.election_seats (
  org_id      uuid NOT NULL,
  year        integer NOT NULL,
  id          text NOT NULL,
  kind        text NOT NULL,
  office      text NOT NULL DEFAULT '',
  title       text NOT NULL,
  zone_id     uuid,
  center_id   uuid,
  zips        text[] NOT NULL DEFAULT '{}',
  places      smallint NOT NULL DEFAULT 1 CHECK (places BETWEEN 1 AND 30),
  on_ballot   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, year, id),
  FOREIGN KEY (org_id, year) REFERENCES app.elections(org_id, year) ON DELETE CASCADE
);
SELECT app.tenant_table('app.election_seats');
CREATE TABLE IF NOT EXISTS app.nominations (
  org_id        uuid NOT NULL,
  id            text NOT NULL,
  year          integer NOT NULL,
  seat_id       text NOT NULL,
  member_id     text NOT NULL,
  name          text NOT NULL,
  nominated_by  text NOT NULL DEFAULT '',
  seconded_by   text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'accepted', 'not-eligible', 'declined', 'withdrawn')),
  issues        text[] NOT NULL DEFAULT '{}',              -- nominationIssues() result when checked
  decided_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, year, seat_id) REFERENCES app.election_seats(org_id, year, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS nominations_once ON app.nominations (org_id, year, seat_id, member_id) WHERE status NOT IN ('withdrawn', 'declined');
SELECT app.tenant_table('app.nominations');
CREATE TABLE IF NOT EXISTS app.election_results (
  org_id         uuid NOT NULL,
  year           integer NOT NULL,
  seat_id        text NOT NULL,
  ballots_cast   integer NOT NULL CHECK (ballots_cast >= 0),
  spoiled        integer NOT NULL DEFAULT 0 CHECK (spoiled >= 0),
  counts         jsonb NOT NULL DEFAULT '[]'::jsonb,         -- [{ nominationId, votes }]
  winners        text[] NOT NULL DEFAULT '{}',
  tie_break      text NOT NULL DEFAULT '',
  accepted       boolean NOT NULL DEFAULT false,
  counted_by     text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, year, seat_id),
  FOREIGN KEY (org_id, year, seat_id) REFERENCES app.election_seats(org_id, year, id) ON DELETE CASCADE,
  CHECK (spoiled <= ballots_cast)
);
SELECT app.tenant_table('app.election_results');

-- voter list snapshot: frozen on the record date; corrections are new versions with a reason (never edits) --------------
CREATE TABLE IF NOT EXISTS app.voter_snapshots (
  org_id       uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  year         integer NOT NULL,
  version      integer NOT NULL,
  record_date  date NOT NULL,
  frozen_at    timestamptz NOT NULL DEFAULT now(),
  frozen_by    text NOT NULL,
  reason       text NOT NULL DEFAULT 'Frozen on the record date',
  voters       integer NOT NULL,
  sha256       bytea NOT NULL,                                -- fingerprint of the sorted member-id list
  PRIMARY KEY (org_id, year, version)
);
SELECT app.tenant_table('app.voter_snapshots', true);
CREATE TABLE IF NOT EXISTS app.voter_snapshot_rows (
  org_id      uuid NOT NULL,
  year        integer NOT NULL,
  version     integer NOT NULL,
  member_id   text NOT NULL,
  center_id   uuid,
  zone_id     uuid,
  zip         text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, year, version, member_id),
  FOREIGN KEY (org_id, year, version) REFERENCES app.voter_snapshots(org_id, year, version)
);
CREATE INDEX IF NOT EXISTS voter_rows_center ON app.voter_snapshot_rows (org_id, year, version, center_id);
SELECT app.tenant_table('app.voter_snapshot_rows', true);
-- the fingerprint the Election Commission prints (same rule as the admin: sha-256 of member ids sorted, one per line)
CREATE OR REPLACE FUNCTION app.voter_fingerprint(p_year integer, p_version integer) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(string_agg(member_id, E'\n' ORDER BY member_id), 'UTF8')), 'hex')
  FROM app.voter_snapshot_rows WHERE org_id = app.current_org() AND year = p_year AND version = p_version
$$;
GRANT EXECUTE ON FUNCTION app.voter_fingerprint(integer, integer) TO app_api, app_platform;
