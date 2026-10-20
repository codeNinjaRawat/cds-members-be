# Backend (API) – Changelog

- 2026-10-13 – Created memory folder.
- 2026-10-13 – Initialized git repo (branch main), added .gitignore and .gitattributes.
- 2026-10-13 – Added admin-control/settings/flags scope; research-first and testing rules.
- 2026-10-13 – Added build order/module plan; admin glass theme; SQL data layer references.
- 2026-10-13 – Added integration slots (SMS gateway, email gateway, Stripe).
- 2026-10-13 – Added api-contract-web.md (endpoints the website already consumes).
- 2026-10-15 – SaaS: added saas-architecture.md, api-contract-platform.md, research/saas-multitenancy.md; purpose, structure, decisions and progress updated; ISGH recorded as client #1 (founding client).
- 2026-10-15 – Added api-contract-community.md (events, groups, communication, configuration, renewals; WildApricot migration map for levels).
- 2026-10-15 – Contract: renewal engine section added to api-contract-community.md (paid_through, renewal_status, covers_from/through, renewal-lifecycle job, duesCoverVote).
- 2026-10-15 – Contract: member records section (extra jsonb, access, archive, duplicates, import, safe CSV) in api-contract-community.md.
- 2026-10-15 – Contract: groups update (match/include/exclude, renewal fact, usage, access, member join API) in api-contract-community.md.
- 2026-10-15 – Contract: communication + campaigns section (rules, renewal emails, campaigns API, preferences, unsubscribe, SMS consent) in api-contract-community.md.
- 2026-10-15 – Contract: events/payments/security section (public events, seats, refunds, waitlist, check-in, ICS, checkout, invoices, payment states, receipts, sessions, ID purge).
- 2026-10-15 – New api-contract-reports.md (reports endpoints, voter list snapshots, fingerprint, privacy).
- 2026-10-15 – New api-contract-access.md (roles, permissions, scopes, two-step, audit table).
- 2026-10-15 – New api-contract-integrations.md (secrets endpoint, four eyes, adapters, webhooks, test sends).

## 2026-10-18 – B0 Foundation built (first backend code)
- Stack decided: Node 22 + TypeScript, plain `node:http` (no framework), PostgreSQL 16 with Row Level Security,
  `pg` driver in production and a `psql` command-line adapter for environments without npm (the sandbox tests use
  it), zod contracts shared with the admin (`@/*` → `../admin/src/*`), tsx to run.
- `sql/0001_foundation.sql`: schemas `app` and `platform`; roles `app_api` (tenant, RLS forced) and `app_platform`
  (SaaS panel, sees everything); `platform.organizations` with the founding-organization guard (ISGH cannot be
  deleted or cancelled); `app.documents` + `document_versions` (last 20 kept by trigger) – every admin document as
  JSON validated by the API; `app.members` (Bylaws columns + JSON for the rest) + `payments`; `tickets` +
  `ticket_updates`; append-only `audit_log`. Policies: `org_id = app.current_org()` on every tenant table.
- `src/db/sql.ts` (adapter interface, PsqlDb, PgDb), `migrate.ts`, `seed.ts` (ISGH + 25 documents + 320 demo
  members + 8 tickets, idempotent), `registry.ts` (documents and their public projections), `http/server.ts`
  (routes in the file header: documents, members + approve with the approval rule, tickets admin + website,
  public documents, audit).
- Tests: tests/rls.sql (tenant isolation, 12 checks) and tests/api.test.ts (43 black-box checks) – both green on
  PostgreSQL 16 in the sandbox. Typecheck clean (pg types arrive with npm install).
- Next: B1 sign-in (OTP + Google, sessions, the `x-admin` header goes away), B2 the rest of the members API
  (edit, payments, import check, queues), then module by module per the api-contract-*.md files.

## 2026-10-18 – Database: SaaS → city → masjid → members → every module (migrations 0002–0013)
- Owner: "move to the BE … start with the SaaS thing, city, then masjid; a few things will be primary sort for the member;
  then cover all the things". Map of every table: memory/database-schema.md.
