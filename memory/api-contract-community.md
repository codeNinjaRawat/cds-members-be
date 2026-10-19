# BE ↔ website/admin – events, groups, communication, configuration, renewals (to implement)

> Status: demo built on 2026-10-15 (web + admin, demo store). The WildApricot options are rebuilt as settings and switches.
> **Contracts** (zod, the source of truth):
> - `web/src/lib/community/events.ts`
> - `groups.ts`, `communication.ts`, `org-config.ts`
> - `web/src/lib/content/membership.ts` (plan options + `lifecycle`)
>
> Copies are in `admin/src/lib/…`. Every table is a **tenant table**: it has `org_id` and Row Level Security (see `saas-architecture.md`).
> Research: `../../memory/research/wildapricot-options.md` and `wildapricot-walkthrough-2026-10-14.md`.

## 1. Membership plans and renewals (B4, B5)
| Contract | Tables / columns |
|---|---|
| `Plan.termPrices[] {years, priceCents}` | `plan_term_prices (org_id, plan_id, years, price_cents)` – a fixed price for several years (ISGH Family 1y $75 / 3y $180 / 5y $285) |
| `Plan.bundle.maxMembers` | `plans.bundle_max`; `memberships.bundle_id` + `bundle_members` (coordinator gets the invoice) |
| `Plan.renewal {anchor: calendar/join/date, anchorDate 'MM-DD', mode manual/automatic/both, prorate, aheadLimitDays}` | `plans.renewal_*`; Stripe subscription only when mode ≠ manual |
| `Plan.allowLevelChange` | `plans.allow_level_change` |
| `lifecycle {selfRenew, reminders[{daysBefore, createInvoice, setPendingRenewal}], notify, graceDays, graceAction, overdueDays, overdueAction (lapse/suspend/change-level/archive), overdueLevel, voidInvoice}` | `org_settings.lifecycle` (jsonb, validated with the same schema) |

**Job `renewal-lifecycle`** (daily, per org, idempotent – one run key per member and date):
- reminder days → create the invoice / set Pending renewal / send `renewal-reminder-1`, `renewal-reminder-2` and `renewal-day`
- at the end of the grace period → send `grace-notice`, or change the plan
- when overdue → lapse, suspend, change plan or archive; void the open invoice; send `lapsed-notice`
- every step writes the member audit log

The ISGH preset (`ISGH_WILDAPRICOT_LEVELS`) is also the **B10 migration map** for WildApricot levels:

| WildApricot level | Our plan |
|---|---|
| Individual | `individual` |
| Family 1 / 3 / 5 years | `family` with term prices |
| Lifetime | `life-individual` / `life-family` |
| Checkomatic | `checkomatic` |
| Unverified Members | `unverified` |

## 2. Events (B13 – new)
**Tables:**
- `events (org_id, id slug, title, summary, category, status, starts_at, ends_at, location_name, address, center_id, online_url, visibility public|members|groups, reminders int[], …)`
- `event_groups (event_id, group_id)`
- `event_reg_types (event_id, id, name, price_cents, guest_price_cents, availability everyone|members|code|plans, code_hash, plan_ids, limit, enabled)`
- `event_registrations (id, event_id, type_id, member_id null, name, email, guests, amount_cents, status registered|waitlisted|cancelled, waitlist_pos, payment_id, created_at)`
- `event_settings` (enabled, show_past, default_reminder_days)

**Endpoints:**

| Endpoint | Demo route |
|---|---|
| `GET /public/events` (visible ones only; groups-only only for members of those groups) | – |
| `GET /public/events/{id}` | – |
| `POST /public/events/{id}/registrations` | `/api/events/register` – same checks: `registrationState`, `typeAvailable`, guests, price, discount |
| `POST /public/events/{id}/registrations/{rid}/cancel` (signed link; `canCancel` rule) | – |
| `GET/PUT /admin/events` | – |
| `GET /admin/events/{id}/registrations` (+ CSV) | – |

**Rules the BE must keep:**
- Capacity is checked **inside a transaction** (`select … for update` on the event), so the last spot cannot be sold twice.
- When someone cancels, the first waitlisted person gets the spot and the `event-spot-open` email (and a payment link if the event is paid).
- Codes are stored hashed.

**Job:** `event-reminders` (hourly) sends `event-reminder` N days before. Emails: `event-registered`, `event-waitlist`, `event-spot-open`, `event-reminder`.

