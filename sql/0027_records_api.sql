-- 0027 Meetings and minutes, benefit uses – the admin's screens through the API (C4g). Re-runnable.
-- meetings: the whole meeting as the admin edits it (web/src/lib/community/minutes.ts MeetingSchema) beside the columns
ALTER TABLE app.meetings ADD COLUMN IF NOT EXISTS spec jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app.meetings ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT '';
ALTER TABLE app.meetings ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- benefit uses as the admin records them (an offer is an id in the benefits document; no row per offer needed)
CREATE TABLE IF NOT EXISTS app.benefit_redemptions (
  org_id     uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id         text NOT NULL,                                   -- R-5001…
  offer_id   text NOT NULL,
  member_id  text NOT NULL,
  center     text NOT NULL DEFAULT '',
  via        text NOT NULL CHECK (via IN ('portal', 'partner', 'office')),
  at         timestamptz NOT NULL DEFAULT now(),
  by_name    text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, member_id) REFERENCES app.members(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS benefit_redemptions_offer ON app.benefit_redemptions (org_id, offer_id, at DESC);
SELECT app.tenant_table('app.benefit_redemptions');
