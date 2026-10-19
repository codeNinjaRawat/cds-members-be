-- White-box test for migrations 0002–0013 (run after tests/rls.sql or on its own):
--   1. every tenant table (schema app, has org_id) has Row Level Security ENABLED + FORCED and an app_api policy
--   2. with real rows in two organizations, the API role in org A sees only org A in EVERY tenant table
--   3. member placement (ZIP → masjid → zone, member number), the primary sort, and the database guards
-- Prints "name|t" lines; any FAIL raises an error. psql -v ON_ERROR_STOP=1 -At -f tests/rls_all.sql
\set ON_ERROR_STOP on

-- 1. structure -------------------------------------------------------------------------------------------------------
SELECT 'every tenant table has RLS enabled + forced' AS test, count(*) = 0 AS ok FROM (
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity)) bad;
SELECT 'every tenant table has an API policy' AS test, count(*) = 0 AS ok FROM (
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id')
    AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = c.relname AND p.policyname = 'tenant_isolation')) bad;
SELECT 'views run with the caller''s rights' AS test, bool_and(coalesce(c.reloptions::text LIKE '%security_invoker=true%', false)) AS ok
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind = 'v';
SELECT 'the API role cannot read platform users or sessions' AS test,
  NOT has_table_privilege('app_api', 'platform.users', 'SELECT') AND NOT has_table_privilege('app_api', 'platform.sessions', 'SELECT') AND NOT has_table_privilege('app_api', 'platform.login_codes', 'SELECT') AS ok;

-- 2. data in two organizations -----------------------------------------------------------------------------------------
BEGIN;
SET LOCAL ROLE app_platform;
INSERT INTO platform.organizations (id, slug, name, plan) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a', 'test-a', 'Org A', 'network'), ('bbbbbbbb-0000-0000-0000-00000000000b', 'test-b', 'Org B', 'starter');
DO $$ DECLARE o uuid; z uuid; c uuid; BEGIN
  FOREACH o IN ARRAY ARRAY['aaaaaaaa-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-00000000000b']::uuid[] LOOP
    INSERT INTO app.zones (org_id, code, name, sort) VALUES (o, 'sw', 'Southwest', 1) RETURNING id INTO z;
    INSERT INTO app.zone_zips (org_id, zone_id, zip) VALUES (o, z, '77036'), (o, z, '77072');
    INSERT INTO app.centers (org_id, code, zone_id, name, lat, lng) VALUES (o, 'sw1', z, 'Southwest Islamic Center 1', 29.7046, -95.5383) RETURNING id INTO c;
    INSERT INTO app.center_zips (org_id, zip, center_id) VALUES (o, '77036', c), (o, '77072', c);
    INSERT INTO app.membership_plans (org_id, id, name, term, price_cents) VALUES (o, 'individual', 'Individual', 'year', 2000), (o, 'life', 'Lifetime', 'lifetime', 100000);
    INSERT INTO app.members (org_id, id, first_name, last_name, email, plan, joined_year, applied_on, approved_on, zip)
      VALUES (o, 'M-1', 'Amina', 'Khan', 'amina@example.org', 'individual', 2026, '2026-01-02', '2026-01-10', '77036'),
             (o, 'M-2', 'Bilal', 'Ahmed', 'bilal@example.org', 'individual', 2026, '2026-01-02', '2026-01-10', '77072'),
             (o, 'M-3', 'Zaid', 'Ali', 'zaid@example.org', 'life', 2026, '2026-01-02', NULL, '77036');
    INSERT INTO app.memberships (org_id, member_id, plan_id, starts_on, ends_on) VALUES (o, 'M-1', 'individual', current_date - 30, current_date + 300), (o, 'M-2', 'individual', '2024-01-01', '2024-12-31');
    INSERT INTO app.admin_roles (org_id, id, name, permissions) VALUES (o, 'viewer', 'Viewer', ARRAY['members.view']);
    INSERT INTO app.admins (org_id, id, name, email, status) VALUES (o, 'v1', 'Viewer one', 'v1@example.org', 'active');
    INSERT INTO app.admin_assignments (org_id, admin_id, role_id, is_main) VALUES (o, 'v1', 'viewer', true);
    INSERT INTO app.funds (org_id, id, name, kind) VALUES (o, 'general', 'General', 'general');
    INSERT INTO app.donations (org_id, id, member_id, fund_id, amount_cents, given_on, method, platform, platform_ref) VALUES (o, 'D-1', 'M-1', 'general', 5000, current_date, 'card', 'stripe', 'pi_1');
    INSERT INTO app.events (org_id, id, title, starts_at, ends_at, status) VALUES (o, 'family-night', 'Family night', now() + interval '3 days', now() + interval '3 days 2 hours', 'published');
    INSERT INTO app.hd_tickets (org_id, id, subject, category_id, channel) VALUES (o, 'T-1041', 'Parking blocked', 'facilities', 'website');
    INSERT INTO app.hd_events (org_id, ticket_id, by, kind, text) VALUES (o, 'T-1041', 'Website', 'created', 'Cars across the exit');
    INSERT INTO app.task_projects (org_id, id, name, owner) VALUES (o, 'agm', 'AGM', 'v1');
    INSERT INTO app.tasks (org_id, id, project_id, title, owner, due) VALUES (o, 'task-1', 'agm', 'Send the notice', 'v1', current_date + 5);
    INSERT INTO app.zakat_cases (org_id, id, applicant_name, need, requested_cents, center_id) VALUES (o, 'ZKT-2026-001', 'Applicant', 'rent', 80000, c);
    INSERT INTO app.official_terms (org_id, id, year, kind, office, name, member_id) VALUES (o, 'pres-2025', 2025, 'officer', 'president', 'Amina Khan', 'M-1');
    INSERT INTO app.records (org_id, id, title, category, doc_date, url) VALUES (o, 'bylaws', 'Bylaws', 'bylaws', '2025-09-28', '/files/bylaws.pdf');
    INSERT INTO app.groups (org_id, id, name, kind) VALUES (o, 'volunteers', 'Volunteers', 'manual');
    INSERT INTO app.group_members (org_id, group_id, member_id) VALUES (o, 'volunteers', 'M-1');
  END LOOP;
