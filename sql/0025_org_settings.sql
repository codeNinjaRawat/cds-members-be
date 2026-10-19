-- 0025 Organization settings that used to be ISGH's constants (B6b): the member ID prefix (ISGH: HOU) lives on the
-- organization; the member number keeps counting per organization.
ALTER TABLE platform.organizations ADD COLUMN IF NOT EXISTS member_prefix text NOT NULL DEFAULT '' CHECK (member_prefix = '' OR member_prefix ~ '^[A-Z]{2,5}$');
UPDATE platform.organizations SET member_prefix = 'HOU' WHERE slug = 'isgh' AND member_prefix = '';
CREATE OR REPLACE FUNCTION app.member_prefix() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
  SELECT NULLIF(member_prefix, '') FROM platform.organizations WHERE id = NULLIF(current_setting('app.org_id', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION app.member_prefix() TO app_api, app_platform;
-- the organization's prefix first, then the one most of its members already have, then the fallback the API passes
CREATE OR REPLACE FUNCTION app.next_member_id(o uuid, fallback_prefix text) RETURNS text LANGUAGE sql AS $$
  WITH p AS (SELECT coalesce(app.member_prefix(), (SELECT split_part(id, '-', 1) FROM app.members WHERE org_id = o AND id ~ '^[A-Z]{2,5}-[0-9]{4,8}$' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1), fallback_prefix) AS prefix),
       n AS (SELECT coalesce(max(substring(id from '[0-9]+$')::bigint), 100000) + 1 AS next FROM app.members, p WHERE org_id = o AND id LIKE p.prefix || '-%' AND id ~ '-[0-9]+$')
  SELECT p.prefix || '-' || lpad(n.next::text, 6, '0') FROM p, n
$$;
GRANT EXECUTE ON FUNCTION app.next_member_id(uuid, text) TO app_api, app_platform;
