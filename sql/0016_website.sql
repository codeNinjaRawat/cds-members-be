-- 0016 B3 Website: join applications pay, renewals, offline payments that clear later.
-- Payment states follow web/src/lib/community/payments.ts (PAYMENT_MOVES): pending, check_pending, paid, failed,
-- bounced, refunded, partially_refunded, void (+ disputed from card networks). Only paid / partially refunded count.
ALTER TABLE app.payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE app.payments ADD CONSTRAINT payments_status_check CHECK (status IN ('pending', 'check_pending', 'paid', 'failed', 'bounced', 'refunded', 'partially_refunded', 'void', 'disputed'));
ALTER TABLE app.payments
  ADD COLUMN IF NOT EXISTS application_id text,
  ADD COLUMN IF NOT EXISTS kind           text NOT NULL DEFAULT 'dues' CHECK (kind IN ('dues', 'event', 'donation')),
  ADD COLUMN IF NOT EXISTS lines          jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS checkout_ref   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS payments_open ON app.payments (org_id, status) WHERE status IN ('pending', 'check_pending', 'failed', 'bounced');
CREATE INDEX IF NOT EXISTS payments_application ON app.payments (org_id, application_id) WHERE application_id IS NOT NULL;
-- memberships come only from paid dues (backfill already filters status = 'paid'; partially refunded still counts)
CREATE OR REPLACE FUNCTION app.backfill_memberships(o uuid) RETURNS integer LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO app.memberships (org_id, member_id, plan_id, starts_on, ends_on, price_cents, how, created_by)
    SELECT p.org_id, p.member_id, mp.id, make_date(p.year, 1, 1), CASE WHEN mp.term = 'lifetime' THEN NULL ELSE make_date(p.year, 12, 31) END,
           sum(p.amount_cents)::int, 'paid', 'backfill'
    FROM app.payments p
    JOIN app.members m ON m.org_id = p.org_id AND m.id = p.member_id
    JOIN app.membership_plans mp ON mp.org_id = m.org_id AND mp.id = m.plan
    WHERE p.org_id = o AND p.kind = 'dues' AND p.status IN ('paid', 'partially_refunded')
      AND NOT EXISTS (SELECT 1 FROM app.memberships x WHERE x.org_id = p.org_id AND x.member_id = p.member_id AND x.starts_on = make_date(p.year, 1, 1))
    GROUP BY p.org_id, p.member_id, mp.id, mp.term, p.year
    RETURNING 1)
  SELECT count(*)::int FROM ins
$$;
-- a refunded or bounced dues payment takes its membership term away again
CREATE OR REPLACE FUNCTION app.revoke_unpaid_terms(o uuid, m text) RETURNS integer LANGUAGE sql AS $$
  WITH d AS (UPDATE app.memberships ms SET status = 'refunded' WHERE ms.org_id = o AND ms.member_id = m AND ms.status = 'active' AND ms.how = 'paid'
      AND NOT EXISTS (SELECT 1 FROM app.payments p WHERE p.org_id = o AND p.member_id = m AND p.kind = 'dues' AND p.status IN ('paid', 'partially_refunded') AND make_date(p.year, 1, 1) = ms.starts_on) RETURNING 1)
  SELECT count(*)::int FROM d
$$;
GRANT EXECUTE ON FUNCTION app.revoke_unpaid_terms(uuid, text) TO app_api, app_platform;
