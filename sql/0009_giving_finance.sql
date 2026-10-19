-- 0009 Giving, fundraising and finance. Shapes: web/src/lib/community/donations.ts (funds, platforms, Check-o-matic),
-- fundraising.ts (campaigns, personal pages, pledges, matching), finance.ts (ledger, approvals, budgets, statements),
-- admin/src/lib/integrations (giving platform accounts: Stripe, PayPal, Zeffy, Medina kiosk – per organization or masjid).
-- Money is always integer cents. Bank account numbers: last 4 digits only.

-- funds (projection of donation-settings.funds; the document stays the source) ------------------------------------------
CREATE TABLE IF NOT EXISTS app.funds (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          text NOT NULL CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'zakat', 'sadaqah', 'building', 'restricted', 'dues')),
  center_id   uuid,                                        -- a masjid's own fund
  active      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_zakat_fund ON app.funds (org_id) WHERE kind = 'zakat' AND active;
SELECT app.tenant_table('app.funds');

-- giving platform accounts (secrets stay in the secrets manager – only the last 4 here) ----------------------------------
CREATE TABLE IF NOT EXISTS app.giving_accounts (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          text NOT NULL,
  provider    text NOT NULL CHECK (provider IN ('stripe', 'paypal', 'zeffy', 'medina', 'bloomerang', 'other')),
  scope       text NOT NULL DEFAULT 'organization' CHECK (scope IN ('organization', 'center')),
  center_id   uuid,
  form_url    text NOT NULL DEFAULT '',
  key_last4   text NOT NULL DEFAULT '',
  secret_ref  text NOT NULL DEFAULT '',                    -- name in the secrets manager
  last_sync   timestamptz,
  active      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, id),
  CHECK (scope = 'organization' OR center_id IS NOT NULL)
);
SELECT app.tenant_table('app.giving_accounts');

-- donors who are not members (members give as themselves) -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.donors (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  member_id   text,
  name        text NOT NULL,
  email       citext NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  street      text NOT NULL DEFAULT '',
  city        text NOT NULL DEFAULT '',
  state       text NOT NULL DEFAULT '',
  zip         text NOT NULL DEFAULT '',
  external    jsonb NOT NULL DEFAULT '{}'::jsonb,           -- { zeffy: "c_123" }
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS donors_email ON app.donors (org_id, email);
CREATE INDEX IF NOT EXISTS donors_member ON app.donors (org_id, member_id);
SELECT app.tenant_table('app.donors');

-- campaigns and personal fundraising pages ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.campaigns (
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id            text NOT NULL CHECK (id ~ '^[a-z0-9-]{2,60}$'),
  name          text NOT NULL,
  fund_id       text NOT NULL,
  center_id     uuid,
  goal_cents    bigint NOT NULL CHECK (goal_cents > 0),
  starts_on     date NOT NULL,
  ends_on       date,
  matching      jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{ sponsor, capCents, ratio, from, to }]
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'ended', 'archived')),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, fund_id) REFERENCES app.funds(org_id, id)
);
SELECT app.tenant_table('app.campaigns');
CREATE TABLE IF NOT EXISTS app.campaign_pages (
  org_id        uuid NOT NULL,
  id            text NOT NULL,
  campaign_id   text NOT NULL,
  member_id     text NOT NULL,
  title         text NOT NULL,
  story         text NOT NULL DEFAULT '',
  goal_cents    bigint NOT NULL CHECK (goal_cents > 0),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'hidden')),
  decided_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, campaign_id) REFERENCES app.campaigns(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.campaign_pages');

-- gifts --------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.donations (
  org_id          uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id              text NOT NULL,                              -- D-10001
  donor_id        uuid,
  member_id       text,
  anonymous       boolean NOT NULL DEFAULT false,
  fund_id         text,                                        -- null = "needs a fund"
  center_id       uuid,
  campaign_id     text,
  page_id         text,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents       bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  given_on        date NOT NULL,
  method          text NOT NULL CHECK (method IN ('card', 'ach', 'cash', 'check', 'kiosk', 'paypal', 'zeffy', 'stock', 'other')),
  check_no        text NOT NULL DEFAULT '',
  platform        text NOT NULL DEFAULT 'office',              -- office | stripe | paypal | zeffy | medina …
  account_id      text,
  platform_ref    text NOT NULL DEFAULT '',
  payout_id       text NOT NULL DEFAULT '',
  recurring_id    uuid,
  state           text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'needs-fund-or-donor', 'awaiting-payout', 'refunded', 'disputed')),
  receipt_no      text NOT NULL DEFAULT '',
  receipt_sent_at timestamptz,
  note            text NOT NULL DEFAULT '',
  entered_by      text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, donor_id) REFERENCES app.donors(org_id, id),
  FOREIGN KEY (org_id, fund_id) REFERENCES app.funds(org_id, id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id),
  CHECK (method <> 'check' OR check_no <> '' OR platform <> 'office')
);
CREATE UNIQUE INDEX IF NOT EXISTS donations_platform_ref ON app.donations (org_id, platform, platform_ref) WHERE platform_ref <> '';
CREATE INDEX IF NOT EXISTS donations_given ON app.donations (org_id, given_on DESC);
CREATE INDEX IF NOT EXISTS donations_member ON app.donations (org_id, member_id, given_on);
CREATE INDEX IF NOT EXISTS donations_fund ON app.donations (org_id, fund_id, given_on);
CREATE INDEX IF NOT EXISTS donations_open ON app.donations (org_id, state) WHERE state <> 'ok';
SELECT app.tenant_table('app.donations');

