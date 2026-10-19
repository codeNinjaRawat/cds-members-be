-- 0019 Zakat API (B4d). The case as the rules see it (web/src/lib/community/zakat.ts) is kept in `spec`; the columns
-- beside it are what the queue sorts and filters on. Every step still goes to app.zakat_steps (append-only), whose
-- trigger refuses a second approval by the same person and a payout by anyone who approved.

ALTER TABLE app.zakat_cases ADD COLUMN IF NOT EXISTS spec jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app.zakat_cases ADD COLUMN IF NOT EXISTS coordinator text NOT NULL DEFAULT '';
ALTER TABLE app.zakat_cases ADD COLUMN IF NOT EXISTS consent_at timestamptz;
ALTER TABLE app.zakat_cases DROP CONSTRAINT IF EXISTS zakat_cases_status_check;
ALTER TABLE app.zakat_cases ADD CONSTRAINT zakat_cases_status_check CHECK (status IN ('new', 'verifying', 'info-requested', 'awaiting-approval', 'approved', 'paid', 'rejected', 'closed'));
ALTER TABLE app.zakat_cases DROP CONSTRAINT IF EXISTS zakat_cases_channel_check;
ALTER TABLE app.zakat_cases ADD CONSTRAINT zakat_cases_channel_check CHECK (channel IN ('website', 'app', 'in-person', 'phone', 'referral'));
ALTER TABLE app.zakat_cases DROP CONSTRAINT IF EXISTS zakat_cases_months_check;
ALTER TABLE app.zakat_cases ADD CONSTRAINT zakat_cases_months_check CHECK (months BETWEEN 1 AND 12);
ALTER TABLE app.zakat_payouts DROP CONSTRAINT IF EXISTS zakat_payouts_method_check;
ALTER TABLE app.zakat_payouts ADD CONSTRAINT zakat_payouts_method_check CHECK (method IN ('transfer', 'check', 'cash', 'bank-transfer', 'paid-to-landlord', 'paid-to-utility'));
ALTER TABLE app.zakat_payouts ADD COLUMN IF NOT EXISTS paid_by_id text NOT NULL DEFAULT '';
-- a payout row is never changed or removed (a mistake is corrected by the Treasurer in the ledger)
CREATE OR REPLACE FUNCTION app.zakat_payout_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'zakat payouts are append-only'; END $$;
DROP TRIGGER IF EXISTS lock ON app.zakat_payouts;
CREATE TRIGGER lock BEFORE UPDATE OR DELETE ON app.zakat_payouts FOR EACH ROW WHEN (current_user <> 'postgres') EXECUTE FUNCTION app.zakat_payout_lock();
