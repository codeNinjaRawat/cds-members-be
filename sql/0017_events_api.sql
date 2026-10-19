-- 0017 Events API (B4b). The admin edits events in the `events` document (web/src/lib/community/events.ts); every publish
-- projects them into app.events (+ ticket types). Registrations are rows: seats are taken under a row lock on the event,
-- so two people can never get the last seat. `spec` keeps the whole event as the admin wrote it (the rules run on it).

ALTER TABLE app.events ADD COLUMN IF NOT EXISTS spec jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app.events ADD COLUMN IF NOT EXISTS center_name text NOT NULL DEFAULT '';      -- as written (may be an off-site name)
ALTER TABLE app.events ADD COLUMN IF NOT EXISTS waitlist boolean NOT NULL DEFAULT false;
ALTER TABLE app.event_ticket_types ADD COLUMN IF NOT EXISTS guest_price_cents integer NOT NULL DEFAULT 0 CHECK (guest_price_cents >= 0);
ALTER TABLE app.event_ticket_types ADD COLUMN IF NOT EXISTS access_code citext;            -- server-only; never in a public answer
ALTER TABLE app.event_ticket_types ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

ALTER TABLE app.registrations ADD COLUMN IF NOT EXISTS type_id text NOT NULL DEFAULT '';
ALTER TABLE app.registrations ADD COLUMN IF NOT EXISTS seats integer NOT NULL DEFAULT 1 CHECK (seats BETWEEN 1 AND 21);
ALTER TABLE app.registrations ADD COLUMN IF NOT EXISTS paid_cents integer NOT NULL DEFAULT 0 CHECK (paid_cents >= 0);
ALTER TABLE app.registrations ADD COLUMN IF NOT EXISTS refund_cents integer NOT NULL DEFAULT 0 CHECK (refund_cents >= 0);
ALTER TABLE app.registrations ADD COLUMN IF NOT EXISTS paid_method text NOT NULL DEFAULT '';
ALTER TABLE app.registrations ADD COLUMN IF NOT EXISTS manage_hash text NOT NULL DEFAULT '';  -- sha-256 of the link a guest gets to cancel
ALTER TABLE app.registrations ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'website' CHECK (source IN ('website', 'portal', 'office', 'door'));
ALTER TABLE app.registrations ADD COLUMN IF NOT EXISTS cancelled_by text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS registrations_manage ON app.registrations (org_id, manage_hash) WHERE manage_hash <> '';

-- reminders already sent (one per registration and "days before")
CREATE TABLE IF NOT EXISTS app.event_reminders (
  org_id           uuid NOT NULL,
  registration_id  text NOT NULL,
  days_before      smallint NOT NULL,
  sent_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, registration_id, days_before),
  FOREIGN KEY (org_id, registration_id) REFERENCES app.registrations(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.event_reminders');

-- seats held: confirmed and waiting-for-payment registrations hold seats; waitlist and cancelled do not
CREATE OR REPLACE FUNCTION app.event_taken(p_event text, p_type text DEFAULT NULL) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(seats), 0)::int FROM app.registrations
  WHERE org_id = app.current_org() AND event_id = p_event AND status IN ('confirmed', 'pending-payment') AND (p_type IS NULL OR type_id = p_type)
$$;
GRANT EXECUTE ON FUNCTION app.event_taken(text, text) TO app_api, app_platform;

-- one registration, decided under a lock: confirmed / pending-payment (seats held) or waitlist; raises event_full / type_full
CREATE OR REPLACE FUNCTION app.event_register(p_id text, p_event text, p_type text, p_member text, p_name text, p_email text, p_phone text,
  p_guests text[], p_total integer, p_code text, p_manage text, p_source text, p_answers jsonb)
RETURNS TABLE (status text, waitlist_pos integer) LANGUAGE plpgsql AS $$
DECLARE e app.events; t app.event_ticket_types; seats int := 1 + coalesce(array_length(p_guests, 1), 0); taken int; st text; pos int;
BEGIN
  SELECT * INTO e FROM app.events WHERE org_id = app.current_org() AND id = p_event FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'event_missing'; END IF;
  SELECT * INTO t FROM app.event_ticket_types WHERE org_id = e.org_id AND event_id = e.id AND id = p_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'type_missing'; END IF;
  taken := app.event_taken(e.id);
  IF t.limit_total IS NOT NULL AND app.event_taken(e.id, t.id) + seats > t.limit_total THEN RAISE EXCEPTION 'type_full'; END IF;
  IF e.capacity IS NOT NULL AND taken + seats > e.capacity THEN
    IF NOT e.waitlist THEN RAISE EXCEPTION 'event_full'; END IF;
    st := 'waitlist';
    SELECT coalesce(max(r.waitlist_pos), 0) + 1 INTO pos FROM app.registrations r WHERE r.org_id = e.org_id AND r.event_id = e.id AND r.status = 'waitlist';
  ELSE
    st := CASE WHEN p_total > 0 THEN 'pending-payment' ELSE 'confirmed' END;
  END IF;
  INSERT INTO app.registrations (org_id, id, event_id, member_id, name, email, phone, status, waitlist_pos, total_cents, code_used, type_id, seats, manage_hash, source, answers)
  VALUES (e.org_id, p_id, e.id, NULLIF(p_member, ''), p_name, p_email, coalesce(p_phone, ''), st, pos, p_total, NULLIF(p_code, ''), t.id, seats, coalesce(p_manage, ''), p_source, coalesce(p_answers, '{}'::jsonb));
  INSERT INTO app.registration_guests (org_id, registration_id, ticket_type_id, name)
  SELECT e.org_id, p_id, t.id, g FROM unnest(ARRAY[p_name] || coalesce(p_guests, '{}'::text[])) g;
  RETURN QUERY SELECT st, pos;
END $$;
GRANT EXECUTE ON FUNCTION app.event_register(text, text, text, text, text, text, text, text[], integer, text, text, text, jsonb) TO app_api;

-- after seats free up: the waitlist moves up in order (nobody skips ahead); returns the promoted registration ids
CREATE OR REPLACE FUNCTION app.event_promote(p_event text) RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE e app.events; r record; left_ int;
BEGIN
  SELECT * INTO e FROM app.events WHERE org_id = app.current_org() AND id = p_event FOR UPDATE;
  IF NOT FOUND OR e.capacity IS NULL OR e.status <> 'published' THEN RETURN; END IF;
  left_ := e.capacity - app.event_taken(e.id);
  FOR r IN SELECT x.id, x.seats, x.total_cents FROM app.registrations x WHERE x.org_id = e.org_id AND x.event_id = e.id AND x.status = 'waitlist' ORDER BY x.waitlist_pos, x.created_at LOOP
    EXIT WHEN r.seats > left_;
    UPDATE app.registrations SET status = CASE WHEN r.total_cents > 0 THEN 'pending-payment' ELSE 'confirmed' END, waitlist_pos = NULL WHERE org_id = e.org_id AND id = r.id;
    left_ := left_ - r.seats;
    RETURN NEXT r.id;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION app.event_promote(text) TO app_api;

-- every organization keeps its own clock (events, help-desk hours, reminders); ISGH is America/Chicago
ALTER TABLE platform.organizations ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/Chicago';
CREATE OR REPLACE FUNCTION app.org_tz() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
  SELECT coalesce((SELECT timezone FROM platform.organizations WHERE id = NULLIF(current_setting('app.org_id', true), '')::uuid), 'America/Chicago')
$$;
GRANT EXECUTE ON FUNCTION app.org_tz() TO app_api, app_platform;
