# Database schema map (PostgreSQL 16) – 2026-10-18

106 tables in 3 schemas: `platform` (23 – the SaaS panel), `geo` (4 – shared places), `app` (79 – every organization's
data, each with `org_id` + Row Level Security ENABLED and FORCED). Migrations in `sql/` run in name order once each
(`npm run migrate`); ISGH's own data is a separate seed (`npm run seed:isgh` → `sql/seed/isgh.sql`).

Every file was applied on a fresh PostgreSQL 16 and again on a database seeded with the demo (320 members):
`tests/rls.sql` 8/8, `tests/rls_all.sql` 20/20 (79 tenant tables checked), API black-box 43/43, re-running every
migration is harmless. Run: `npm run test:sql` (needs `DATABASE_URL`).

## Build order (what the owner asked: SaaS → city → masjid → members → everything else)
| File | What it holds |
|---|---|
| 0001_foundation | organizations (first version), documents + versions, members (first version), payments, v0 tickets, audit log, RLS |
| 0002_platform | **SaaS**: `saas_plans` (starter/growth/network), organizations extended (client_no – ISGH = 1 and guarded, type, address, billing, legacy hosts, sample flag), reserved slugs, `org_modules`, `org_domains` + `org_for_host()`, global `users`, `org_admin_users` (one owner), `invitations` (token hash only), `flags` + `flag_orgs`, `announcements`, `staff`, `settings`, `support_sessions`, append-only `audit`, `invoices` (Stripe mirror), `org_usage_daily`, `effective_modules()`; helpers `app.tenant_table()` / `app.platform_table()` |
| 0003_geography | **City**: `geo.countries`, `geo.states` (all US), `geo.cities`, `geo.postal_codes` (ZIP with a point; the full list is loaded by a script), `geo.miles()`; per organization `app.org_cities`, `app.zones` (GeoJSON boundary ready for the Zones map), `app.zone_zips` (one zone per ZIP), `zone_for_zip()` |
| 0004_masjids | **Masjid**: `app.centers` (address, point, services, kind masjid/musalla/office, "name to confirm"), `center_zips` (one masjid per ZIP, must be in the masjid's zone – trigger), `home_for_zip()` ZIP → masjid → zone, `nearest_centers()`, `center_jumuah`, `center_contacts`, working body `center_positions` + `center_assignments` |
| 0005_members | **Members + primary sort** (below), `counters`/`next_no()`, `membership_plans` (projection of the published document), `households`, `relationships` (both family-tree layers), `memberships` (one row per term → status and paid_through kept by trigger), payments extended (id, status, processor, receipt), `applications`, `id_checks` (purge date), `center_changes`, `duplicate_pairs`, append-only `consents`, `member_notes`, view `member_list` |
| 0006_access | `platform.permissions` (36 keys), `app.admin_roles` (Owner must keep all), `app.admins`, `app.admin_assignments` (main + more roles; zone / masjid / ZIP scope; expiry; seat), `app.can()`, `app.in_scope()`, sign-in: `login_codes` (hashed, 10 min, 5 tries), `passwords` (argon2 hash), `sessions` (hashed cookie, active org + dashboard, two-step, support session), `sign_in_events` |
| 0007_groups_communication | `groups`, `group_members`, `contact_prefs`, `messages`, `deliveries` (per person, skip reasons), `notices` (in-app) |
| 0008_events | `events` (approval, promotion, group-only), `event_ticket_types`, `event_codes` (server only), `registrations` (waitlist), `registration_guests` (check-in), view `event_fill` |
| 0009_giving_finance | `funds` (one Zakat fund), `giving_accounts` (Stripe/PayPal/Zeffy/Medina per org or masjid, last 4 only), `donors`, `campaigns`, `campaign_pages`, `donations` (platform ref unique, reconciliation state), `recurring_gifts` (Check-o-matic), `pledges`, `payouts`, view `giving_by_member_year`; finance `finance_accounts`, `ledger` (approvals, Art. XII decision), `budgets`, `statements` |
| 0010_zakat | `zakat_cases`, append-only `zakat_steps` (trigger: one approval per person, approver cannot pay), `zakat_payouts` (monthly help) |
| 0011_governance | `official_terms` (current + history by year; one serving office per member), `elections`, `election_seats`, `nominations`, `election_results`, append-only `voter_snapshots` + `voter_snapshot_rows`, `voter_fingerprint()` (SHA-256) |
| 0012_helpdesk_tasks | `hd_tickets`, append-only `hd_events`, `hd_links`, `hd_auto_close()`; `task_projects`, `tasks` (checklist, repeat, links), append-only `task_comments` |
| 0013_content | `files` (object-storage index), `records`, `meetings`, `iqamah`, `special_prayers`, `benefit_partners` / `benefit_offers` / append-only `benefit_uses`, `imports`, `platform.jobs` (one job queue) |

## Members: the primary sort
Every member list, export and report is ordered **masjid → zone → status → last name → first name → member number**
unless the admin picks another column:
```sql
SELECT * FROM app.member_list ORDER BY center_sort, center_name, zone_sort, status_rank, sort_name, member_no;
```
- `center_id` / `zone_id` are real links (the old text columns `center` / `zone` are filled from them for the current API).
- A new or moved member is placed by ZIP (ZIP → masjid → zone) unless staff placed them by hand (`center_override`).
- `member_no` per organization starts at 100001 (`app.counters`); the organization's own id (HOU-204781) stays `id`.
- `status` (pending / active / life / expired / resigned / expelled / archived) and `paid_through` follow the
  `memberships` rows; `status_rank` puts active first.
- Indexes: `(org_id, center_id, status, sort_name, member_no)`, `(org_id, zone_id, status, sort_name)`, `(org_id, status, sort_name)`.

## Rules the database itself enforces (not only the API)
Tenant isolation on all 79 tables · founding client (client #1) cannot be deleted or cancelled · reserved slugs ·
one owner per organization · one zone per ZIP, one masjid per ZIP, the masjid's ZIP inside its zone · Owner role keeps
every permission, unknown permissions refused · one serving elected office per member (secretaries / area reps
excepted) · Zakat: the same person cannot approve twice or pay what they approved · append-only audit, consents,
help-desk thread, task comments, Zakat steps, voter snapshots, benefit uses · a done task has a done date · money is
whole cents, bank numbers last 4 digits only.

## Still to do (API side)
The API (src/http/server.ts) still reads the 0001 tables; next: move tickets to `hd_*`, write members through the new
columns, project `admin-access` / `membership-settings` / `donation-settings` / `org-structure` into their tables on
publish, B1 sign-in on `login_codes` / `sessions`, and load `geo.postal_codes` from the Census ZCTA file.
