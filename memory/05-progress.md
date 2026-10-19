# Backend (API) – Progress

## Done
- [x] Folder and memory created
- [x] SaaS architecture + platform API contract + multi-tenancy research (2026-10-15)
- [x] B0 DB foundation: schema with org_id + RLS (ENABLE + FORCE), roles, documents with versions, members,
      payments, tickets, audit; migrate + seed (ISGH client #1); first API routes; tenant-isolation and API tests
      green (2026-10-18 – see 06-changelog.md and README.md)

- [x] Database for every module (2026-10-18): migrations 0002–0013 + ISGH seed, tested on PostgreSQL 16 (memory/database-schema.md)
- [x] B1 Sign-in (2026-10-18): email/SMS codes, password, Google, cookie sessions, dashboards, two-step for sensitive roles, sign-out everywhere (tests/auth.test.ts 43/43)
- [x] B2 Members (2026-10-18): create/edit/move/notes/payments/ID/archive, queues, duplicates, center changes, import check + import, /member/me (tests/members.test.ts 52/52)
- [x] B3 Website + portal (2026-10-18): join with proven email, applications, payment states, renewals, records, leadership, public masjids/ZIP placement, newsletter (tests/website.test.ts 37/37)
- [x] B4a Help desk + Team tasks (2026-10-18): src/modules/helpdesk.ts on app.hd_* / app.tasks* with the work.ts rules (tests/helpdesk.test.ts 70/70)
- [x] B4b Events (2026-10-18): document → app.events projection, registrations under a seat lock, waitlist, codes server-side, cancel links, refunds, check-in, CSV, approval for masjid roles, reminders (tests/events.test.ts 68/68)
- [x] B4c Giving, fundraising, finance (2026-10-18): gifts (cash/check entry, platform import, reconcile, deposits, receipts, refunds, Check-o-matic, member history), campaigns + personal pages + pledges, ledger with approval levels, two signatures, Board limit, Art. XII, restricted transfers, statements, donations → ledger (tests/giving.test.ts 77/77)
- [x] B4d Zakat (2026-10-18): website / portal / in-person intake routed by ZIP, checks + home visit, Zakat / Sadaqah decision, approvals in levels with the Chair's override, return / reject, monthly payouts → ledger, separation of duties also in the database, member status view (tests/zakat.test.ts 52/52)
- [x] B4e Voter list, elections, officials (2026-10-18): frozen voter list with versions, reasons and SHA-256 fingerprint (rechecked by the database), nominations checked against the records, portal nominations, ballot → voting → count → tie-break → certification, swearing-in into Elected officials with the history; officials projected to app.official_terms (tests/governance.test.ts 54/54)
- [x] B4f Groups and communication (2026-10-18): groups projected (manual from the document, automatic kept as rows), join / leave / ask, requests, preferences, signed unsubscribe links, bulk email and texts with audience, skips and checks, scheduled sends, group leaders' email (tests/comms.test.ts 48/48)
- [x] B5a Jobs and providers (2026-10-18): worker (`npm run worker`), daily jobs once per organization and date, outbox drained through email / text providers (log, Postmark, SendGrid, Resend, Twilio – chosen by env), retries, suppression of bounced / STOP numbers, delivery webhooks, renewal lifecycle emails (tests/jobs.test.ts 31/31)
- [x] B5b Online payments (2026-10-19): POST /public/checkout for dues, event registrations and gifts; Stripe (plain fetch, a key per organization) or the fake provider; signed webhooks applied once (paid / expired / failed / refunded) (tests/checkout.test.ts 30/30)
- [x] B6a SaaS platform API (2026-10-19): staff sign-in (code + password), panel state, new organizations with starter documents (no ISGH people), all organization actions, versioned panel documents, invoices, invitations accepted on the organization's address, support sign-ins (read-only enforced), own domains (TXT check) (tests/platform.test.ts 70/70)
- [x] B6b Templates and per-organization settings (2026-10-19): starter content per template for every document (never ISGH's name, places, people, keys or numbers), member ID prefix per organization (ISGH: HOU), the organization's own time zone for every date, zones from the organization's own map (tests/tenancy.test.ts 35/35)
- [x] B6c Files and deployment (2026-10-19): signed uploads / downloads (local or any S3-compatible store, SigV4 checked against AWS's example), areas with permissions, sizes and types, private photo IDs deleted after 30 days, audited downloads; Dockerfile, docker-compose, .env.example, deploy/test.sh, README (tests/files.test.ts 29/29)

## Next (in order)
- [x] API on the new tables (2026-10-19): members columns, projections, and the v0 tickets retired – /admin/tickets* answers 410 with the help-desk and task addresses, /public/tickets is an alias that files a help-desk ticket (app.tickets kept, no longer written)
- [x] ZIP loader (2026-10-19): `npm run geo:load -- <file>` for the Census ZCTA Gazetteer and city lists (merged, never blanking); the website's ZIP check says where a ZIP is and offers the nearest masjids (tests/geo.test.ts 8/8)
- [ ] Download the files once on the server (census.gov Gazetteer 2023 ZCTA + a ZIP→city list) and run geo:load; ISGH's zone ZIP lists from its Zones map
- [x] C1–C3 Apps on the API (2026-10-19): trusted edge header (x-org-host / x-client-ip only with EDGE_KEY), website content via /site/documents, member sign-in + member home (/member/portal), join + card page, forms; admin sign-in with the second step, documents through the API with the admin's server checks, organization panel, invitations (tests: site 26, documents 16, tenancy 45; tools/live-check web 35 + admin 25) – memory/connect-apps.md
- [x] C4 Admin modules on the API (2026-10-19): members + queues, help desk + tasks, events, giving + campaigns + ledger, Zakat, elections + voter list, messages, minutes, benefit uses – each store turns a change into its API call (memory/connect-apps.md); BE: activity, requester reply, screen ids for tasks / projects, election guard on publish, meetings and benefit uses API (0027) (tests: members 60, helpdesk 78, documents 21, records 13; tools/live-check admin 102)
- [x] C5 Website member pages on the API (family tree, directory, minutes), ISGH values from settings (complaint zones, admin zone / plan / masjid labels, no 0-place seats), work-queue decisions shared by the office, the member app on the API (`/app/*`, tokens, 0028–0030) (tests: portal 23, app 69, app-contracts 37 – the app's own code; tools/live-check web 38 + admin 106) – memory/connect-apps.md, api-contract-mobile.md
- [ ] Pick the providers: email (Postmark / SendGrid / Resend), texts (Twilio), card payments (Stripe) – keys go in the server environment
- [ ] Stripe Billing for the platform's own invoices (the panel marks them paid / void today)
- [ ] Deployment: put the API + worker on the server (Docker files ready), managed PostgreSQL, CI running deploy/test.sh
