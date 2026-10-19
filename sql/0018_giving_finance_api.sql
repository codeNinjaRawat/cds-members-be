-- 0018 Giving, fundraising and finance API (B4c). Rules: web/src/lib/community/donations.ts, fundraising.ts, finance.ts.
-- Donations keep the donor as given (name / email) besides the optional donor row; campaigns and personal pages come
-- from the `fundraising` document (projection); the ledger follows `finance-settings` (its own fund list, so no
-- foreign key to the donation funds).

-- donations ---------------------------------------------------------------------------------------------------------
ALTER TABLE app.donations ADD COLUMN IF NOT EXISTS donor_name text NOT NULL DEFAULT '';
ALTER TABLE app.donations ADD COLUMN IF NOT EXISTS donor_email citext NOT NULL DEFAULT '';
ALTER TABLE app.donations ADD COLUMN IF NOT EXISTS show_name boolean NOT NULL DEFAULT true;      -- donor wall (first name only)
ALTER TABLE app.donations ADD COLUMN IF NOT EXISTS monthly boolean NOT NULL DEFAULT false;
ALTER TABLE app.donations ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'online' CHECK (source IN ('online', 'office', 'pledge'));
ALTER TABLE app.donations ADD COLUMN IF NOT EXISTS pledge_id uuid;
ALTER TABLE app.donations ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE app.donations ADD COLUMN IF NOT EXISTS refund_reason text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS donations_campaign ON app.donations (org_id, campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS donations_email ON app.donations (org_id, donor_email);

-- campaigns (projection of `fundraising`) ------------------------------------------------------------------------------
ALTER TABLE app.campaigns ADD COLUMN IF NOT EXISTS spec jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app.campaign_pages ALTER COLUMN member_id SET DEFAULT '';
ALTER TABLE app.campaign_pages ADD COLUMN IF NOT EXISTS owner_name text NOT NULL DEFAULT '';

-- pledges: the donor as written; the same key gifts use (member id, else email, else name) --------------------------
ALTER TABLE app.pledges ADD COLUMN IF NOT EXISTS donor_name text NOT NULL DEFAULT '';
ALTER TABLE app.pledges ADD COLUMN IF NOT EXISTS donor_email citext NOT NULL DEFAULT '';
ALTER TABLE app.pledges ADD COLUMN IF NOT EXISTS donor_key text NOT NULL DEFAULT '';
ALTER TABLE app.pledges ADD COLUMN IF NOT EXISTS ref text NOT NULL DEFAULT '';                    -- P-1001
ALTER TABLE app.pledges ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT '';

-- payouts: which gifts a deposit holds ----------------------------------------------------------------------------------
ALTER TABLE app.payouts ADD COLUMN IF NOT EXISTS gifts integer NOT NULL DEFAULT 0;
ALTER TABLE app.payouts ADD COLUMN IF NOT EXISTS difference_cents bigint NOT NULL DEFAULT 0;

-- ledger ----------------------------------------------------------------------------------------------------------------
ALTER TABLE app.ledger DROP CONSTRAINT IF EXISTS ledger_org_id_fund_id_fkey;
ALTER TABLE app.ledger DROP CONSTRAINT IF EXISTS ledger_status_check;
ALTER TABLE app.ledger ADD CONSTRAINT ledger_status_check CHECK (status IN ('pending', 'approved', 'paid', 'received', 'rejected', 'void'));
ALTER TABLE app.ledger ADD COLUMN IF NOT EXISTS center_name text NOT NULL DEFAULT '';            -- '' = headquarters
ALTER TABLE app.ledger ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'ach' CHECK (method IN ('check', 'ach', 'card', 'cash', 'internal'));
ALTER TABLE app.ledger ADD COLUMN IF NOT EXISTS ref text NOT NULL DEFAULT '';
ALTER TABLE app.ledger ADD COLUMN IF NOT EXISTS relief boolean NOT NULL DEFAULT false;
ALTER TABLE app.ledger ADD COLUMN IF NOT EXISTS decided_note text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS ledger_source_ref ON app.ledger (org_id, source, source_ref) WHERE source_ref <> '';
-- a paid expense never changes again (void it and enter a new one)
CREATE OR REPLACE FUNCTION app.ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('paid', 'received', 'void', 'rejected') AND (NEW.amount_cents, NEW.fund_id, NEW.kind, NEW.on_date) IS DISTINCT FROM (OLD.amount_cents, OLD.fund_id, OLD.kind, OLD.on_date) THEN
    RAISE EXCEPTION 'ledger_closed';
  END IF;
  IF OLD.status = 'void' AND NEW.status <> 'void' THEN RAISE EXCEPTION 'ledger_closed'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard ON app.ledger;
CREATE TRIGGER guard BEFORE UPDATE ON app.ledger FOR EACH ROW EXECUTE FUNCTION app.ledger_guard();

ALTER TABLE app.statements ADD COLUMN IF NOT EXISTS submitted_by text NOT NULL DEFAULT '';
