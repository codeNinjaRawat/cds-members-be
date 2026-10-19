# Membership platform – API (BE)

One API for every organization on the platform (Masajid Solutions' SaaS; ISGH is client #1). PostgreSQL with Row Level
Security – one organization per transaction – and the same zod contracts as the website and the admin. Plain Node
`http`, no framework. A worker process runs the jobs and sends the email and text messages.

## Run it
```
cd BE
cp .env.example .env                      # read it: every setting is explained there
npm install                               # pg, zod, tsx, typescript
npm run migrate                           # sql/*.sql, once each
npm run seed                              # ISGH (client #1): documents, demo members; npm run seed:isgh adds the real masjids
npm run dev                               # http://localhost:4330
npm run worker                            # jobs + outbox (a second terminal)
```
Docker (from the membership folder): `docker compose -f BE/docker-compose.yml up --build`.
Without npm (sandbox / CI image with `psql`): `DB_ADAPTER=psql` sends every statement through psql – same SQL, same tests.

## Tests
`DATABASE_URL=<an empty database> npm run test:fresh` – migrations, seed, the SQL white-box tests and 15 black-box suites
over HTTP (≈ 1,100 checks). `npm run typecheck`. The website and admin against a live API: `tools/live-check/` (≈ 135 checks).

| Suite | What it proves |
|---|---|
| tests/rls.sql, rls_all.sql | every tenant table has RLS forced; another organization's rows are never visible; DB guards |
| api, auth | documents, permissions, scope · sign-in by code, password, Google, two-step, sessions, rate limits |
| members, website | member records, queues, imports · join with a proven email, payments, renewals, the member portal |
| helpdesk, events | tickets, clocks, restricted tickets, tasks · registrations under a seat lock, waitlist, check-in, approval |
| giving, zakat | gifts, deposits, receipts, campaigns, pledges, the ledger and its approvals · Zakat cases, levels, payouts, duties |
| comms, governance | groups, preferences, unsubscribe, bulk messages · voter list, nominations, count, certification, swearing-in |
| jobs, checkout, files | worker, outbox, provider webhooks, renewals · card checkout and its webhooks · uploads, areas, retention, S3 signing |
| platform, tenancy | the SaaS panel API, invitations, support sign-ins · a second organization: own content, IDs, clock, nothing shared; only our apps (edge key) may name the organization |
| site, documents | what the website's server reads, the member home, the public membership check · the admin's documents with its server checks (versions, four eyes, team, colors, reset, election facts) |
| records | meetings and minutes (numbered by the server, approval rules), member benefit uses |
| portal | the member's family tree (heritage private), the member directory, the office's shared work-queue decisions |
| app, app-contracts | the member app: tokens (rotation, reuse ends the chain, sign-out), every screen's answer · the app's own client, token manager and schemas against the API (needs `../mobile`) |

## How a request works
Host (or `x-org` in development) → organization → its time zone for every date → `SET LOCAL app.org_id`, role
`app_api` → RLS. The session cookie (`ms_sid`; only its sha-256 is stored) → the admin in that organization's
`admin-access` document → `can(role, permission)` and `inScope(zone, masjid, ZIP)`. Platform staff use `/platform/*`
(their own sign-in: emailed code + password). Webhooks (`/webhooks/*`) and signed file links (`/files/raw/*`) carry no
organization: the signature and the row they point at decide.

## The apps in live mode
The website and the admin call the API from their own servers – the browser never talks to the API directly:
`/api/be/*` in each app passes the call on with the visitor's address (`x-org-host`), IP (`x-client-ip`) and session
cookie, signed with `x-edge-key`. Set the same secret in both places: API `EDGE_KEY`, apps `MS_EDGE_KEY`; apps
`ISGH_USE_MOCK_API=false` and `ISGH_API_URL`. The website signs members in on its own address, the admin signs admins in
on its own address (`/sign-in`, with the second step for sensitive roles). Details: `memory/connect-apps.md`.

On your PC (live): put your PostgreSQL password in `BE/.env` (`DATABASE_URL`), then run `start-live.cmd` (membership
folder): migrate + seed, the API on http://localhost:4330, the website on http://isgh.localhost:3000, the admin on
http://isgh-admin.localhost:3001/sign-in (owner@example.org) and the SaaS panel on http://localhost:3002 (staff sign-in,
`PLATFORM_OWNER_EMAIL`). In development the sign-in codes show on the pages; nothing is emailed or charged.
Where the connection is set: `BE/.env` (database, `EDGE_KEY`, dev switches – read by `npm run dev / migrate / seed /
worker` through src/load-env.ts) and `.env.development` in web, admin and saas (`ISGH_USE_MOCK_API=false`,
`ISGH_API_URL`, `MS_EDGE_KEY` = the same key). `.env.local` in each app is for your own overrides (e.g. back to demo).
`start-dev.cmd` stays demo mode.
DEV database on the server (shared data, PostgreSQL 18): copy `BE/.env.server-dev.example` to `BE/.env.server-dev`, put the
🔑 DEV password in, then `npm run server-dev:check` → `server-dev:migrate` → `server-dev:seed`; `npm run dev:server-db` or
`start-live-server-dev.cmd` runs against it. Details: memory/database-environments.md.
 The server image never contains a `.env` (.dockerignore).

