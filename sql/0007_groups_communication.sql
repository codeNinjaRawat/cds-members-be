-- 0007 Groups and Communication. Shapes: web/src/lib/community/groups.ts, communication.ts, campaigns.ts.
-- Group rules and templates stay in their documents (`groups`, `communication`); these tables hold the people and the
-- messages that actually went out.

-- groups: manual groups keep their members here; automatic groups are computed from rules (cached for big sends) ------
CREATE TABLE IF NOT EXISTS app.groups (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          text NOT NULL CHECK (id ~ '^[a-z0-9-]{2,60}$'),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('manual', 'automatic')),
  center_id   uuid,                                       -- a masjid's own group ('' = organization)
  rules       jsonb NOT NULL DEFAULT '{}'::jsonb,         -- { match: all|any, rules: [...] } for automatic groups
  who_can_join text NOT NULL DEFAULT 'staff' CHECK (who_can_join IN ('staff', 'ask', 'anyone')),
  archived    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, id)
);
SELECT app.tenant_table('app.groups');
CREATE TABLE IF NOT EXISTS app.group_members (
  org_id     uuid NOT NULL,
  group_id   text NOT NULL,
  member_id  text NOT NULL,
  how        text NOT NULL DEFAULT 'added' CHECK (how IN ('added', 'joined', 'asked', 'rule', 'always')),
  status     text NOT NULL DEFAULT 'in' CHECK (status IN ('in', 'asked', 'never')),     -- never = excluded from an automatic group
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, group_id, member_id),
  FOREIGN KEY (org_id, group_id) REFERENCES app.groups(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, member_id) REFERENCES app.members(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS group_members_member ON app.group_members (org_id, member_id);
SELECT app.tenant_table('app.group_members');

-- email / text preferences (member portal › Email preferences) ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.contact_prefs (
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  address       citext NOT NULL,                          -- email or phone (works for non-members too)
  channel       text NOT NULL CHECK (channel IN ('email', 'sms')),
  member_id     text,
  topics        text[] NOT NULL DEFAULT '{}',              -- newsletter, events, renewals, giving …
  unsubscribed  boolean NOT NULL DEFAULT false,            -- everything except required notices
  bounced       boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, channel, address)
);
SELECT app.tenant_table('app.contact_prefs');

-- messages: one row per bulk send or automatic email kind; deliveries: one row per person -----------------------------
CREATE TABLE IF NOT EXISTS app.messages (
  org_id        uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('bulk', 'system', 'event', 'renewal', 'receipt', 'ticket-reply')),
  channel       text NOT NULL CHECK (channel IN ('email', 'sms')),
  template_id   text NOT NULL DEFAULT '',
  subject       text NOT NULL DEFAULT '',
  body          text NOT NULL,
  audience      jsonb NOT NULL DEFAULT '{}'::jsonb,       -- { groups: [], centers: [], filters } as chosen
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  scheduled_for timestamptz,
  sent_at       timestamptz,
  created_by    text NOT NULL DEFAULT '',
  approved_by   text NOT NULL DEFAULT '',
  recipients    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS messages_status ON app.messages (org_id, status, scheduled_for);
SELECT app.tenant_table('app.messages');
CREATE TABLE IF NOT EXISTS app.deliveries (
  org_id        uuid NOT NULL,
  id            bigserial,
  message_id    uuid NOT NULL,
  member_id     text,
  address       citext NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'failed', 'skipped')),
  skip_reason   text NOT NULL DEFAULT '',                 -- unsubscribed, no consent, quiet hours …
  provider_ref  text NOT NULL DEFAULT '',
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, message_id) REFERENCES app.messages(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS deliveries_message ON app.deliveries (org_id, message_id, status);
CREATE INDEX IF NOT EXISTS deliveries_member ON app.deliveries (org_id, member_id, at DESC);
CREATE INDEX IF NOT EXISTS deliveries_provider ON app.deliveries (provider_ref) WHERE provider_ref <> '';
SELECT app.tenant_table('app.deliveries');

-- in-app notices for admins (mentions, escalations, approvals waiting) ---------------------------------------------------
CREATE TABLE IF NOT EXISTS app.notices (
  org_id     uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id         bigserial,
  admin_id   text NOT NULL,
  kind       text NOT NULL,                               -- mention | escalation | approval | assignment
  title      text NOT NULL,
  link       text NOT NULL DEFAULT '',
  at         timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS notices_unread ON app.notices (org_id, admin_id) WHERE read_at IS NULL;
SELECT app.tenant_table('app.notices');