END $$;
COMMIT;

BEGIN;
SET LOCAL ROLE app_api;
SET LOCAL app.org_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
DO $$ DECLARE t record; n bigint; other bigint; total integer := 0; BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = 'app' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id') LOOP
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE org_id <> %L) FROM app.%I', 'aaaaaaaa-0000-0000-0000-00000000000a', t.relname) INTO n, other;
    IF other > 0 THEN RAISE EXCEPTION 'FAIL: org A sees % rows of another org in app.%', other, t.relname; END IF;
    total := total + 1;
  END LOOP;
  RAISE NOTICE 'checked % tenant tables', total;
END $$;
SELECT 'org A sees its 3 members only' AS test, count(*) = 3 AS ok FROM app.members;
SELECT 'org A sees one masjid' AS test, count(*) = 1 AS ok FROM app.centers;
SELECT 'no cross-tenant insert' AS test, true AS ok;
SAVEPOINT x;
DO $$ BEGIN
  BEGIN INSERT INTO app.tasks (org_id, id, title, owner) VALUES ('bbbbbbbb-0000-0000-0000-00000000000b', 'evil', 'Evil task', 'v1'); RAISE EXCEPTION 'FAIL: cross-tenant task insert';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE app.hd_events SET text = 'changed'; RAISE EXCEPTION 'FAIL: help-desk thread changed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
ROLLBACK TO SAVEPOINT x;

-- 3. placement, primary sort, guards ------------------------------------------------------------------------------------
SELECT 'ZIP places the member in masjid and zone' AS test, bool_and(center_id IS NOT NULL AND zone_id IS NOT NULL AND center = 'Southwest Islamic Center 1' AND zone = 'sw') AS ok FROM app.members;
SELECT 'member numbers start at 100001 per organization' AS test, array_agg(member_no ORDER BY member_no) = ARRAY[100001, 100002, 100003]::bigint[] AS ok FROM app.members;
SELECT 'status follows memberships (active / expired / pending)' AS test,
  array_agg(status ORDER BY id) = ARRAY['active', 'expired', 'pending'] AS ok FROM app.members;
SELECT 'primary sort: masjid → zone → status → last name' AS test,
  array_agg(last_name ORDER BY center_sort, center_name, zone_sort, status_rank, sort_name, member_no) = ARRAY['Khan', 'Ali', 'Ahmed'] AS ok FROM app.member_list;
