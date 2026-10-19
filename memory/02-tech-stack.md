# Backend (API) – Tech Stack

> Inherits the shared stack in `../../memory/02-tech-stack.md`.

> **Status: DECIDED 2026-10-18** – see the table at the end (B0 built).

| Area | Proposed option | Alternatives |
|---|---|---|
| Runtime / framework | Node.js + TypeScript (NestJS or Hono) | Next.js API routes, Express |
| Database | PostgreSQL | MySQL |
| Query layer | Drizzle ORM (SQL-first, typed) + raw SQL for reports | Prisma, Kysely |
| DB extensions | pgcrypto, citext, pg_trgm, PostGIS, pg_stat_statements | — |
| Migrations / seeding | Drizzle Kit migrations, idempotent seed scripts per environment | Prisma Migrate |
| Auth | Auth.js / JWT | Clerk, Supabase Auth |
| Validation | Zod | — |
| Payments | **Stripe (decided)** | — |
| SMS gateway | Provider TBD via adapter (Twilio, Telnyx, Vonage, AWS SNS …) | — |
| Email gateway | Provider TBD via adapter (SendGrid, Postmark, Amazon SES, Resend …) | — |
| API docs | OpenAPI / Swagger | — |
| Testing | Vitest + Supertest | Jest |
## Decided 2026-10-18 (B0)
| Area | Decision |
|---|---|
| Runtime | Node 22 + TypeScript, run with tsx (no build step); plain `node:http` router – a framework can be added later without touching the routes' logic |
| Database | PostgreSQL 16, schemas `app` (tenants) and `platform` (SaaS); Row Level Security ENABLE + FORCE; roles `app_api`, `app_platform` |
| Access | `SET LOCAL app.org_id` per transaction; policies `org_id = app.current_org()`; the audit log is append-only |
| Driver | `pg` (Pool, one transaction per call); `psql` adapter (`DB_ADAPTER=psql`) for sandboxes/CI without npm |
| Migrations | plain SQL files in `sql/`, applied once each by `src/db/migrate.ts` (`public.app_migrations`) |
| Validation | the shared zod contracts (`@/*` → `../admin/src/*`, synced from web) – the API never trusts the browser |
| Documents | one JSON row per organization × key with versions (what the admin publishes) – the same keys as the admin's `REGISTRY` |
| Tests | `tests/rls.sql` (white-box isolation), `tests/api.test.ts` (black-box HTTP), both runnable without npm |
| Still open | auth provider for B1 (own OTP + Google via OAuth), email/SMS adapters, hosting |
