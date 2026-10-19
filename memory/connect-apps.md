# Connecting the apps to the API (C1–C3, 2026-10-19)

## Switch
| Where | Setting | Demo | Live |
|---|---|---|---|
| web, admin | `ISGH_USE_MOCK_API` | `true` (default) | `false` |
| web, admin | `ISGH_API_URL` | – | the API's internal address, e.g. `http://127.0.0.1:4330` |
| web, admin | `MS_EDGE_KEY` | – | the same long secret as the API's `EDGE_KEY` |
| API | `TENANT_FROM_HOST=1`, `EDGE_KEY`, `TRUST_PROXY=1`, `COOKIE_SECURE=1` | – | production |
`next.config.ts` turns `ISGH_USE_MOCK_API=false` into `NEXT_PUBLIC_LIVE_API=1` for the browser code (build-time).

## How a request flows
browser → app (`/api/be/*`, `/api/store/*`, `/api/tickets` …) → API with `x-org-host` (the address the visitor used),
`x-client-ip`, the visitor's `ms_sid` cookie and `x-edge-key`. Without the key the API ignores those headers and uses
its own Host and socket address – nobody else can name an organization or fake an IP. Cookies are re-issued without a
Domain, so a website session never opens the admin and the other way round.

## Website (C2)
- Content: `GET /site/documents/:key` (edge key; never admin-access, integrations, finance, Zakat or donation settings).
  When the API cannot answer, the page errors – it never falls back to ISGH's built-in content.
- Members: sign-in codes / password through `/api/be/auth/*`; the member home from `GET /member/portal`, kept in
  sessionStorage for the tab (`lib/demo/demo-member.ts` live branch); sign-out ends the API session.
- Forms: join (`/public/join/email/*`, `/public/membership/applications`, card page via `/public/checkout`), ZIP lookup
  (`/public/place`), newsletter, help desk (`/member/helpdesk/tickets` when signed in), feedback and complaints
  (anonymous allowed; "was this page helpful" clicks file nothing), public membership check (`/public/members/verify`),
  gifts (`/public/checkout` kind gift – name and email asked for the receipt), events, groups, preferences.

## Admin (C3)
- `/sign-in`: email code → second step when the role needs it → dashboard → the admin. Middleware sends anyone without
  a session there. The "Acting as" picker is demo-only; live shows the name and Sign out.
- Documents: `/api/store/:key` → `GET|PUT|DELETE /admin/documents/:key` (versions, 409 on a stale draft, four eyes for
  provider / key changes, team rules, readable colors, reset = a new version, history with content).
- Organization panel: `/api/platform/me` → `/admin/platform/me`; invitations → `/auth/invitations/:token[/accept]`.

## Admin modules (C4, 2026-10-19)
Each screen keeps its own shape and the shared rules; in live mode its store turns every change into the API call that
makes it, then reads the server's copy again (the server's numbers, clocks and rules win). Refusals appear as a message
at the bottom of the admin (`ms:notice`).
| Module | Store (admin/src) | API |
|---|---|---|
| Members + work queues | lib/members/members.ts (`liveSteps`) | /admin/members?view=any&limit=all, PATCH, center, payments, id-check, approve, notes, archive/restore, activity, duplicates/decide, POST /admin/members |
| Help desk + team tasks | lib/work/work-store.ts (`liveTicketSteps`, `liveTaskSteps`, `liveProjectSteps`; one queue) | /admin/helpdesk/tickets?view=any&full=1, replies, notes, requester, PATCH, merge, task · /admin/tasks (+ screen ids), done/reopen, comments · projects |
| Events | components/views/EventAttendees.tsx | /admin/events (live counts), /admin/events/:id/registrations, /admin/registrations/:id/check-in |
| Giving, campaigns, ledger | lib/donations, lib/fundraising, lib/finance | /admin/donations (+PATCH, refund, receipt), /admin/payouts (one per deposit), /admin/fundraising?gifts=1, /admin/pledges, /admin/finance/transactions (+approve/reject/paid/void), /admin/finance/summary (statements) |
| Zakat | lib/zakat/use-zakat.ts (`liveCaseSteps`) | /admin/zakat/cases and its steps (checks, request-info, decide, approve, return, reject, pay, notes, assign) |
| Elections + voter list | ElectionsRunView (`liveElectionSteps`), ReportsView | /admin/elections (+ nominations, status, results, accept, swear-in), /admin/voters/:year (+ freeze). Publishing the elections document cannot change its recorded facts (electionGuard). |
| Messages | CampaignsView (`saveLiveCampaign`) | /admin/messages?full=1, POST/PUT, send, cancel |
| Minutes, benefit uses | lib/minutes, lib/benefits | /admin/meetings, PUT /admin/meetings/:id, /member/minutes · /admin/benefits/uses |

## C5 (2026-10-19)
| Part | App | API |
|---|---|---|
| Family tree, directory, minutes | web MyFamily, MemberDirectory, MeetingMinutes | GET/PUT /member/family, GET /admin/members/:id/family (no heritage) · GET /(member|public)/directory, PUT /member/directory · GET /member/minutes |
| Settings instead of ISGH values | web ComplaintForm (zones from org-structure), admin loadOrgLabels (ZONES / PLANS / CENTERS) | /site/documents/org-structure, membership-settings |
| Work-queue decisions | admin lib/members/queues.ts | GET /admin/queues/state, PUT /admin/queues/state/:caseId {decision?|null, assignee?} |
| Member app | mobile/src/data/liveApi.ts (`APP_MODE=live`) | /app/* (src/modules/app.ts) – memory/api-contract-mobile.md |
| SaaS panel | saas/src/lib/platform/live.ts, state.ts, app/sign-in (staff code + password), middleware gate | /platform/state, /platform/orgs (+ /:slug/actions), /platform/docs/:key, /platform/invoices/:id, /platform/auth/code/* |
| Website: campaigns, email choices | web app/campaigns, app/email-preferences | /public/campaigns · the communication document (consent text) |
| Dashboards (home, module dashboards, Members overview, masjid / zone home) | admin lib/dashboard/home-stats.ts (from the loaded records), lib/dashboard/live-history.ts | the member, queue, gift and settings routes above · GET /admin/events?when=past (attended, revenueCents) · GET /admin/messages/stats · the organization's year, record date and time zone from Membership settings (loadOrgLabels) |

## Local setup (this PC)
`BE/.env` + `.env.development` in web, admin, saas; `start-live.cmd` runs everything live (see BE/README.md).

## Still open (owner)
- A real `next build` and a click-through of both apps with `ISGH_USE_MOCK_API=false` against a running API.
- Providers: email (Postmark / SendGrid / Resend), texts (Twilio), card payments (Stripe; per-organization key).
- Push notifications: the app registers its Expo push token (`/app/devices`); nothing sends pushes yet (`APP_PUSH=1`
  shows the switch once a sender exists).
- Year-end giving statements for the app (`statements` is empty until the website has a statement page).