- 0002 platform (plans, organizations extended with client_no – ISGH = 1 guarded, modules, domains + host lookup, users,
  org admins, invitations, flags, announcements, staff, settings, support sessions, append-only audit, invoices, usage),
  0003 geography (countries, US states, cities, ZIP codes, distance; per org: cities, zones, zone ZIPs),
  0004 masjids (centers, service ZIPs with the zone rule, ZIP → masjid → zone, nearest masjids, Jumu'ah, contacts,
  working body), 0005 members (primary sort masjid → zone → status → last name, member numbers, placement by ZIP,
  plans, households, family links, memberships → status / paid-through, payments extended, applications, ID checks,
  center changes, duplicates, consents, notes, member_list view), 0006 access (permission catalog, roles, admins,
  scoped assignments, can() / in_scope(), sign-in codes, passwords, sessions, sign-in events), 0007 groups +
  communication, 0008 events, 0009 giving + fundraising + finance, 0010 Zakat, 0011 officials + elections + voter list
  snapshots, 0012 help desk + team tasks, 0013 files, records, meetings, prayer times, benefits, imports, jobs.
- sql/seed/isgh.sql – ISGH as client #1: five zones, 21 real masjids (4 "name to confirm", the Eastside office as kind
  office), Jumu'ah 1:15, plans (Check-o-matic, Individual $20, Lifetime $1,000 / $1,500), funds. `npm run seed:isgh`.
- Tested on PostgreSQL 16 (fresh and on the seeded demo with 320 members): tests/rls.sql 8/8, new tests/rls_all.sql
  20/20 (79 tenant tables: RLS forced, no cross-organization row visible, placement, primary sort, DB guards),
  API black-box 43/43, every migration re-runs safely. 0001 tables kept, so the current API works unchanged.
- admin/src/lib/queues/tickets-core.ts restored to the v0 model (the BE still imports it) – the admin uses work.ts.

## 2026-10-18 – B4a Help desk + Team tasks API
- src/modules/helpdesk.ts (HELPDESK_ROUTES, TASK_ROUTES; registered in server.ts). Rows load into the admin's own
  Ticket / Task shapes and run the same pure rules from web/src/lib/community/work.ts (routing, clocks, restricted
  visibility, merge, recurring tasks, templates); times are the organization's local wall-clock (America/Chicago for now).
- Admin: list (views mine / unassigned / late / waiting / solved, search, category) with both clocks, stats, ticket,
  create, patch (owner, status, priority, category, masjid, tags, watchers, restricted, rating), replies (email via
  platform.outbox) and notes (@mentions → watcher + notice), merge, bulk, ticket → team task, run-jobs (auto-close +
  one-time escalation). Website /public/helpdesk/tickets (honeypot, 5 per hour, acknowledgement) and portal
  /member/helpdesk/tickets (list, reply; members never see notes).
- Tasks: list / projects with progress and workload, create, patch, done / reopen (repeating tasks make the next; a
  task from a ticket notes the ticket), comments (@mention adds a helper), delete (creator, owner or admin manager),
  projects and projects from a template (dates from the anchor), project rename / archive by its owner.
- web /api/tickets now posts to /public/helpdesk/tickets. tests/helpdesk.test.ts 70/70; full run: SQL 8 + 20,
  api 43, auth 43, members 52, website 37, helpdesk 70.

## 2026-10-18 – B4b Events API
- sql/0017_events_api.sql: app.events.spec (the event as written), ticket types with guest price + server-only access
  code, registrations with type, seats, paid / refund cents, manage link hash, source; app.event_reminders;
  app.event_taken(), app.event_register() (row lock on the event: confirmed / pending-payment / waitlist, raises
  event_full / type_full), app.event_promote() (waitlist in order, nobody skips ahead); organizations.timezone + app.org_tz().
- projections.ts: `events` document → app.events + ticket types (gone from the document → archived); saveDocument()
  publishes from inside the API (new version + projection).
- src/modules/events.ts (EVENT_ROUTES): public list / detail / .ics with live seats (codes, approval notes and
  members-only events never public); registration (rules from events.ts, discount codes, honeypot, 10 per hour,
  confirmation email with a cancel link); member portal list / cancel; admin list (masjid scope), PUT one event (masjid
  roles → draft waiting for approval), approval with notice, cancel event (everyone told, paid refunded), delete
  (only without registrations), registrations + door list (no emails for volunteers) + safe CSV, office / door
  registration, check-in (volunteers on the event day), paid at the door, staff cancel with refund; runEventJobs reminders.
- registry.ts: the plain /public/documents events projection now strips codes and members-only events.
- web /api/events/register forwards to the API when ISGH_USE_MOCK_API=false (with the member cookie).
- server.ts: text bodies (calendar, CSV) when a content-type is given. Full run green: SQL 8 + 20, api 43, auth 43,
  members 52, website 37, helpdesk 70, events 68.

