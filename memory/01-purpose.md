# Backend (API) – Purpose

Serves **saas** (platform panel), **web** and **admin** – for **every organization** on the platform (SaaS since 2026-10-15). ISGH is client #1, the founding client. Full design: `saas-architecture.md`.

## Responsibilities
- REST API (or tRPC – TBD) for members, plans, payments
- Authentication and roles (member, admin)
- Database and migrations
- Payment gateway integration and webhooks
- Emails (welcome, renewal reminders)
- Scheduled jobs (expiry checks)
- Input validation shared with frontends (Zod schemas)

## Settings, flags, environments (added 2026-10-13)
- **Settings service**: typed, versioned, scoped (global/zone/center/plan/year), effective-dated; maker-checker approvals; audit; rollback; impact preview
- **Feature flag service**: per environment, targeting (zone/center/% /test users)
- **Rules engine reads settings** – no business numbers in code
- **CMS backend** (product TBD after research)
- **Environments**: local / dev / staging / production; `.env.example`; settings export/import and promotion

## Build order & data (2026-10-13)
Phase 3: BE modules B0–B10 after admin UI approval, built to match the approved UI mock data shapes.
SQL/PostgreSQL, query layer, migrations, seeding, data migration – `../../memory/19-database-and-data.md`.

## Integrations (2026-10-13)
Integrations hub (B11): SMS + email provider adapters with fake adapters, Stripe adapter, signed webhooks, message/payment logs, reconciliation – `../../memory/20-integrations.md`.

## SaaS / multi-organization (2026-10-15)
- Platform layer (module **B12**):
  - organizations (tenants) with a **client number** – ISGH = 1
  - SaaS plans, modules and add-ons
  - beta rollouts and announcements
  - support sign-ins
  - platform staff and audit
  - own domains
  - Stripe Billing for the platform
- Every tenant table carries `org_id`, enforced by PostgreSQL Row Level Security. The tenant comes from the session (admin) or the host (public). Never from the browser.
- Contracts: `api-contract-platform.md` (SaaS panel + org admin), `api-contract-web.md` (public, now per org).
