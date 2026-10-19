-- 0022 Jobs and providers (B5a). The outbox is drained by the worker through the email / text provider the platform
-- is configured with (EMAIL_PROVIDER / SMS_PROVIDER); provider webhooks report delivery, bounces and STOP replies.
ALTER TABLE platform.outbox ADD COLUMN IF NOT EXISTS attempts smallint NOT NULL DEFAULT 0;
ALTER TABLE platform.outbox ADD COLUMN IF NOT EXISTS ref text NOT NULL DEFAULT '';                 -- msg:<message id> for bulk sends
ALTER TABLE platform.outbox ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE platform.outbox ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'suppressed'));
CREATE INDEX IF NOT EXISTS outbox_ref ON platform.outbox (provider_ref) WHERE provider_ref <> '';
-- system emails already sent to a member for a date (renewal reminders never go twice)
CREATE TABLE IF NOT EXISTS app.sent_notices (
  org_id     uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  member_id  text NOT NULL,
  key        text NOT NULL,
  for_date   date NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, member_id, key, for_date)
);
SELECT app.tenant_table('app.sent_notices');
-- daily jobs run once per organization per local date
CREATE TABLE IF NOT EXISTS platform.job_runs (
  org_id    uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  kind      text NOT NULL,
  run_date  date NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  done_at   timestamptz,
  result    jsonb NOT NULL DEFAULT '{}'::jsonb,
  error     text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, kind, run_date)
);
SELECT app.platform_table('platform.job_runs');
-- every webhook call, once (providers retry; the event id makes it idempotent)
CREATE TABLE IF NOT EXISTS platform.webhook_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  kind         text NOT NULL DEFAULT '',
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
SELECT app.platform_table('platform.webhook_events');
