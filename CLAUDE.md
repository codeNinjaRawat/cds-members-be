# Instructions for AI assistants

OWNER STORY: Masajid Solutions (masajidsolutions.com) owns this product – one SaaS for all masjids; ISGH is one client. Build for every tenant, never ISGH-only (../memory/00-COMPANY-AND-SAAS.md).

Before working in `BE`, read `memory/README.md` here and `../memory/README.md`
at the project root. Keep both updated and log changes in the changelogs.

All user-facing text must follow `../memory/09-content-style-guide.md` (American English, Houston TX formats).
Membership rules come from `../memory/10-membership-rules.md`.

CURRENT PHASE: development (Owner said "start the BE work" on 2026-10-18). B0 foundation is built – see README.md and memory/05-progress.md for the order of the next modules.

Golden rules: admin controls everything (no hard-coded business values – use settings/flags);
research note before any feature; black-box + white-box tests and a test report before delivery;
start with `../memory/00-START-HERE.md`.
Build order: Web UI → Admin UI (glass) → BE (SQL) → integration → mobile, in small approved modules (../memory/17-build-order-and-modules.md).
