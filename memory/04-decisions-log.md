# Backend (API) – Decisions Log

## 2026-10-13 – App created
- **Decision:** Separate `BE` folder with its own memory
- **Status:** Active

## 2026-10-13 – Admin controls everything; research-first; full testing
- **Decision:** Follow root decisions: Bylaws = defaults, all rules are admin settings/feature flags; research note before any feature; black-box + white-box testing and test report before delivery
- **Status:** Active

## 2026-10-13 – UI-first modular build order
- **Decision:** Web UI → Admin UI (glass) → BE (SQL) → integration → mobile; small modules, each approved
- **Status:** Active

## 2026-10-15 – SaaS: multi-organization platform; ISGH is client #1
- **Decision:**
  - One platform serves many organizations.
  - Shared PostgreSQL schema with `org_id` + Row Level Security (ENABLE + FORCE). The tenant is set per transaction with `SET LOCAL app.org_id`.
  - Separate `platform` schema/role for the SaaS panel.
  - ISGH is seeded as **client #1** (founding client, Network yearly, legacy hosts member-web / member-admin). A DB guard refuses to delete or cancel it, and B10 imports ISGH's members into ISGH's org.
- **Why:**
  - cheap to run for many small organizations
  - one migration path
  - isolation enforced by the database, not only by the code
- **See:** `saas-architecture.md`, `api-contract-platform.md`, `research/saas-multitenancy.md`
- **Status:** Active

## 2026-10-15 – Events, groups, communication, configuration, renewals
- **Decision:** Build the WildApricot options as org settings plus tenant tables (see `api-contract-community.md`). Event capacity is checked inside the payment transaction, and the waitlist gets the next free spot. Automatic groups are evaluated in SQL from member facts. The renewal lifecycle job is daily and idempotent. Photo ID files go to private storage with retention.
- **Status:** Active

## 2026-10-19 – Server PostgreSQL 18 on the membership server (3.18.46.122) – SECURITY TO-DO
- Installed PostgreSQL 18.6 (Ubuntu 26.04 offers only 18; BE was tested on 16 – run npm run test:sql against it). MySQL (election) + phpMyAdmin untouched.
- Databases: `membership` (live, owner membership_owner) and `membership_dev` (dev, owner membership_dev_owner); roles app_api / app_platform (NOLOGIN) granted to both owners; extensions pgcrypto, citext, pg_trgm; PUBLIC revoked. Passwords chosen and kept by the owner (not stored here).
- Remote: listen_addresses=*, pg_hba hostssl + scram-sha-256 for the two owners on their own DB only.
- **Owner decision: port 5432 open to 0.0.0.0/0 in AWS during development (dynamic IP). MUST be closed before go-live**: switch to SSH tunnel or allow only fixed server IPs; consider a separate low-privilege app login instead of the owner user for the BE.
