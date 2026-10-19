-- 0015 B2 helpers: keep members.status / paid_through right for everyone (not only members with membership rows),
-- and build membership terms from dues payments (seed, imports, payments recorded at a desk).
-- status is a cache for sorting and filtering; the rules engine (members.ts statusOf / eligibility) stays the judge.

CREATE OR REPLACE FUNCTION app.refresh_status(o uuid, only_member text DEFAULT NULL) RETURNS integer LANGUAGE sql AS $$
  WITH t AS (
    SELECT m.org_id, m.id,
      bool_or(ms.ends_on IS NULL AND ms.id IS NOT NULL) AS life,
      max(ms.ends_on) AS pt
    FROM app.members m
    LEFT JOIN app.memberships ms ON ms.org_id = m.org_id AND ms.member_id = m.id AND ms.status = 'active'
    WHERE m.org_id = o AND (only_member IS NULL OR m.id = only_member)
    GROUP BY m.org_id, m.id
  ), u AS (
    UPDATE app.members m SET
      paid_through = CASE WHEN t.life THEN NULL ELSE t.pt END,
      status = CASE
        WHEN m.archived IS NOT NULL THEN 'archived'
        WHEN m.standing = 'resigned' THEN 'resigned'
        WHEN m.standing = 'expelled' THEN 'expelled'
        WHEN m.approved_on IS NULL THEN 'pending'
        WHEN t.life THEN 'life'
        WHEN t.pt >= current_date THEN 'active'
        ELSE 'expired' END
    FROM t WHERE m.org_id = t.org_id AND m.id = t.id
    RETURNING 1)
  SELECT count(*)::int FROM u
$$;
GRANT EXECUTE ON FUNCTION app.refresh_status(uuid, text) TO app_api, app_platform;

-- the memberships trigger now uses the same rule
CREATE OR REPLACE FUNCTION app.refresh_paid_through() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.refresh_status(COALESCE(NEW.org_id, OLD.org_id), COALESCE(NEW.member_id, OLD.member_id));
  RETURN NULL;
END $$;

-- one membership term per paid dues year (plan from the member; a lifetime plan has no end); idempotent
CREATE OR REPLACE FUNCTION app.backfill_memberships(o uuid) RETURNS integer LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO app.memberships (org_id, member_id, plan_id, starts_on, ends_on, price_cents, how, created_by)
    SELECT p.org_id, p.member_id, mp.id, make_date(p.year, 1, 1), CASE WHEN mp.term = 'lifetime' THEN NULL ELSE make_date(p.year, 12, 31) END,
           sum(p.amount_cents)::int, 'paid', 'backfill'
    FROM app.payments p
    JOIN app.members m ON m.org_id = p.org_id AND m.id = p.member_id
    JOIN app.membership_plans mp ON mp.org_id = m.org_id AND mp.id = m.plan
    WHERE p.org_id = o AND p.status = 'paid'
      AND NOT EXISTS (SELECT 1 FROM app.memberships x WHERE x.org_id = p.org_id AND x.member_id = p.member_id AND x.starts_on = make_date(p.year, 1, 1))
    GROUP BY p.org_id, p.member_id, mp.id, mp.term, p.year
    RETURNING 1)
  SELECT count(*)::int FROM ins
$$;
GRANT EXECUTE ON FUNCTION app.backfill_memberships(uuid) TO app_api, app_platform;

-- the organization's member-id pattern (HOU-204781): prefix most used so far, next number above the highest
CREATE OR REPLACE FUNCTION app.next_member_id(o uuid, fallback_prefix text) RETURNS text LANGUAGE sql AS $$
  WITH p AS (SELECT coalesce((SELECT split_part(id, '-', 1) FROM app.members WHERE org_id = o AND id ~ '^[A-Z]{2,5}-[0-9]{4,8}$' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1), fallback_prefix) AS prefix),
       n AS (SELECT coalesce(max(substring(id from '[0-9]+$')::bigint), 100000) + 1 AS next FROM app.members, p WHERE org_id = o AND id LIKE p.prefix || '-%' AND id ~ '-[0-9]+$')
  SELECT p.prefix || '-' || lpad(n.next::text, 6, '0') FROM p, n
$$;
GRANT EXECUTE ON FUNCTION app.next_member_id(uuid, text) TO app_api, app_platform;
