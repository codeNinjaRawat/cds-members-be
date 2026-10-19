# Backend (API) – Memory

**New here? Read `../../memory/00-START-HERE.md` first.**

Memory for the **BE** app only. Shared, project-wide knowledge lives in
`../../memory/` (goals, overall stack, design system, testing strategy).

## Files
| File | What it holds |
|---|---|
| `01-purpose.md` | What this app does and its features |
| `02-tech-stack.md` | Libraries used in this app only |
| `03-how-to-use.md` | Folder structure and conventions for this app |
| `04-decisions-log.md` | Decisions specific to this app |
| `05-progress.md` | Done / in progress / next for this app |
| `06-changelog.md` | Dated record of changes |
| `api-contract-web.md` | Public endpoints the website already uses (must implement) – now per organization |
| `saas-architecture.md` | **SaaS design**: organizations, ISGH = client #1, RLS data model, platform tables, security, billing, jobs, demo → BE mapping |
| `api-contract-platform.md` | Endpoints for the SaaS panel and the org admin's platform calls |
| `api-contract-community.md` | Events, groups, communication, configuration, renewals (WildApricot options) – tables, endpoints, jobs |
| `database-environments.md` | local / server-dev / live databases, profiles (`--env=server-dev`), SSL setting, check + migrate commands |
| `research/` | Research notes – one per feature, written before building |

## Rules
1. Read this folder **and** `../../memory/` before working on this app.
2. App-only change → update here. Change that affects other apps → update root memory too.
3. Every change → one line in `06-changelog.md`.
4. Never delete decisions – mark them **Superseded**.
