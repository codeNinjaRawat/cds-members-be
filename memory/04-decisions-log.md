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
