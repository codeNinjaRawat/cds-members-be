-- 0010 Zakat and Sadaqah cases. Shapes: web/src/lib/community/zakat.ts (rules in the `zakat-settings` document).
-- Applicants are often not members – their data is sensitive: only roles with zakat.* see it, center-limited roles
-- only their masjids (enforced by the API with app.in_scope; RLS keeps organizations apart).

CREATE TABLE IF NOT EXISTS app.zakat_cases (
  org_id            uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id                text NOT NULL,                             -- ZKT-2026-041
  applicant_name    text NOT NULL,
  email             citext NOT NULL DEFAULT '',
  phone             text NOT NULL DEFAULT '',
  street            text NOT NULL DEFAULT '',
  city              text NOT NULL DEFAULT '',
  zip               text NOT NULL DEFAULT '',
  member_id         text,
  zone_id           uuid,
  center_id         uuid,
  household_size    smallint NOT NULL DEFAULT 1 CHECK (household_size BETWEEN 1 AND 30),
  monthly_income_cents bigint,
  need              text NOT NULL,                             -- rent, utilities, medical, food …
  story             text NOT NULL DEFAULT '',
  urgent            boolean NOT NULL DEFAULT false,
  requested_cents   bigint NOT NULL CHECK (requested_cents > 0),
  months            smallint NOT NULL DEFAULT 1 CHECK (months BETWEEN 1 AND 24),      -- monthly help
  channel           text NOT NULL DEFAULT 'website' CHECK (channel IN ('website', 'phone', 'walk-in', 'referral')),
  fund              text NOT NULL DEFAULT 'undecided' CHECK (fund IN ('undecided', 'zakat', 'sadaqah', 'none')),
  status            text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'verifying', 'info-requested', 'in-approval', 'approved', 'paying', 'paid', 'returned', 'rejected', 'closed')),
  level_needed      smallint NOT NULL DEFAULT 1 CHECK (level_needed BETWEEN 1 AND 3),
  approved_cents    bigint,
  home_visit        jsonb,                                       -- { on, by, notes }
  checks            jsonb NOT NULL DEFAULT '{}'::jsonb,          -- documents / income / hardship results
  due_at            timestamptz,                                 -- response-time target of the current step
  created_by        text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id)
);
CREATE INDEX IF NOT EXISTS zakat_queue ON app.zakat_cases (org_id, status, urgent DESC, due_at);
CREATE INDEX IF NOT EXISTS zakat_center ON app.zakat_cases (org_id, center_id, status);
SELECT app.tenant_table('app.zakat_cases');
DROP TRIGGER IF EXISTS touch ON app.zakat_cases;
CREATE TRIGGER touch BEFORE UPDATE ON app.zakat_cases FOR EACH ROW EXECUTE FUNCTION app.touch();

-- every step on a case (verify, decide, approve at a level, send back, reject, override) – append-only ---------------
CREATE TABLE IF NOT EXISTS app.zakat_steps (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL,
  case_id     text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  by          text NOT NULL,
  admin_id    text NOT NULL DEFAULT '',
  action      text NOT NULL CHECK (action IN ('intake', 'check', 'home-visit', 'decide', 'request-info', 'approve', 'override', 'return', 'reject', 'pay', 'close', 'note')),
  level       smallint,
  amount_cents bigint,
  note        text NOT NULL DEFAULT '',
  FOREIGN KEY (org_id, case_id) REFERENCES app.zakat_cases(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS zakat_steps_case ON app.zakat_steps (org_id, case_id, at);
SELECT app.tenant_table('app.zakat_steps', true);
-- one person approves a case once; whoever approved may not pay it out (the API checks too)
CREATE OR REPLACE FUNCTION app.check_zakat_step() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.action = 'approve' AND EXISTS (SELECT 1 FROM app.zakat_steps s WHERE s.org_id = NEW.org_id AND s.case_id = NEW.case_id AND s.action = 'approve' AND s.admin_id = NEW.admin_id AND NEW.admin_id <> ''
       AND s.id > COALESCE((SELECT max(id) FROM app.zakat_steps r WHERE r.org_id = NEW.org_id AND r.case_id = NEW.case_id AND r.action = 'return'), 0)) THEN
    RAISE EXCEPTION 'This person already approved this case';
  END IF;
  IF NEW.action = 'pay' AND NEW.admin_id <> '' AND EXISTS (SELECT 1 FROM app.zakat_steps s WHERE s.org_id = NEW.org_id AND s.case_id = NEW.case_id AND s.action IN ('approve', 'override') AND s.admin_id = NEW.admin_id) THEN
    RAISE EXCEPTION 'Whoever approved a case cannot pay it out';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS check_zakat_step ON app.zakat_steps;
CREATE TRIGGER check_zakat_step BEFORE INSERT ON app.zakat_steps FOR EACH ROW EXECUTE FUNCTION app.check_zakat_step();

CREATE TABLE IF NOT EXISTS app.zakat_payouts (
  org_id        uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  case_id       text NOT NULL,
  month_no      smallint NOT NULL DEFAULT 1,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  method        text NOT NULL CHECK (method IN ('bank-transfer', 'check', 'cash', 'paid-to-landlord', 'paid-to-utility')),
  ref           text NOT NULL DEFAULT '',
  paid_on       date NOT NULL DEFAULT current_date,
  paid_by       text NOT NULL,
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, case_id, month_no),
  FOREIGN KEY (org_id, case_id) REFERENCES app.zakat_cases(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.zakat_payouts');