-- recurring gifts (Check-o-matic: monthly gifts that can count as dues) --------------------------------------------------
CREATE TABLE IF NOT EXISTS app.recurring_gifts (
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  donor_id      uuid,
  member_id     text,
  fund_id       text NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  every         text NOT NULL DEFAULT 'month' CHECK (every IN ('week', 'month', 'year')),
  day_of_month  smallint CHECK (day_of_month BETWEEN 1 AND 28),
  platform      text NOT NULL,
  platform_ref  text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'card-expired', 'cancelled')),
  started_on    date NOT NULL,
  ended_on      date,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, fund_id) REFERENCES app.funds(org_id, id)
);
CREATE INDEX IF NOT EXISTS recurring_member ON app.recurring_gifts (org_id, member_id) WHERE status = 'active';
SELECT app.tenant_table('app.recurring_gifts');

CREATE TABLE IF NOT EXISTS app.pledges (
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  campaign_id   text NOT NULL,
  donor_id      uuid,
  member_id     text,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  due_on        date,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, campaign_id) REFERENCES app.campaigns(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.pledges');

-- payouts from platforms (reconciliation) ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.payouts (
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id            text NOT NULL,                               -- platform payout id
  platform      text NOT NULL,
  account_id    text,
  amount_cents  bigint NOT NULL,
  fee_cents     bigint NOT NULL DEFAULT 0,
  arrived_on    date,
  bank_last4    text NOT NULL DEFAULT '' CHECK (bank_last4 ~ '^[0-9]{0,4}$'),
  matched       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, platform, id)
);
SELECT app.tenant_table('app.payouts');

-- yearly giving per member: Check-o-matic qualification and the "lifetime by donation" rule read this ---------------
CREATE OR REPLACE VIEW app.giving_by_member_year WITH (security_invoker = true) AS
  SELECT d.org_id, d.member_id, extract(year FROM d.given_on)::int AS year,
         sum(d.amount_cents) AS total_cents,
         sum(d.amount_cents) FILTER (WHERE d.recurring_id IS NOT NULL) AS recurring_cents,
         count(*) AS gifts
  FROM app.donations d WHERE d.member_id IS NOT NULL AND d.state <> 'refunded'
  GROUP BY d.org_id, d.member_id, extract(year FROM d.given_on);
GRANT SELECT ON app.giving_by_member_year TO app_api, app_platform;

-- finance: ledger with approvals, budgets, quarterly statements ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.finance_accounts (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          text NOT NULL,
  name        text NOT NULL,                                -- Operating – Chase
  center_id   uuid,
  bank_last4  text NOT NULL DEFAULT '' CHECK (bank_last4 ~ '^[0-9]{0,4}$'),
  active      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, id)
);
SELECT app.tenant_table('app.finance_accounts');
CREATE TABLE IF NOT EXISTS app.ledger (
  org_id          uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id              text NOT NULL,                             -- TX-2026-0001
  kind            text NOT NULL CHECK (kind IN ('income', 'expense', 'transfer', 'aid')),
  fund_id         text,
  to_fund_id      text,                                      -- transfers
  account_id      text,
  center_id       uuid,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  on_date         date NOT NULL,
  payee           text NOT NULL DEFAULT '',
  memo            text NOT NULL DEFAULT '',
  category        text NOT NULL DEFAULT '',
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'donations', 'zakat', 'dues', 'events', 'import')),
  source_ref      text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'rejected', 'void')),
  approvals       jsonb NOT NULL DEFAULT '[]'::jsonb,         -- [{ by, at, level }] – two signatures above the rule's limit
  board_decision  text NOT NULL DEFAULT '',                   -- meeting id (Bylaws Art. XII large spends)
  created_by      text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, fund_id) REFERENCES app.funds(org_id, id),
  CHECK (kind <> 'transfer' OR (to_fund_id IS NOT NULL AND to_fund_id IS DISTINCT FROM fund_id))
);
CREATE INDEX IF NOT EXISTS ledger_date ON app.ledger (org_id, on_date DESC);
CREATE INDEX IF NOT EXISTS ledger_pending ON app.ledger (org_id, status) WHERE status = 'pending';
SELECT app.tenant_table('app.ledger');
CREATE TABLE IF NOT EXISTS app.budgets (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  year        integer NOT NULL,
  center_id   uuid,
  category    text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (org_id, id),
  UNIQUE NULLS NOT DISTINCT (org_id, year, center_id, category)
);
SELECT app.tenant_table('app.budgets');
CREATE TABLE IF NOT EXISTS app.statements (
  org_id       uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  center_id    uuid NOT NULL,
  period      text NOT NULL,                                 -- 2026-Q3
  income_cents bigint NOT NULL DEFAULT 0,
  expense_cents bigint NOT NULL DEFAULT 0,
  file_ref     text NOT NULL DEFAULT '',
  received_on  date NOT NULL DEFAULT current_date,
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, center_id, period)
);
SELECT app.tenant_table('app.statements');
