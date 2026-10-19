# API contract – Help desk (tickets) and Team tasks

Rewritten 2026-10-18 (owner: "I have not seen any good thing about ticketing and internal task"). Research:
`admin/memory/research/tickets-and-tasks.md`. Shared rules (zod + pure functions, also used by the BE):
`web/src/lib/community/work.ts` (synced to admin). Admin UI: `HelpDeskView.tsx`, `TasksView.tsx`, `WorkSettingsView.tsx`,
`MyWorkCard.tsx`; demo storage `admin/src/lib/work/work-store.ts`. White-box: `admin/tests/wb/work.test.ts` (14).

## Settings document `work-settings` (WorkSettingsSchema)
- `GET/PUT /admin/work-settings` – publish needs `settings.manage`. Other organizations start from `SIMPLE_WORK_PRESET`.
- `GET /public/helpdesk` → `publicHelpdesk(doc)` only (categories people may pick; never owners, roles, saved replies).
- helpdesk: enabled, clock business|calendar, hours {days, start, end}, targets per priority {firstResponseHours,
  solveHours}, dueSoonPercent, autoCloseDays, satisfaction, acknowledgement, websiteForms, seniorRoles[], categories[]
  {id, label, description, defaultPriority, owner {kind none|admin|role, id}, onWebsite, restricted, escalateTo, archived},
  savedReplies[] {id, title, body (merge fields), categoryId}.
- tasks: enabled, statusLabels {todo, doing, waiting, done}, labels[], templates[] {id, name, anchorLabel, tasks[]
  {title, offsetDays, priority, checklist[], roleId}}.

## Tables (shared schema + RLS by org_id)
- `tickets` (org_id, id `T-1041`, subject, category_id, channel website|portal|email|phone|walk-in|staff, requester
  name/email/phone/member_id, center, assignee, watchers[], tags[], priority urgent|high|normal|low, status
  new|open|waiting|hold|solved|closed, restricted, created_at, created_by, first_response_at, solved_at, closed_at,
  merged_into, csat_score, csat_comment).
- `ticket_events` – append-only thread: kind created|reply|requester|note|status|assign|priority|category|merge|link|
  csat|escalated, text, status, to, mentions[], at, by. Replies are also sent (Communication module); notes never leave.
- `ticket_links` (ticket_id, kind member|event|donation|task|ticket, ref_id, label).
- `task_projects` (org_id, id, name, color, owner, center, visibility members|masjid|organization, members[], due,
  anchor, template_id, archived, description). `tasks` (org_id, id, project_id, parent_id, title, notes, owner,
  helpers[], status, priority, start, due, labels[], checklist jsonb, repeat {every, interval}, links jsonb, created_*,
  done_at, sort). `task_comments` (task_id, at, by, text).

## Endpoints
- `GET /admin/tickets?view=&category=&center=&q=` – filtered by `canSeeTicket` (masjid scope; restricted → owner,
  creator, watchers, `seniorRoles`). Clocks from `ticketClocks` (business hours, paused while waiting).
- `POST /admin/tickets` – phone / walk-in / email / staff; owner from `routeOwner(category, center, admins)` unless given.
- `PATCH /admin/tickets/:id` – status, owner, priority, category, center, tags, watchers, restricted (each an event).
- `POST /admin/tickets/:id/replies` (sends to the requester; first reply sets first_response_at; optional status after)
  · `POST /admin/tickets/:id/notes` (mentions → watchers + in-app notice) · `POST /admin/tickets/:id/merge {into}` ·
  `POST /admin/tickets/bulk {ids, assignee?|status?|priority?|mergeInto?}` · `POST /admin/tickets/:id/task` (→ task + link).
- `POST /public/tickets` (website, honeypot + rate limit + optional captcha) and `POST /member/tickets` (session; member
  id, masjid and email added server-side) – body `PublicTicketSchema`. Category must be onWebsite and not archived.
  The web app proxies this at `POST /api/tickets`. `GET /member/tickets` → `memberView(t)` (no notes, no owner names).
- Inbound email: `POST /api/webhooks/:org/email-in` → new ticket or `requesterReply` on the referenced one (`[T-1041]`).
- Jobs: every 5 min – escalate late tickets (once, `escalated` event, notify `escalateTo` role); nightly – `autoClose`;
  satisfaction mail on Solved when enabled.
- Tasks: `GET/POST /admin/tasks`, `PATCH /admin/tasks/:id`, `POST /admin/tasks/:id/done` (runs `completeTask` – a
  repeating task creates the next one), `POST /admin/tasks/:id/comments`, `GET/POST /admin/projects`,
  `POST /admin/projects/from-template {templateId, anchor, name, center, visibility}` (runs `projectFromTemplate`).
  Visibility: `canSeeProject` / `canSeeTask`. Every change audited.
- Sidebar badges: `GET /admin/queues/counts` adds `tickets` (open, visible) and `tasks` (mine, due today or overdue).