## 2026-10-18 – B4c Giving, fundraising and finance API
- sql/0018_giving_finance_api.sql: donations keep the donor as given (name, email, show name, monthly, source, pledge,
  refund); campaigns.spec; pages owner; pledges with donor key + P- reference; payouts gifts / difference; ledger without
  the donation-fund key (finance-settings has its own funds), status `received`, masjid name, method, ref, relief,
  decision note, unique source_ref, guard trigger (a paid / void line never changes amount, fund, kind or date).
- projections.ts: `fundraising` → app.campaigns + app.campaign_pages.
- src/modules/giving.ts (GIVING_ROUTES): donations list + stats (masjid scope), cash / check entry (entryProblems,
  Check-o-matic answer), platform import (idempotent by the platform id; refunds on resync), reconcile (Zakat stays
  Zakat; a campaign's fund wins), refund (payments.refund), receipts R-YYYY-NNNNN with the IRS sentence, deposits that
  match gifts to the cent, Check-o-matic list, member giving history; public campaigns (no emails, no amounts with names),
  member personal pages (approval), page decisions, pledges paid by gifts (fulfilled automatically), admin fundraising view.
- src/modules/finance.ts (FINANCE_ROUTES): ledger list / entry (masjid Finance Secretaries for their own masjid),
  approve (levels by role, nobody approves their own, two different signatures above the limit, Board decision above
  the Board limit), reject, paid (check number), void; Art. XII Sec. 4 and restricted transfers refused without a Board
  decision; summary (balances, budget vs actual, months, statements due, warnings); quarterly statements; donations →
  income lines per fund and masjid (idempotent).
- Full run green: SQL 8 + 20, api 43, auth 43, members 52, website 37, helpdesk 70, events 68, giving 77.

## 2026-10-18 – B4d Zakat API
- sql/0019_zakat_api.sql: zakat_cases.spec (the case as the rules see it), coordinator, consent time; statuses and
  channels as in zakat.ts; months 1–12; payout methods; payouts append-only (trigger).
- src/modules/zakat.ts (ZAKAT_ROUTES): POST /public/zakat/applications (ZIP → zone → masjid → its coordinator, one open
  request per person, consent, limits from zakat-settings, acknowledgement email), GET /member/zakat/applications (plain
  status only), admin queue with actions / blocked reason / due time / stats (masjid scope; others get 404), case with
  history (opening it is audited), in-person intake, checks + home visit, request info (email), decide Zakat / Sadaqah /
  not eligible, approve by level (lower amounts allowed, never above the request), Chair override, return / reject with a
  reason, monthly payouts by Operations (payout row + paid ledger line from the Zakat or Sadaqah fund), notes, assignment.
  The zakat_steps trigger refuses a second approval and a payout by an approver even if the API were wrong.
- Full run green: SQL 8 + 20, api 43, auth 43, members 52, website 37, helpdesk 70, events 68, giving 77, zakat 52.

## 2026-10-18 – B4e Voter list, elections and officials API
- sql/0020_governance_api.sql: voter_snapshot_rows.name, voter_snapshots.fingerprint (hex), official_terms sources and
  zone / masjid names as written.
- projections.ts: `officials` → app.official_terms (holders + history; "one elected office per member" is a DB index).
- src/modules/member-shape.ts: the Member shape (moved out of server.ts so modules share it).
- src/modules/governance.ts (GOVERNANCE_ROUTES): voter list per year (versions, today's count, approved after the record
  date, changes since the last version), freeze after the record date (a correction needs a reason; no version without
  a change; the database recomputes the fingerprint before it is accepted), CSV with ID / name / zone / masjid only
  (downloads audited), verify; elections: plan a year (seats by parity, Area Representative seats from voter counts),
  nominations with eligibility from the records (frozen list, years in good standing, zone / masjid / ZIP, office
  held), decisions (seconder; accepted only without issues), status steps in order (ballot after nominations close or
  early by the Commission; voting needs the frozen list; certification needs every seat decided), counts (never more
  votes than ballots; an accepted count is final), ties decided by the Commission's tie-break, swearing-in (winners
  become serving officials, those they follow go into the history); public ballot (names only) and certified results;
  member portal: on the voter list or not, the seats they vote for, their nominations, nominate from the portal.
- Fix found by the test: with several places in one seat, each winner sworn in replaces the old holders only once.
- Note for SaaS: the shared contracts still check member IDs as HOU-123456 – make the prefix an organization setting.
- Full run green: SQL 8 + 20, api 43, auth 43, members 52, website 37, helpdesk 70, events 68, giving 77, zakat 52, governance 54.

