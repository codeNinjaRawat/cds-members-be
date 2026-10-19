# SaaS architecture – what the BE must build (source of truth for the BE)

> Status: **design agreed, demo running** (saas/, web/, admin/ in demo mode, 2026-10-15).
> The BE replaces the demo files in `.demo-store/_platform/` and `.demo-store/tenants/` with the database.
> Shapes come from `saas/src/lib/platform/platform.ts` (zod). **Do not change shapes without updating both.**

## 1. The model
| Term | Meaning |
|---|---|
| **Platform** | The product ("NextGrow Members" – name is a platform setting). Run by platform staff in the SaaS panel (`saas/`). |
| **Organization (tenant)** | One customer: its own website, admin, members, plans, Bylaws settings, payments. |
| **ISGH** | **Client #1 – the founding client.** Slug `isgh`, Network plan (yearly), joined 2026-09-01. Always present, cannot be cancelled. Keeps the addresses member-web / member-admin.nextgrow.pro. |
| **SaaS plan** | What an organization pays the platform (Starter / Growth / Network – demo prices). Limits + modules. Not the same as a *membership plan* (what a member pays the organization). |
| **Module** | Part of the product an org can use. Effective modules = plan + add-on − switched off − beta not rolled out. Website, Membership, Members are always on. |
| **Org admin user** | Staff of one organization (owner / admin / editor / viewer). Never sees the platform. |
| **Platform staff** | Platform owner / support / billing / read-only. Signs in to the SaaS panel only; may open an org admin with a **support sign-in**. |

## 2. Apps and addresses
| App | Address | Tenant |
|---|---|---|
| Website (all orgs) | `<slug>.nextgrow.pro`, verified own domain, ISGH: member-web.nextgrow.pro | from the **Host** header |
| Org admin (all orgs) | `<slug>-admin.nextgrow.pro`, ISGH: member-admin.nextgrow.pro | from the **Host** header |
| SaaS panel | saas.nextgrow.pro | none (platform scope) |
| API (BE) | api.nextgrow.pro (planned) | from the **signed-in user's org** for admin calls; from the **Host / `X-Org` resolved by the edge** for public calls |

Rules:
- Never trust a tenant id sent by the browser.
- An admin call's tenant always comes from the session (`org_id` in the token).
- A public call's tenant comes from the host, resolved server-side (same rules as `resolveHost()`).
- Reserved slugs and slug rules are in `platform.ts` (`RESERVED_SLUGS`, `slugProblem`).

## 3. Database (PostgreSQL) – shared schema + Row Level Security
- **One database, shared tables, `org_id uuid not null` on every tenant table**, with PostgreSQL **RLS**:
  ```sql
  alter table members enable row level security;
  alter table members force row level security;
  create policy org_isolation on members
    using (org_id = current_setting('app.org_id')::uuid)
    with check (org_id = current_setting('app.org_id')::uuid);
  ```
- The API sets the tenant **per transaction**: `select set_config('app.org_id', $1, true)` (= `SET LOCAL`). This is safe with PgBouncer transaction pooling.
- The app DB role has **no BYPASSRLS**. Platform jobs and the SaaS panel use a separate `platform` role. Every cross-org read is audited.
- Indexes: `org_id` is the first column of every composite index (e.g. `(org_id, last_name, first_name)`). Unique keys are per org, e.g. `unique (org_id, member_no)`.
- Why not one DB per tenant: dozens to hundreds of small orgs → shared schema is cheaper to run, migrate and back up. A very large org can later move to its own database (same schema; `orgs.db_shard` column reserved).
- Tests (B0 CI): a white-box test opens two orgs and proves org A cannot read, update or count org B's rows on every tenant table. It also proves that a query without `app.org_id` returns nothing.

### Platform tables (schema `platform`, no RLS, platform role only)
| Table | Key columns (→ zod in platform.ts) |
|---|---|
| `orgs` | id uuid, **client_no int unique** (ISGH = 1), slug citext unique, name, short_name, type, city, state, address, phone, email, timezone, color, status (trial/active/past_due/suspended/cancelled), saas_plan_id, billing_cycle, trial_ends_on, created_on, cancelled_on, template, suspended_reason, notes, legacy_web_host, legacy_admin_host, is_sample, db_shard |
| `org_modules` | org_id, module, value (on/off) – add-ons / switched off |
| `org_domains` | org_id, host citext unique, status (pending/verified/failed), verify_token, added_on, checked_on, cert_status |
| `org_admin_users` | id, org_id, user_id → `users`, role (owner/admin/editor/viewer), status (invited/active/revoked), invited_on, last_active_on; **one owner per org** (partial unique index `where role='owner' and status<>'revoked'`) |
| `invitations` | id, org_id, email citext, role, token_hash (sha-256, never the raw token), expires_at (7 days), accepted_at, revoked_at |
| `saas_plans` | id, name, tagline, price_monthly_cents, price_annual_cents, limit_members, limit_centers, limit_admins, limit_sms, modules text[], highlight, hidden, sort |
| `platform_flags` | key, label, help, module, rollout (off/some/all) + `platform_flag_orgs` (flag_key, org_id) |
| `platform_announcements` | id, title, body, tone, audience (all/plans/orgs), ids text[], starts_on, ends_on, active |
| `support_sessions` | id, org_id, staff_id, reason, mode (read-only/full), started_at, ends_at, ended_at |
| `platform_staff` | id, user_id, role (owner/support/billing/readonly), two_factor, active |
| `platform_settings` | single row: product_name, base_domain, support_email, support_hours, default_template, require_reason |
| `platform_audit` | id, at, staff_id / actor, action, org_id, detail, before jsonb, after jsonb – append-only, 7 years |
| `saas_invoices` | id (Stripe invoice id), org_id, period, issued_on, amount_cents, status (paid/open/failed/void), method – mirror of Stripe |
| `org_usage_daily` | org_id, day, members, centers, admins, sms_sent – feeds limits, health and the overview |