## 3. Groups (B3)
**Tables:**
- `groups (org_id, id, name, description, kind manual|automatic, join_policy admins|open|request, show_in_profile, leaders_can_email, page_access, archived)`
- `group_rules (group_id, field, op, value)`
- `group_members (group_id, member_id, added_by, added_at)` – manual groups only
- `group_leaders (group_id, email|member_id)`
- `group_join_requests`

Automatic groups are evaluated in SQL from member facts (zone, center, plan, status, voting this year, last payment method, age, year joined), using the same rules as `ruleMatches()`. Cache the counts nightly; work out the members live when an email is sent.

**Endpoints:**
- `GET/PUT /admin/groups`
- `GET /admin/groups/{id}/members`
- `POST /member/groups/{id}/join` (open groups) / `/request`

## 4. Communication (B8)
- **System emails:** `org_settings.communication` (sender, tracking, sms, system emails: enabled/subject/body/to). Templates live in `email_templates (org_id, id, name, category, subject, body, archived)`.
- **Merge fields:** only the keys in `MACROS` are allowed. The BE renders them the same way as `render()`; a missing value shows `[Label]` and is logged.
- **Sending:**
  - `email_messages` (per send: template/system key, audience: group/plan/status/list, counts)
  - `email_deliveries` (per recipient: delivered/opened/clicked/bounced – opens and clicks only if tracking is on)
  - shown in the Email log screen
- **Unsubscribe and consent:**
  - Bulk email needs the postal address footer (CAN-SPAM), which the schema checks.
  - Text messages are sent only with consent, outside quiet hours, and only for switched-on purposes. STOP replies are handled through the SMS adapter (B11).
- **Group leaders can email their group** only if both switches are on (`groupEmailsByLeaders`, `leadersCanEmail`). Their messages go through the same log.

## 5. Configuration (B2)
`org_settings.config` (validated with `OrgConfigSchema`). Public parts go out through `GET /public/config`: directory on/off and audience, payment methods, cover fees %, whether discounts are on. **Never** send the codes, profile-field access settings or security settings.

| Area | What the BE does |
|---|---|
| Directory | `GET /member/directory` – only members who opted in, only fields with access `members` (or `public` when audience = public). Opt-in is stored on the member: `members.directory_opt_in`. |
| Profile fields | `member_fields (org_id, id, label, type, options, required, access, member_editable, in_directory)` + `member_field_values` |
| | Access is enforced on every API (admins-only values are never in member or public responses) |
| Member card | Card image / PDF / Wallet passes (Apple / Google) generated on demand; QR signed with the org key. |
| Payments | Methods allowed per org; `check` + `checkPendingStatus` → payment status `check_pending` until an admin records it (work queue "Payments to fix"). |
| | Cover fees added as a separate gift line (tax receipt). |
| | Invoice number prefix per org. |
| Discount codes | `discount_codes (org_id, code citext, kind, value, applies_to, plan_ids, max_uses, used, ends_on, active)`; use counted in the same transaction as the payment. |
| Security | Admin 2-step sign-in required (B1); session timeout. |
| | Photo ID files: private object storage only (signed URLs, 5 min), deleted after `keepDays` by a job, and only with consent. This replaces today's public-IP image links. |

## 6. Website effects (already built in demo)
- `/events` and `/events/{id}`, with registration (waitlist, guests, codes, members-only types).
- **Join flow:** a choice of payment method, an optional fee cover, a discount code, and a "Check – waiting to clear" status. The server recomputes everything.
- **Member home:** card and Wallet buttons follow the switches; links to Events and to the Member directory (directory off by default).

### 1a. Renewal engine (added 15 Oct 2026 – use, do not re-implement)
Source of truth: `web/src/lib/content/renewal.ts` (pure TS, no clock). The BE must give the same answers:
- Member fields: `paid_through date null` (null = lifetime / never paid), `renewal_status` (active, renewal-due, grace, overdue, lapsed, suspended, archived, moved, lifetime, never-paid) computed by `standingOn(plan, lifecycle, paidThrough, today)` in America/Chicago.
- Payment → `termFor(plan, {start, years, saleYear: settings.year, current: paid_through, extendWithinDays: lifecycle.overdueDays})` gives `covers_from` / `covers_through`; store both on the payment row. Price = `priceFor(...)` (server recomputes; never trust the client).
- Renew button / API allowed only when `canRenew(...)`.ok (409 otherwise with the reason).
- Job `renewal-lifecycle` runs `timeline(...)` steps whose date = today; idempotency key (member, step kind, date).
- Voting: dues count only if `duesCoverVote(plan, {paidThrough, paidOn}, recordDate)`.ok – covers the record date AND paid on/before it.
- Settings writes are validated with `MembershipSettingsSchema` (now includes cross-field checks) → 400 with zod issues.

