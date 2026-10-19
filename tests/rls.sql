-- White-box: tenant isolation. Two organizations; the API role sees only the organization of its transaction,
-- cannot write into another, cannot change the audit log, cannot cancel the founding organization.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO platform.organizations (id, slug, name, founding) VALUES ('11111111-1111-1111-1111-111111111111', 'rls-a', 'Org A', true), ('22222222-2222-2222-2222-222222222222', 'rls-b', 'Org B', false) ON CONFLICT (slug) DO NOTHING;
INSERT INTO app.documents (org_id, key, data) VALUES ('11111111-1111-1111-1111-111111111111', 'home', '{"a":1}'), ('22222222-2222-2222-2222-222222222222', 'home', '{"b":1}') ON CONFLICT DO NOTHING;
INSERT INTO app.members (org_id, id, first_name, last_name, email, plan, joined_year, applied_on) VALUES ('11111111-1111-1111-1111-111111111111', 'HOU-900001', 'A', 'One', 'a@example.org', 'single', 2026, '2026-10-01'), ('22222222-2222-2222-2222-222222222222', 'HOU-900001', 'B', 'One', 'b@example.org', 'single', 2026, '2026-10-01') ON CONFLICT DO NOTHING;
COMMIT;

-- 1. as the API in org A
BEGIN;
SET LOCAL ROLE app_api;
SET LOCAL app.org_id = '11111111-1111-1111-1111-111111111111';
SELECT 'docs seen by A' AS test, count(*) = 1 AND bool_and(data = '{"a":1}') AS ok FROM app.documents;
SELECT 'members seen by A' AS test, count(*) = 1 AND bool_and(first_name = 'A') AS ok FROM app.members;
SELECT 'own org row' AS test, count(*) = 1 AND bool_and(slug = 'rls-a') AS ok FROM platform.organizations;
-- writing into B is refused by the policy
SAVEPOINT s1;
DO $$ BEGIN
  BEGIN
    INSERT INTO app.documents (org_id, key, data) VALUES ('22222222-2222-2222-2222-222222222222', 'news', '{}');
    RAISE EXCEPTION 'FAIL: cross-tenant insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: cross-tenant insert refused'; END;
END $$;
ROLLBACK TO SAVEPOINT s1;
-- an update that would move a row to B is refused
SAVEPOINT s2;
DO $$ BEGIN
  BEGIN
    UPDATE app.documents SET org_id = '22222222-2222-2222-2222-222222222222' WHERE key = 'home';
    RAISE EXCEPTION 'FAIL: moving a row to another tenant was allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: row move refused'; END;
END $$;
ROLLBACK TO SAVEPOINT s2;
-- audit is append-only
INSERT INTO app.audit_log (org_id, actor, area, action) VALUES ('11111111-1111-1111-1111-111111111111', 'test', 'members', 'Test');
SAVEPOINT s3;
DO $$ BEGIN
  BEGIN
    DELETE FROM app.audit_log; RAISE EXCEPTION 'FAIL: audit delete was allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: audit delete refused'; END;
END $$;
ROLLBACK TO SAVEPOINT s3;
ROLLBACK;

-- 2. no tenant set → nothing visible
BEGIN;
SET LOCAL ROLE app_api;
SELECT 'no tenant: no documents' AS test, count(*) = 0 AS ok FROM app.documents;
SELECT 'no tenant: no members' AS test, count(*) = 0 AS ok FROM app.members;
ROLLBACK;

-- 3. the platform sees both; the founding org cannot be cancelled or deleted
BEGIN;
SET LOCAL ROLE app_platform;
SELECT 'platform sees both docs' AS test, count(*) >= 2 AS ok FROM app.documents WHERE key = 'home' AND org_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
SAVEPOINT s4;
DO $$ BEGIN
  BEGIN
    UPDATE platform.organizations SET status = 'cancelled' WHERE slug = 'rls-a'; RAISE EXCEPTION 'FAIL: founding org cancelled';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE '%cannot be cancelled%' THEN RAISE NOTICE 'ok: founding cancel refused'; ELSE RAISE; END IF; END;
END $$;
ROLLBACK TO SAVEPOINT s4;
UPDATE platform.organizations SET status = 'cancelled' WHERE slug = 'rls-b';
SELECT 'other org can be cancelled' AS test, status = 'cancelled' AS ok FROM platform.organizations WHERE slug = 'rls-b';
ROLLBACK;

-- 4. versions are kept (last 20) on publish
BEGIN;
SET LOCAL ROLE app_api;
SET LOCAL app.org_id = '11111111-1111-1111-1111-111111111111';
UPDATE app.documents SET version = version + 1, data = '{"a":2}' WHERE key = 'home';
SELECT 'two versions kept' AS test, count(*) = 2 AS ok FROM app.document_versions WHERE key = 'home';
ROLLBACK;

-- cleanup
DELETE FROM platform.organizations WHERE slug = 'rls-b';
UPDATE platform.organizations SET founding = false, client_no = NULL WHERE slug = 'rls-a';   -- 0002: client #1 is guarded too
DELETE FROM platform.organizations WHERE slug = 'rls-a';