### Tenant tables (everything else gets `org_id` + RLS)
These tables are tenant-scoped:
- members, households, relationships (family trees)
- applications, ID checks, center-change requests, duplicates
- membership plans and dues (the org's own), payments
- settings and flags (per org)
- CMS docs (site-config, home, pages, news, giving, themes, join-form)
- notifications and audit (per org)

The settings service stays as designed (`01-purpose.md`), but every setting is now **scoped to an org first**: platform default → org → zone / center / plan / year.

## 4. Seeding and ISGH as client #1
- **Production seed (idempotent):**
  1. `saas_plans` (3 plans)
  2. `platform_settings`
  3. `platform_staff` (owner: Mohammad (demo))
  4. **`orgs` row for ISGH:**
     - `client_no=1`, `slug='isgh'`, Network, yearly, `created_on='2026-09-01'`
     - legacy hosts member-web / member-admin
     - `is_sample=false`
  5. ISGH's Bylaws defaults as its org settings.
  6. A first `platform_audit` line: "ISGH joined as client #1 – the founding client".
- A DB guard keeps ISGH:
  - a `before delete` trigger and a check refuse to delete or cancel `client_no = 1`
  - the API returns 409 like the demo does
- The sample organizations (`is_sample=true`) are seeded in **dev / staging only – never in production**.
- New org (`POST /platform/orgs`), in one transaction:
  1. insert the org (`client_no = max+1`) and its owner invitation
  2. copy the template's settings
  3. create starter CMS docs from the template (same rules as `web/src/lib/platform/seed.ts` – never ISGH facts)
  4. write the audit line
- **B10 data migration** imports the current system's members **into ISGH's org_id** (ISGH is a tenant like any other).

## 5. Security
- **B1 sign-in replaces the preview passwords.**
  - Users are global: one person may be an admin of two orgs.
  - The session holds the **active org**, and the API checks the role per org.
  - Platform staff need 2-step verification.
- **Support sign-in:**
  - can only be created by platform staff, with a reason
  - is time-limited (setting, default 2 h) and read-only by default
  - adds a banner in the org admin and is written to both audit logs (platform and org)
  - in "full" mode every change is stamped `via_support_session_id`
- **Suspended or cancelled org:**
  - admin writes return **423**
  - the public site shows "temporarily unavailable"
  - members' payments and data are kept
  - cancelled orgs are hard-deleted after 30 days by a job, after an export is offered
- **Own domains:**
  - the org adds CNAME → `orgs.<base>` and TXT `_nextgrow.<host>` = token
  - the BE verifies DNS, then requests the certificate (ACME)
  - the Host is only routed after `verified`
- **Rate limits and quotas are per org:**
  - SMS per month (plan limit)
  - member count (plan limit – soft warning at 90%, hard stop only on create)

## 6. Billing (Stripe Billing)
- One Stripe Customer per org; Subscription = SaaS plan + cycle; trial = `trial_end`.
- Webhooks (signed) update:
  - `orgs.status` (`invoice.payment_failed` → past_due; `paid` → active)
  - `saas_invoices`
- Plan change: upgrade is pro-rated at once; downgrade happens at renewal. It is refused when usage is above the new plan's limits (same rule as the demo).
- Platform money ≠ org money. Members' dues go to the **org's own** Stripe account (Stripe Connect – decision pending).

## 7. Jobs
| Job | When | What |
|---|---|---|
| trial reminders | daily | at 7 / 3 / 0 days left |
| usage snapshot | nightly | `org_usage_daily` |
| health score | nightly | same rules as `healthOf()` |
| domain check | hourly | for pending domains |
| support session expiry | every minute | ends sessions that ran out |
| cancelled-org purge | daily | after 30 days |

## 8. Mapping demo → BE
| Demo (today) | BE |
|---|---|
| `.demo-store/_platform/tenants.json` | `platform.orgs` + `org_modules` + `org_domains` + `org_admin_users` |
| `_platform/{plans,flags,announcements,settings,team}.json` | `saas_plans`, `platform_flags`, `platform_announcements`, `platform_settings`, `platform_staff` |
| `_platform/support.json`, `audit.json`, `invoices.json` | `support_sessions`, `platform_audit`, `saas_invoices` (Stripe) |
| `.demo-store/*.json` (ISGH) and `.demo-store/tenants/<slug>/*.json` | CMS docs with `org_id` (ISGH's org_id for the root files) |
| `tenantForHost()` in web/admin | edge/API host resolution + session org |
| `/api/platform/me` (admin) | `GET /admin/platform/me` |
| `/api/platform/invite` (admin) | `GET/POST /auth/invitations/{token}` (B1) |
