# Backend (API) – Tech Stack

> Inherits the shared stack in `../../memory/02-tech-stack.md`.

> **Status: NOT DECIDED** – options below, to be confirmed.

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