## 2026-10-18 – B4f Groups and communication API
- sql/0021_comms_api.sql: messages.name / topic / spec / skipped / group_id; groups.spec; join policies as written.
- projections.ts: `groups` → app.groups + manual members (join requests and automatic members are not touched).
- src/modules/comms.ts (COMMS_ROUTES): groups with sizes, rule warnings and where used; members of a group (no emails);
  add / remove (manual) or always-in / never-in (automatic); join requests; automatic groups recomputed into
  app.group_members (job + on demand); member portal groups (join / leave / ask by policy); preferences (official
  notices cannot be switched off; text consent recorded); signed unsubscribe links (masked address, everything optional
  or one topic); bulk messages: draft, edit, preview (recipients, skipped and why, problems, the exact text), send now or
  scheduled, cancel, run-jobs; one delivery row per person and the outbox entry; masjid roles reach their own members;
  group leaders may email their group when the settings allow.
- auth: the per-IP code limit is a setting (AUTH_CODES_PER_IP, default 20) and relaxed in dev / test mode.
- crypto.ts: signLink() for links in emails.
- Full run green: SQL 8 + 20, api 43, auth 43, members 52, website 37, helpdesk 70, events 68, giving 77, zakat 52,
  comms 48, governance 54 (616 API checks).

## 2026-10-18 – B5a Jobs, outbox worker and provider webhooks
- sql/0022_jobs.sql: outbox attempts / ref / claim / status; app.sent_notices; platform.job_runs; platform.webhook_events.
- src/jobs/providers.ts: email (log, postmark, sendgrid, resend) and text (log, twilio) adapters with plain fetch; chosen by
  EMAIL_PROVIDER / SMS_PROVIDER; MAIL_FROM is the platform address, the organization's name and reply-to come from its settings.
- src/jobs/outbox.ts: drainOutbox – claims rows (several workers are safe), suppresses bounced addresses and STOP numbers
  (sign-in codes by email still go), five tries then failed with the reason, bulk delivery rows follow.
- src/jobs/webhooks.ts: /webhooks/email/:provider (token or basic auth; delivered / bounced / complained / opened /
  clicked; hard bounce → suppressed), /webhooks/sms/twilio (signed with the account token; STOP / START replies change
  consent for every organization that texted the number); every event stored once.
- src/jobs/renewals.ts: daily refresh_status + the renewal emails switched on in Communication on their day, once per term.
- src/jobs/runner.ts + worker.ts: tick = help-desk escalations, scheduled messages; once a day per organization (its time
  zone): renewals, event reminders, automatic groups; platform: purge old sign-in codes; then the outbox.
- server: form bodies and the raw body (webhook signatures); keep-alive 65 s (behind a load balancer); webhooks need no
  organization in the address.
- Full run green: SQL 8 + 20, api 43, auth 43, members 52, website 37, helpdesk 70, events 68, giving 77, zakat 52,
  comms 48, jobs 31, governance 54 (647 API checks).

## 2026-10-19 – B5b Online payments
- sql/0023_checkout.sql: app.checkout_intents (kind dues / event / gift, amount, what to record, provider session and
  payment ids, status, refunds); platform.intent_org() lets the webhook find the organization.
- src/modules/checkout.ts: POST /public/checkout – dues (pending card payments of one member), an event registration
  (with its own manage link), a gift (campaign fund wins; page must be approved; monthly = subscription); the Stripe
  adapter (STRIPE_SECRET_KEY_<SLUG> or STRIPE_SECRET_KEY, idempotency key) and a fake one for development and tests.
  /webhooks/pay/stripe verifies Stripe-Signature (5-minute window), stores each event once and applies:
  completed → dues paid (membership follows) / registration confirmed + email / gift in Donations (+ receipt with the IRS
  sentence when the amount asks for it); expired → the seat goes back and the waitlist moves; failed → dues failed;
  charge.refunded → dues refunded (the term is taken away), registration refunded, gift refunded.
- website.ts: movePayment() shared by the office and the webhook (a repeated move to the same status is harmless);
  the join answer carries the payment ids and the checkout call to make.
- Full run green (12 suites, 677 API checks + 28 SQL).

## 2026-10-19 – B6a SaaS platform API
- sql/0024_platform_api.sql: platform.panel_docs (plans, flags, announcements, settings, team – versioned), staff key /
  two-factor, support sign-in tokens, read-only sessions, staff sign-in codes and events, invitations ↔ org users.
