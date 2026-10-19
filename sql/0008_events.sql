-- 0008 Events: events, ticket types, registrations (with guests and waitlist), check-in, approvals.
-- Shapes: web/src/lib/community/events.ts and event-ops.ts (the `events` document keeps the settings; events are rows).

CREATE TABLE IF NOT EXISTS app.events (
  org_id          uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id              text NOT NULL CHECK (id ~ '^[a-z0-9-]{2,80}$'),     -- slug used in the website address
  title           text NOT NULL,
  summary         text NOT NULL DEFAULT '',
  body            text NOT NULL DEFAULT '',
  category        text NOT NULL DEFAULT 'program',
  center_id       uuid,                                                -- null = the organization / off-site
  venue           text NOT NULL DEFAULT '',
  address         text NOT NULL DEFAULT '',
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  all_day         boolean NOT NULL DEFAULT false,
  capacity        integer CHECK (capacity IS NULL OR capacity > 0),
  audience        text NOT NULL DEFAULT 'public' CHECK (audience IN ('public', 'members', 'group')),
  group_ids       text[] NOT NULL DEFAULT '{}',                         -- group-only events (enforced at registration)
  registration    text NOT NULL DEFAULT 'open' CHECK (registration IN ('none', 'open', 'closed', 'waitlist')),
  registration_closes_at timestamptz,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending-approval', 'published', 'cancelled', 'archived')),
  approval        jsonb NOT NULL DEFAULT '{}'::jsonb,                   -- { state, requestedBy, by, on, note }
  promotion       jsonb NOT NULL DEFAULT '{}'::jsonb,                   -- { featured, email, sms, social }
  image_ref       text NOT NULL DEFAULT '',
  created_by      text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id),
  CHECK (ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS events_upcoming ON app.events (org_id, status, starts_at);
CREATE INDEX IF NOT EXISTS events_center ON app.events (org_id, center_id, starts_at);
SELECT app.tenant_table('app.events');
DROP TRIGGER IF EXISTS touch ON app.events;
CREATE TRIGGER touch BEFORE UPDATE ON app.events FOR EACH ROW EXECUTE FUNCTION app.touch();

CREATE TABLE IF NOT EXISTS app.event_ticket_types (
  org_id        uuid NOT NULL,
  event_id      text NOT NULL,
  id            text NOT NULL,
  name          text NOT NULL,                              -- Adult, Child, Member price
  price_cents   integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  members_only  boolean NOT NULL DEFAULT false,
  limit_total   integer CHECK (limit_total IS NULL OR limit_total > 0),
  limit_per_order smallint CHECK (limit_per_order IS NULL OR limit_per_order > 0),
  sort          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, event_id, id),
  FOREIGN KEY (org_id, event_id) REFERENCES app.events(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.event_ticket_types');
-- discount codes are kept server-side only (never sent to the browser)
CREATE TABLE IF NOT EXISTS app.event_codes (
  org_id      uuid NOT NULL,
  event_id    text NOT NULL,
  code        citext NOT NULL,
  percent_off smallint CHECK (percent_off BETWEEN 1 AND 100),
  cents_off   integer CHECK (cents_off > 0),
  uses_left   integer,
  PRIMARY KEY (org_id, event_id, code),
  FOREIGN KEY (org_id, event_id) REFERENCES app.events(org_id, id) ON DELETE CASCADE,
  CHECK ((percent_off IS NULL) <> (cents_off IS NULL))
);
SELECT app.tenant_table('app.event_codes');

CREATE TABLE IF NOT EXISTS app.registrations (
  org_id         uuid NOT NULL,
  id             text NOT NULL,                              -- REG-…
  event_id       text NOT NULL,
  member_id      text,
  name           text NOT NULL,
  email          citext NOT NULL,
  phone          text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending-payment', 'confirmed', 'waitlist', 'cancelled', 'refunded')),
  waitlist_pos   integer,
  total_cents    integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  code_used      citext,
  payment_id     uuid,
  answers        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  cancelled_at   timestamptz,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, event_id) REFERENCES app.events(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS registrations_event ON app.registrations (org_id, event_id, status);
CREATE INDEX IF NOT EXISTS registrations_waitlist ON app.registrations (org_id, event_id, waitlist_pos) WHERE status = 'waitlist';
CREATE INDEX IF NOT EXISTS registrations_member ON app.registrations (org_id, member_id);
SELECT app.tenant_table('app.registrations');
CREATE TABLE IF NOT EXISTS app.registration_guests (
  org_id           uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  registration_id  text NOT NULL,
  ticket_type_id   text NOT NULL,
  name             text NOT NULL DEFAULT '',
  checked_in_at    timestamptz,
  checked_in_by    text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, registration_id) REFERENCES app.registrations(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS guests_registration ON app.registration_guests (org_id, registration_id);
SELECT app.tenant_table('app.registration_guests');

-- seats taken (confirmed guests) – the registration endpoint locks the event row and compares with capacity
CREATE OR REPLACE VIEW app.event_fill WITH (security_invoker = true) AS
  SELECT e.org_id, e.id AS event_id, e.capacity,
         count(g.id) FILTER (WHERE r.status = 'confirmed') AS taken,
         count(g.id) FILTER (WHERE g.checked_in_at IS NOT NULL) AS checked_in,
         count(DISTINCT r.id) FILTER (WHERE r.status = 'waitlist') AS waitlist
  FROM app.events e
  LEFT JOIN app.registrations r ON r.org_id = e.org_id AND r.event_id = e.id
  LEFT JOIN app.registration_guests g ON g.org_id = r.org_id AND g.registration_id = r.id
  GROUP BY e.org_id, e.id, e.capacity;
GRANT SELECT ON app.event_fill TO app_api, app_platform;
