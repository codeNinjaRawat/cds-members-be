-- 0012 Help desk and Team tasks (rebuilt 2026-10-18). Contract: BE/memory/api-contract-tickets.md; rules in
-- web/src/lib/community/work.ts (the `work-settings` document holds categories, targets, saved replies, templates).
-- The 0001 tables app.tickets / app.ticket_updates belong to the first version and stay until the API moves over;
-- the new help desk uses app.hd_* so nothing breaks in between.

CREATE TABLE IF NOT EXISTS app.hd_tickets (
  org_id             uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id                 text NOT NULL CHECK (id ~ '^T-[0-9]{3,9}$'),
  subject            text NOT NULL CHECK (length(subject) BETWEEN 3 AND 140),
  category_id        text NOT NULL,
  channel            text NOT NULL CHECK (channel IN ('website', 'portal', 'email', 'phone', 'walk-in', 'staff')),
  requester_name     text NOT NULL DEFAULT '',
  requester_email    citext NOT NULL DEFAULT '',
  requester_phone    text NOT NULL DEFAULT '',
  member_id          text,
  center_id          uuid,
  assignee           text,                                    -- app.admins.id
  watchers           text[] NOT NULL DEFAULT '{}',
  tags               text[] NOT NULL DEFAULT '{}',
  priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status             text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'open', 'waiting', 'hold', 'solved', 'closed')),
  restricted         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL DEFAULT '',
  first_response_at  timestamptz,
  solved_at          timestamptz,
  closed_at          timestamptz,
  escalated_at       timestamptz,
  merged_into        text,
  csat_score         text CHECK (csat_score IN ('good', 'bad')),
  csat_comment       text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id),
  FOREIGN KEY (org_id, merged_into) REFERENCES app.hd_tickets(org_id, id)
);
CREATE INDEX IF NOT EXISTS hd_open ON app.hd_tickets (org_id, status, priority, created_at) WHERE status NOT IN ('solved', 'closed');
CREATE INDEX IF NOT EXISTS hd_assignee ON app.hd_tickets (org_id, assignee) WHERE status NOT IN ('solved', 'closed');
CREATE INDEX IF NOT EXISTS hd_requester ON app.hd_tickets (org_id, requester_email);
CREATE INDEX IF NOT EXISTS hd_member ON app.hd_tickets (org_id, member_id);
CREATE INDEX IF NOT EXISTS hd_search ON app.hd_tickets USING gin (subject gin_trgm_ops);
SELECT app.tenant_table('app.hd_tickets');
-- the thread: one append-only row per thing that happened (replies are also sent through Communication; notes never leave)
CREATE TABLE IF NOT EXISTS app.hd_events (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL,
  ticket_id   text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  by          text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('created', 'reply', 'requester', 'note', 'status', 'assign', 'priority', 'category', 'merge', 'link', 'csat', 'escalated', 'watch', 'tag')),
  text        text NOT NULL DEFAULT '',
  status      text,
  to_admin    text,
  mentions    text[] NOT NULL DEFAULT '{}',
  message_id  uuid,                                           -- app.messages row for a reply that went out
  FOREIGN KEY (org_id, ticket_id) REFERENCES app.hd_tickets(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hd_events_ticket ON app.hd_events (org_id, ticket_id, at);
SELECT app.tenant_table('app.hd_events', true);
CREATE TABLE IF NOT EXISTS app.hd_links (
  org_id     uuid NOT NULL,
  ticket_id  text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('member', 'event', 'donation', 'task', 'ticket')),
  ref_id     text NOT NULL,
  label      text NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, ticket_id, kind, ref_id),
  FOREIGN KEY (org_id, ticket_id) REFERENCES app.hd_tickets(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.hd_links');
-- solved tickets close by themselves after N days (nightly job; N from work-settings)
CREATE OR REPLACE FUNCTION app.hd_auto_close(days integer) RETURNS integer LANGUAGE sql AS $$
  WITH c AS (UPDATE app.hd_tickets SET status = 'closed', closed_at = now()
             WHERE org_id = app.current_org() AND status = 'solved' AND days > 0 AND solved_at <= now() - make_interval(days => days) RETURNING org_id, id)
  , e AS (INSERT INTO app.hd_events (org_id, ticket_id, by, kind, text, status) SELECT org_id, id, 'System', 'status', format('Closed automatically after %s days.', days), 'closed' FROM c RETURNING 1)
  SELECT count(*)::int FROM e
$$;
GRANT EXECUTE ON FUNCTION app.hd_auto_close(integer) TO app_api, app_platform;

-- team tasks ------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.task_projects (
  org_id       uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id           text NOT NULL,
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  color        text NOT NULL DEFAULT 'green' CHECK (color IN ('green', 'blue', 'amber', 'red', 'violet', 'gray')),
  owner        text NOT NULL,
  center_id    uuid,
  visibility   text NOT NULL DEFAULT 'organization' CHECK (visibility IN ('members', 'masjid', 'organization')),
  members      text[] NOT NULL DEFAULT '{}',
  due          date,
  anchor       date,
  template_id  text NOT NULL DEFAULT '',
  description  text NOT NULL DEFAULT '',
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, center_id) REFERENCES app.centers(org_id, id),
  CHECK (visibility <> 'masjid' OR center_id IS NOT NULL)
);
SELECT app.tenant_table('app.task_projects');
CREATE TABLE IF NOT EXISTS app.tasks (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id          text NOT NULL,
  project_id  text,
  parent_id   text,
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  notes       text NOT NULL DEFAULT '',
  owner       text NOT NULL,
  helpers     text[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'waiting', 'done')),
  priority    text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  start_on    date,
  due         date,
  labels      text[] NOT NULL DEFAULT '{}',
  checklist   jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{ id, text, done }]
  repeat_every text CHECK (repeat_every IN ('week', 'month', 'year')),
  repeat_interval smallint CHECK (repeat_interval BETWEEN 1 AND 12),
  links       jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{ kind, id, label }]
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL DEFAULT '',
  done_at     timestamptz,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, project_id) REFERENCES app.task_projects(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, parent_id) REFERENCES app.tasks(org_id, id) ON DELETE CASCADE,
  CHECK ((repeat_every IS NULL) = (repeat_interval IS NULL)),
  CHECK ((status = 'done') = (done_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS tasks_mine ON app.tasks (org_id, owner, status, due);
CREATE INDEX IF NOT EXISTS tasks_project ON app.tasks (org_id, project_id, status, sort);
SELECT app.tenant_table('app.tasks');
CREATE TABLE IF NOT EXISTS app.task_comments (
  id        bigserial PRIMARY KEY,
  org_id    uuid NOT NULL,
  task_id   text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  by        text NOT NULL,
  text      text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  FOREIGN KEY (org_id, task_id) REFERENCES app.tasks(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS task_comments_task ON app.task_comments (org_id, task_id, at);
SELECT app.tenant_table('app.task_comments', true);