- src/platform/routes.ts: staff sign-in (emailed code AND password; first sign-in sets it; the first owner is
  PLATFORM_OWNER_EMAIL – no demo staff in production); GET /platform/state; POST /platform/orgs (NewOrgSchema, reserved and
  taken addresses, plan on offer, trial days, add-on modules, starter documents checked before anything is created, owner
  invitation email); every action of the panel (suspend / restore / cancel – never ISGH – / reactivate / plan with usage
  limits / extend trial / convert / payment fixed / module / invite / resend / revoke / role / domain + TXT verification /
  support / end support / profile), role-checked per action; panel documents with versions (409 on a newer one) projected to
  saas_plans and staff; invoices paid / void; platform.audit for every step.
- Organization side: GET /admin/platform/me (product, organization, trial days, modules with flags, announcements for it,
  the support banner), invitations shown and accepted only on the organization's own address (password, both admin lists
  active), POST /auth/support opens a support session once; read-only support cannot write anything (403 in the router).
- Found by the test: a new organization must not fall back to ISGH's documents – it gets its own starter documents.
- Full run green (13 suites, 747 API checks + 28 SQL).

## 2026-10-19 – B6b Templates and per-organization settings
- src/platform/starter.ts: a document an organization has not published comes from its starter, not ISGH's: re-branded
  (name, short name, address, phone, site) with ISGH-only lists emptied (centers, people, events, needs, partners, budgets,
  bank and giving accounts, keys, prayer locations); pages by template (simple masjid: no Bylaws / election pages; blank:
  legal pages only); every starter checked with its schema. ISGH (client #1) keeps the built-in documents.
  core.document() uses it; the footer without a ZIP says ZIP 00000 and bulk email refuses to send until it is fixed.
- sql/0025_org_settings.sql: organizations.member_prefix (ISGH = HOU; new organizations from their short name),
  app.member_prefix(), app.next_member_id() uses it first.
- Time zones: tzStore (AsyncLocalStorage) holds the organization's zone for each request and each job tick; todayCT(),
  help-desk clocks (SQL uses app.org_tz()) and the runner follow it.
- Contracts (web → admin): member IDs may be any prefix of 2–5 letters (was HOU- only); admin zones are the
  organization's own zone ids (was ISGH's five); the admin's Access and Team screens list zones from org-structure.
- Found by the tests: ISGH's map link, integration keys and Stripe descriptor were in the built-in documents.
- Full run green: 14 suites, 782 API checks + 28 SQL checks.

## 2026-10-19 – B6c Files and deployment
- sql/0026_files.sql: files are pending → ready → deleted, with the member they belong to, what they belong to (ref), and a
  delete-on date; sha256 filled when the upload is confirmed.