SELECT 'home_for_zip' AS test, (SELECT why FROM app.home_for_zip('77036')) = '' AND (SELECT why FROM app.home_for_zip('10001')) LIKE '%outside every zone%' AS ok;
SELECT 'can() and in_scope()' AS test, app.can('v1', 'members.view') AND NOT app.can('v1', 'members.edit') AND app.in_scope('v1', NULL, NULL) AS ok;
SELECT 'event fill view' AS test, count(*) = 1 AS ok FROM app.event_fill;
SAVEPOINT g;
DO $$ DECLARE z2 uuid; c1 uuid; BEGIN
  SELECT id INTO c1 FROM app.centers LIMIT 1;
  INSERT INTO app.zones (org_id, code, name) VALUES (app.current_org(), 'n', 'North') RETURNING id INTO z2;
  INSERT INTO app.zone_zips (org_id, zone_id, zip) VALUES (app.current_org(), z2, '77014');
  BEGIN INSERT INTO app.center_zips (org_id, zip, center_id) VALUES (app.current_org(), '77014', c1); RAISE EXCEPTION 'FAIL: ZIP of another zone accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%another zone%' THEN RAISE; END IF; END;
  BEGIN INSERT INTO app.official_terms (org_id, id, year, kind, office, name, member_id) VALUES (app.current_org(), 'vp-2025', 2025, 'officer', 'vice-president', 'Amina Khan', 'M-1'); RAISE EXCEPTION 'FAIL: two offices for one member';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  INSERT INTO app.zakat_steps (org_id, case_id, by, admin_id, action, level) VALUES (app.current_org(), 'ZKT-2026-001', 'Lvl 1', 'v1', 'approve', 1);
  BEGIN INSERT INTO app.zakat_steps (org_id, case_id, by, admin_id, action, level) VALUES (app.current_org(), 'ZKT-2026-001', 'Lvl 1', 'v1', 'approve', 2); RAISE EXCEPTION 'FAIL: approved twice';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%already approved%' THEN RAISE; END IF; END;
  BEGIN INSERT INTO app.zakat_steps (org_id, case_id, by, admin_id, action) VALUES (app.current_org(), 'ZKT-2026-001', 'Lvl 1', 'v1', 'pay'); RAISE EXCEPTION 'FAIL: approver paid';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%cannot pay%' THEN RAISE; END IF; END;
  BEGIN INSERT INTO app.tasks (org_id, id, title, owner, status) VALUES (app.current_org(), 'bad', 'Done without a date', 'v1', 'done'); RAISE EXCEPTION 'FAIL: done task without done_at';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SELECT 'guards: ZIP zone, one office, Zakat four-eyes, task done date' AS test, true AS ok;
ROLLBACK TO SAVEPOINT g;
SELECT 'voter fingerprint is stable' AS test, app.voter_fingerprint(2026, 1) IS NULL AS ok;
ROLLBACK;

-- platform guards
BEGIN;
SAVEPOINT r;
DO $$ BEGIN
  BEGIN INSERT INTO platform.organizations (slug, name) VALUES ('admin', 'Reserved'); RAISE EXCEPTION 'FAIL: reserved slug';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%reserved%' THEN RAISE; END IF; END;
END $$;
SELECT 'reserved slugs refused' AS test, true AS ok;
SELECT 'effective modules: plan + always-on' AS test, 'website' = ANY (platform.effective_modules('bbbbbbbb-0000-0000-0000-00000000000b')) AND NOT ('elections' = ANY (platform.effective_modules('bbbbbbbb-0000-0000-0000-00000000000b'))) AS ok;
INSERT INTO platform.org_modules (org_id, module, value) VALUES ('bbbbbbbb-0000-0000-0000-00000000000b', 'elections', 'on'), ('bbbbbbbb-0000-0000-0000-00000000000b', 'giving', 'off');
SELECT 'add-on on, module off' AS test, 'elections' = ANY (platform.effective_modules('bbbbbbbb-0000-0000-0000-00000000000b')) AND NOT ('giving' = ANY (platform.effective_modules('bbbbbbbb-0000-0000-0000-00000000000b'))) AS ok;
SELECT 'host resolution' AS test, (SELECT org_id FROM platform.org_for_host('test-a.nextgrow.pro')) = 'aaaaaaaa-0000-0000-0000-00000000000a' AND (SELECT app FROM platform.org_for_host('test-a-admin.nextgrow.pro')) = 'admin' AS ok;
ROLLBACK;

-- cleanup
DELETE FROM platform.organizations WHERE slug IN ('test-a', 'test-b');