The member app (`mobile/`, `APP_MODE=live`) calls the API directly on `/app/*` (src/modules/app.ts): it names its
organization with `x-org` (accepted on `/app/*` only) and signs in with an emailed or texted code. Access tokens are
15-minute sessions sent as `Authorization: Bearer` (never accepted as a cookie, and cookies never as a bearer token);
refresh tokens (60 days) work once – using an old one again signs that chain out everywhere. The app's routes call the
website's own routes, so prices, places, eligibility and limits are the same. Card payments answer with `checkoutUrl`
(the provider's page the app opens). Repeated writes with the same `Idempotency-Key` get the first answer. Errors on
`/app/*` also carry `message` and `fields` (the app's form errors). Contract: `memory/api-contract-mobile.md`.

## Where things are
| Folder | |
|---|---|
| `sql/` | 0001–0027 migrations (re-runnable), `seed/isgh.sql` (ISGH's real zones and masjids) |
| `src/http` | server, core (tenant, session, permissions, errors, the organization's clock) |
| `src/auth` | sign-in, sessions, crypto |
| `src/modules` | documents, site, records-admin, members, website, helpdesk (+ tasks), events, giving, finance, zakat, governance, comms, checkout, projections |
| `src/jobs` | runner (tick / daily), worker, outbox, providers (email, text), webhooks, renewals |
| `src/files` | storage (local, S3-compatible with SigV4 presigning) and the file routes |
| `src/platform` | the SaaS panel API, starter content per template |
| `memory/` | decisions, API contracts, progress, changelog |

## Contracts
`@/*` maps to `../admin/src/*`: the API checks every document with the admin's registry (`REGISTRY[key].schema`) and
runs the same rule functions (eligibility, routing, approvals, clocks…). Contracts are edited in `web/src/lib` and
copied to the admin by `admin/scripts/sync-contracts.mjs`.

## Organization settings, not constants
ISGH's values are presets: a new organization gets its own starter documents by template (simple masjid, Bylaws society,
blank), its own member ID prefix (ISGH: `HOU`), its own time zone, zones and masjids. Nothing of ISGH (name, places, people,
keys, numbers) reaches another organization – tests/tenancy.test.ts checks every document.

## Providers (chosen in the environment, nothing installed)
Email: Postmark / SendGrid / Resend · Texts: Twilio · Cards: Stripe (a key per organization) · Files: any S3-compatible
store. Until they are chosen everything runs in test mode: `log` sends nothing, `fake` charges nothing, `local` keeps files
on disk.
