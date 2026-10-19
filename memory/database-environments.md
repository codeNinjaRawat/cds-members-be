# Database environments – where the BE's data lives and how to point at it (2026-10-19)

| Name | Where | Database / user | Used by | How the BE reaches it |
|---|---|---|---|---|
| **local** | your PC's own PostgreSQL | `membership` / `postgres` (BE/.env) | `npm run dev`, `start-live.cmd`, tests | `BE/.env` (no profile) |
| **server-dev** | membership server 3.18.46.122, PostgreSQL 18 | `membership_dev` / `membership_dev_owner` | shared development data; pgAdmin "ISGH DEV" | profile `server-dev` → `BE/.env.server-dev` |
| **live** | same server | `membership` / `membership_owner` | the real platform (not yet) | on the server: env of the API process, `127.0.0.1`, no profile file |

Passwords are chosen and kept by the owner (🔑) – never in git, memory or chats. `BE/.env*` files are git-ignored
(except `*.example`). The server DB setup itself: `04-decisions-log.md` 2026-10-19 (incl. the open-port security to-do).

## Profiles (src/load-env.ts + src/env-file.ts)
- `--env=<name>` on the command line or `BE_ENV=<name>` → reads `BE/.env.<name>` first, then `BE/.env` for the rest.
  Order of precedence: terminal > profile > .env. The script prints `env: profile "x" → database user@host:port/db`
  (never the password) and warns when a DATABASE_URL typed in the terminal overrides the profile.
- `BE/.env.server-dev.example` = template (committed). `BE/.env.server-dev` = your copy with the 🔑 DEV password.

## Commands (Windows PowerShell or any shell, from BE/)
| Command | Does |
|---|---|
| `npm run server-dev:check` | read-only health check: reachable, encrypted, version ≥ 16, roles, extensions, migrations, app_api switch – with a "→ what to do" line for each problem |
| `npm run server-dev:migrate` | apply sql/*.sql (once each) |
| `npm run server-dev:seed` | ISGH (client #1) starter documents + fictional demo members |
| `npm run server-dev:test-sql` | tests/rls.sql + rls_all.sql through the pg driver (no psql needed); **refuses any database not ending in _dev/_test** |
| `npm run dev:server-db` | the API on http://localhost:4330 using the server's DEV data |
| `start-live-server-dev.cmd` (membership folder) | everything live on this PC (API, website, admin, panel) with the DEV data on the server |
| `npm run db:check` / `npm run db:test-sql` | the same checks for whatever BE/.env points at |
| `npm run test:db-config` | white-box tests of the settings logic (26 checks, no database) |

## Encryption (src/db/sql.ts – one meaning for both adapters)
`DATABASE_SSL` (or `sslmode=` in the address; the variable wins): `disable` (default; same machine) · `require`
(encrypted, certificate not checked – the server currently uses PostgreSQL's own self-signed certificate) ·
`verify-full` (+ `DATABASE_SSL_CA`) once the server has a real certificate. Reason: the pg driver treats
`sslmode=require` as "verify the certificate" (fails on self-signed) and psql does not know `no-verify`.
Also: `DATABASE_POOL_MAX`, `DATABASE_CONNECT_TIMEOUT_MS` (10 s – an unreachable server fails fast),
`DATABASE_APP_NAME` (shown in pgAdmin → Dashboard → Sessions); a dropped idle connection is logged, not fatal.

## Before go-live
Close 5432 to the world (SSH tunnel or fixed IPs), give the API its own login (not the owner), `verify-full` with a
real certificate, and a live profile only on the server (never on a PC).