### 1b. Member records (added 15 Oct 2026 – review step 2)
Source of truth: `web/src/lib/community/member-records.ts`.
- `members.extra jsonb` (field id → value). Every write runs `checkValues(fields, input, who, before)`; members (`who='self'`) may only change fields with access ≠ admins and memberEditable; 422 with per-field errors.
- Reads filter with `fieldsFor(fields, viewer)` – never send admin-only values to the member portal or directory.
- Directory endpoint returns `directoryCard(cfg, person, viewer)` only (opt-in, no phone/email for visitors).
- `members.archived_at, archived_reason, archived_by` – archived rows excluded from lists, sign-in and voter lists; history kept.
- Duplicates: `findDuplicates` on join, import and admin create; unique index on (org_id, lower(email)).
- Import: POST /admin/members/import/check → `planImport` result; POST /admin/members/import {rows} re-runs the check server-side, creates Pending approval members, audit "Imported".
- Exports use `csvCell` (formula-safe); admin-only columns need an explicit flag and are logged.

### 3a. Groups (updated 15 Oct 2026 – review step 3)
Source of truth: `web/src/lib/community/groups.ts`.
- Group adds `match (all|any)`, `include[]`, `exclude[]`; Facts add `renewal` (renewal_status from the renewal engine). Archived members are never in a group.
- Settings writes: GroupsSchema (rule value checks) + `ruleIssues` warnings returned with the save.
- A group used by an event (`groupUsage`) cannot be deleted → 409, archive instead.
- Event registration and event detail: allowed only if `canSee(event, {signedIn, groupIds: accessGroupIds(groups, facts)})` – group events are never sent to anyone else.
- POST /member/groups/{id} {action: join|request|leave} → allowed only when `memberAction(group, isIn, requested)` returns that action; 409 otherwise. Requests stored in group_join_requests (admin approves / declines, leader notified).
- Nightly job recomputes automatic groups and logs joined / left.

### 4–5. Communication (updated 15 Oct 2026 – review steps 4 and 5)
Sources: `web/src/lib/community/communication.ts`, `web/src/lib/community/campaigns.ts`.
- Settings writes: CommunicationSchema now includes systemEmailProblems (fields per email, required fields, receipts always on, member must get, one-line subjects).
- Renewal job sends the email from `renewalEmails(lifecycle, comm)` for each step; skips (and logs) when that email is off.
- Every HTML email uses `renderHtml` (escaped member data). Subjects never contain CR/LF.
- POST /admin/campaigns {Campaign} → CampaignSchema + checkCampaign; recipients = resolveAudience(...) at SEND time (not when scheduled); store per-recipient rows; scheduled sends run from a queue in America/Chicago; cancel allowed until sending starts.
- members.prefs {email, sms, optOut[]}; PUT /member/preferences refuses opting out of 'membership'. Signed one-click unsubscribe links + List-Unsubscribe / List-Unsubscribe-Post headers (RFC 8058). SMS consent stored with timestamp and the exact consent text; STOP/HELP keywords handled by the SMS provider webhook.
- Bounces and spam complaints suppress the address; the email log comes from provider events (delivered, opened/clicked only when tracking is on).

### 6–8. Events, payments, security (updated 15 Oct 2026 – review steps 6–8)
Sources: `events.ts`, `payments.ts`, `org-config.ts` in web/src/lib/community.
- GET /public/events returns `publicEvents(doc)` (no codes, no drafts); group events only for their groups.
- Registration: seats = seatsFor(guests); registrationState(e, now, seats); typeAvailable(t, viewer, code, counts, seats) with live per-type counts; one registration per email per event (409).
- Cancellation: refundFor(e, paid, now) → refund via the payment provider; freed seats → promoteFromWaitlist (order kept) → "A spot opened up" email with a 48-hour hold.
- Check-in: POST /admin/events/{id}/registrations/{reg}/check-in (event day only, audit). GET …/calendar.ics uses toIcs.
- Every total: checkoutTotal (server). Invoices: invoiceNumber(prefix, year, seq) with a per-org yearly sequence; pay-later due = dueDate.
- payments.status follows PAYMENT_MOVES; only countsAsPaid extends paid-through; refunds checked with refundCheck.
- Receipts: buildReceipt (deductible split, IRS statement, EIN) as PDF + email.
- Security: admin sessions expire after security.sessionMinutes idle (server side); 2-step sign-in enforced when adminTwoStep; nightly job deletes ID files where idPurgeDue (keeps "verified on/by").
