-- 0029 Work-queue decisions and who took a case (the admin's Queues screen) – shared by everyone in the office. C5.
CREATE TABLE IF NOT EXISTS app.queue_state (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  case_id     text NOT NULL,                                   -- app-<member>, id-<member>, center-…, dup-…, pay-…
  decision    jsonb,                                           -- { state: done | ready | needs-info, outcome, note?, by, at }
  assignee    text NOT NULL DEFAULT '',                        -- the admin who took it ('' = nobody)
  updated_by  text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, case_id)
);
SELECT app.tenant_table('app.queue_state');