- src/files/storage.ts: local disk (signed /files/raw/<token> links made with the server's secret, expiring) or any
  S3-compatible store (AWS SigV4 query presigning without an SDK – the test checks AWS's published example signature).
- src/files/routes.ts: POST /admin/files (area decides permission, types, size; sensitive areas always private) →
  upload → /complete (size checked) → GET (5-minute download address; photo IDs and Zakat papers audited) → DELETE;
  member photo IDs from the portal (private, 30 days); public files for the website; daily purge in the runner.
- server: bodies can be bytes (local uploads, 52 MB at most), Buffer answers (downloads).
- Deployment: Dockerfile (API and worker in one image, built from the membership folder because of the shared
  contracts), docker-compose.yml (PostgreSQL 16 + API + worker), .env.example (every setting explained),
  deploy/test.sh (fresh database → migrate, seed, SQL tests, 15 suites), README rewritten (map of the code, tests, providers).
- Full run green: 15 suites, 811 API checks + 28 SQL checks.

## 2026-10-19 – ZIP codes
- src/db/load-zips.ts (`npm run geo:load -- <file>`): CSV or tab-separated, columns found by name; works with the Census
  ZCTA Gazetteer (center points) and with ZIP lists that carry city / state / county / time zone; a later file fills what
  an earlier one left empty and never blanks a value. (The sandbox cannot reach census.gov – load it on the server.)
- GET /public/place also answers where the ZIP is (city, state) and, when no masjid serves it, the three nearest masjids
  with miles (masjids need their latitude / longitude – seed:isgh has them).
- tests/geo.test.ts 8/8 with small fixtures. 16 suites green.

## 2026-10-19 – v0 tickets retired
- /admin/tickets, /admin/tickets/:id, /admin/tickets/:id/updates → 410 Gone, pointing to /admin/helpdesk/tickets and /admin/tasks.
- POST /public/tickets (the old website form: kind / title / detail) now files a help-desk ticket: the kind picks a
  topic the organization has on its website (complaint → complaint / facilities / other, feedback → feedback / other,
  request → request / question / membership / other; never a private topic), same checks, honeypot and rate limit;
  answers { id, reference, message }.
- The website handler in helpdesk.ts is one function (fromWebsite) for /public, /member and the alias.
- server.ts and seed.ts no longer import tickets-core; the seed adds no demo tickets (help desk starts empty).
- tests/api.test.ts: ticket section rewritten (35 checks). All 16 suites green (≈ 810 API + 28 SQL checks).

## 2026-10-19 – C1–C3: the website and the admin on the API
- Edge trust: in production `x-org`, `x-org-host` and `x-client-ip` count only with `x-edge-key` = EDGE_KEY; nginx's
  last x-forwarded-for hop with TRUST_PROXY=1; anything else is ignored (tenancy +10 checks).
- New src/modules/site.ts: GET /site/documents/:key (the website's server), GET /member/portal (member home: card,
  voting checks, payments, household, groups; status from the database), POST /public/members/verify (3 facts, rate-limited).
- New src/modules/documents.ts replaces the documents block in server.ts: any signed-in admin reads (integrations need
  their permission), unpublished = the organization's starter content (was ISGH's built-in for everybody), PUT checks
  baseVersion (409), theme contrast, four eyes for integrations, team rules for masjid leaders, keeps an active owner;
  DELETE = starter content as a new version (history kept); ?versions=full for "load into draft".
- Help desk: feedback and complaints may be anonymous on the simple website form (no acknowledgement email).
- Website: lib/api/client.ts (edge headers, cookie pass-through), siteDoc loader (no ISGH fallback), /api/be proxy,
  live branches in demo-service / demo-member / SignInView / JoinFlow / GiveDialog / ComplaintForm and the API routes.
- Admin: lib/api/client.ts, /api/be proxy, /sign-in page, middleware gate, live session in use-access, /api/store and
  /api/platform/me|invite on the API. Also fixed a type error in MemberProfile (zones are any id now).
- tools/live-check: the apps' own code against a live API without Next.js (web 35, admin 25). 18 BE suites green.

## 2026-10-19 – C4: every admin module on the API
- Admin stores (members, work, donations, fundraising, finance, zakat, meetings, benefits, campaigns, elections, voter
  list, event registrations) keep their demo path; in live mode each change becomes the API call that makes it, and the
  server's copy is read again. Refusals show as a message at the bottom of the admin.
- BE: /admin/members?view=any&limit=all, notes and centerOverride in the member shape, POST /admin/members/:id/activity;
  help desk view=any&full=1 and /requester, tasks / projects keep the screen's id, board order; /admin/fundraising?gifts=1;
  finance summary lists statements; messages ?full=1; election guard on publishing the elections document; new
  elections drop Area Rep seats with no voters; 0027 + records-admin.ts (meetings and minutes, benefit uses).
- Found on the way: toMember lost prefs and audit after an inline comment (fixed before release, comms test caught it).
- 19 BE suites green on an empty database; tools/live-check: website 35, admin 102.

## 2026-10-19 – C5: member pages, settings instead of ISGH values, shared queues, the member app on the API
- Website member pages read the API: family tree (GET/PUT /member/family – heritage stays private, a typed-in member ID
  is never linked), member directory (opt-in, what shows from Configuration), minutes (/member/minutes). 0028.
- ISGH values out of the code: the complaint form's zones and the admin's zone / plan / masjid labels come from the
  organization's settings; the shared election rules drop seats with no places.
- Work-queue decisions and who took a case: /admin/queues/state (0029) – the whole office sees the same queue.
- The member app: /app/* (src/modules/app.ts) for every screen, sign-in by code with bearer tokens (15 min) and
  single-use refresh tokens (reuse ends the chain), devices, notifications, crash reports, repeated-request keys (0030).
  The app's routes call the website's routes (same prices, places and rules); card payments open the provider's page
  (`checkoutUrl`). Mobile: liveApi on /app/*, photo ID upload in three steps, spouse name on household plans, card page
  opened after renew / give / register / pay-now / join.
- 22 BE suites green on an empty database (+ app-contracts: the app's own client and schemas, 37 checks).

## 2026-10-19 – Dashboards on live data
- Home (Overview, Command center), module dashboards, Members overview and the masjid home no longer show demo numbers
  in live mode: admin lib/dashboard/home-stats.ts works them out from the records already loaded (members and dues,
  queues, gifts, settings); past events and message results come from GET /admin/events?when=past (now with attended
  and revenueCents) and the new GET /admin/messages/stats. The year, record date and clock are the organization's
  (Membership settings), not ISGH's typed-in dates or Houston's time zone; "demo data" labels only in demo mode.
- tests/dashboards.test.ts (10); platform test reads the platform's own domain from its settings.

## 2026-10-19 – SaaS panel on the API, last website pages, local connection files
- SaaS panel live mode: every page reads GET /platform/state as the signed-in staff member (sign-in page: emailed code +
  password; the gate sends people there), its routes pass changes to /platform/* (tools/live-check/saas-live: 20).
- Website: /campaigns totals from GET /public/campaigns, /email-preferences consent text from the communication document.
- Local connection: BE/.env (+ src/load-env.ts for the npm scripts), .env.development / .env.local in web, admin, saas,
  start-live.cmd (API + website + admin + panel), demo launchers pin demo mode, allowedDevOrigins for *.localhost,
  .dockerignore keeps .env files and node_modules out of the server image.

## 2026-10-19 – Support for the DEV database on the server
- Profiles: `--env=<name>` / `BE_ENV` reads BE/.env.<name> before BE/.env (src/load-env.ts, pure helpers in src/env-file.ts);
  BE/.env.server-dev.example (committed) → BE/.env.server-dev (git-ignored, 🔑 DEV password).
- src/db/sql.ts: `DATABASE_SSL` disable | require | verify-full with the same meaning for pg and psql (pg alone rejects
  the server's self-signed certificate on sslmode=require; psql has no no-verify); pool size, 10 s connect timeout,
  application name for pgAdmin, idle-connection errors logged instead of crashing.
- New: `npm run db:check` (read-only health check with fixes), `db:test-sql` (SQL white-box tests without psql; refuses
  databases not ending in _dev/_test), `server-dev:check|migrate|seed|test-sql`, `dev:server-db`;
  start-live.cmd takes a profile (`start-live.cmd server-dev`), start-live-server-dev.cmd.
- tests/db-config.test.ts 26/26; tsc --noEmit clean. memory/database-environments.md.
- 2026-10-19 (merge) – Another session replaced sql.ts / check.ts / package.json meanwhile; SSL support re-applied on top of its
  check.ts (kept: used by GET /health): DATABASE_SSL in sql.ts, SSL / pg_hba reasons in explain(), server-dev:* scripts back.
  /health and db:check now wait 10 s (DB_HEALTH_TIMEOUT_MS) – 3 s was too short for the first encrypted connection PC → server.
- 2026-10-19 – sql/0031_owner_roles.sql: skip the GRANT when the owner already has app_api + app_platform (server DB: granted by postgres; a non-superuser cannot re-grant without ADMIN OPTION, which stopped migrate).
- 2026-10-19 – Far-away database speed: PgDb.run sends BEGIN + SET LOCAL ROLE + org in one round trip (was three; every API request gains ~0.5 s against the server DB from a PC); seed: documents in one transaction, members and payments as multi-row INSERTs (100 members / up to 2,000 payments per statement) – seeding the server DEV DB from a PC goes from many minutes to seconds. Placeholder numbering verified; tsc clean.
- 2026-10-19 – Real data: `src/db/import-wildapricot.ts` (`npm run import:wa -- "<Contacts.xml>" [--dry-run]`, `server-dev:import-wa` for the DEV database). Reads the Wild Apricot contacts export (Excel XML or CSV); builds masjids/zones from "Zone / Center" and ZIP majority; removes the demo members; imports people, plans (level → single/family/life), membership terms (Renewal due = end; Suspended/Lapsed kept as cancelled terms → expired), staff notes, couples (bundles of 2). Skips DL/ID numbers, pictures, files, passwords, balances. Re-running skips people already imported. Tested on the 2026-10-17 export: 10,404 people → 7,279 active · 582 life · 2,292 expired · 251 pending; 484 couples.
- 2026-10-19 – `npm run report:members` (`server-dev:report`) runs `sql/review/real-data.sql` (counts only, no personal details). Seed no longer re-adds demo members once real records exist. Migration 0032: index on member notes by member (member list on 10k people 11 s → 2.6 s on the test adapter).
- 2026-10-19 – Localhost: separate browser cookie names (admin ADMIN_SESSION_COOKIE=ms_admin, panel PANEL_SESSION_COOKIE=ms_panel) so the website, admin and panel sign-ins on one PC do not overwrite each other; the API still sees ms_sid.
- 2026-10-19 – Localhost: LOCALHOST_ORG=isgh in BE/.env lets plain http://localhost:3000 / :3001 open that organization (before, plain localhost had no organization and admin sign-in failed). Off unless set; never in production.
- 2026-10-19 – npm run admins / server-dev:admins lists who can sign in to the admin (role, email, reach); '-- --code <email>' prints the newest sign-in code for that address (development only).
- 2026-10-19 – Development: AUTH_DEV_FIXED_CODE=123456 (BE/.env) makes every sign-in code 123456 (only with AUTH_DEV_CODES=1, never in production); DATABASE_IDLE_MS keeps DB connections open (far DEV database); apps' ISGH_API_TIMEOUT_MS=30000 locally.
- 2026-10-19 – Page check with real data (admin signed in, every page visited): fixed the crashes and wrong numbers –
  · pg driver: DATE columns stay 'YYYY-MM-DD' (they came back as JavaScript dates shifted by the PC's timezone, breaking dates on many pages);
  · admin date helpers (addDays in 12 files) never throw on an empty/bad date (members without a birth date crashed the home page and queues);
  · Family trees no longer needs the demo person aisha@example.com; shows "No members yet" when empty;
  · status: live members carry paidThrough + termStatus from their membership terms – imported members show Active/Expired correctly, suspended lifetime members are not current;
  · API: MEMBERS_CACHE_SECONDS (BE/.env, development) keeps the 10k-member list in memory, cleared on any change (23 s → ~4 s);
  · apps wait 60 s for the API locally (ISGH_API_TIMEOUT_MS); AUTH_DEV_NO_LIMITS=1 removes the code limit / lock-out on a PC;
  · new organizations no longer inherit ISGH's per-masjid payment accounts (donation-settings starter);
  · tests/api: the seed now has 5 plans (monthly added) – checks ≥ 4.
- 2026-10-19 – Admin sign-in redesigned: split screen (organization artwork + name from its site settings on the left, sign-in card with step indicator on the right; stacks on phones; colors follow the organization's theme; development code has a 'Fill it in' button).
- 2026-10-19 – People who never became members (applied / never finished / never verified) stay visible: importer marks them joinStage applied|incomplete and never approved (Wild Apricot's 'Unverfied' level was being approved – fixed); a repair step fixes earlier imports on the next run. Admin queues on live data are real only: Applications, Not finished, Photo ID (applicants), Missing information – no invented payment/duplicate/centre cases.
- 2026-10-19 – Masjid filter on every screen uses the organization's published Masjids and zones (was the demo list); importer names zones 'North' etc. (the admin adds 'Zone') – re-run the import to republish.
- 2026-10-19 – Deploy-ready: src/production.ts (`npm run check:production`; the API and worker refuse to start in production with a development switch, short secrets, insecure cookies, missing provider keys or fake payments without ALLOW_FAKE_PAYMENTS=1); clean SIGTERM shutdown (API finishes requests, worker finishes its batch); HOST=127.0.0.1 binding; tsx is a runtime dependency; .env.production.example; deploy/: deploy.sh (pull → install → check → pg_dump backup → migrate → pm2 reload → health), ecosystem.config.cjs (BE/.env.production or BE/.env), nginx-be.conf (be.nextgrow.pro, public paths only: /webhooks, /files/raw, /app, /health), docker-compose.prod.yml, README.md; SERVER.md (staging on the DEV DB) aligned; Dockerfile with tini; tests/production (23).
- 2026-10-19 – PC development against the server API (https://be.nextgrow.pro): web/admin .env.development point there with MS_ORG_HOST (isgh.nextgrow.pro / isgh-admin.nextgrow.pro) + the server's edge key; start-server-api.cmd runs only web + admin.
- 2026-10-19 – Server sign-in showed "No organization 127.0.0.1": (a) the API now says plainly when MS_EDGE_KEY ≠ EDGE_KEY or the app sent no key; (b) npm run seed links SEED_WEB_HOST / SEED_ADMIN_HOST to the founding organization (only empty values; npm run seed did not set legacy hosts, only seed:isgh did).
- 2026-10-19 – AUTH_DEV_CODES=admin-app: on a shared DEV server without an email provider the sign-in code shows on the ADMIN sign-in page only (request must carry the edge key and come from an admin-app address); website, member app and direct API calls never see it; ignored when NODE_ENV=production.
- 2026-10-19 – Admin sign-in by email + password (owner request – email codes not usable on the DEV server): admin sign-in page = email + password; npm run admin:password -- email (random 20-char password printed once, or --ask); AUTH_PASSWORDS=on allows passwords while the org's sign-in settings have them off; AUTH_TWO_STEP=off skips the emailed second code on a DEV server (ignored in production). BE + admin tsc clean.
- 2026-10-20 – npm run admin:passwords (server-dev:admin-passwords): every admin's development password in BE/admin-passwords.json (git-ignored), applied to the database as hashes; edit + re-run to change; refused in production; check:production warns while the file exists.
