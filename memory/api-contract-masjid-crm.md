# API contract – Masjid CRM (M1–M6) – 2026-10-16

Source of truth for shapes: web/src/lib/community/org-structure.ts, access.ts, sign-in.ts (synced to admin).

## Masjid by ZIP (M1)
- `GET/PUT /admin/org-structure` – centers carry `zips: string[]` (service area). Rules: a ZIP is served by one
  masjid; the ZIP must be in that masjid's zone. BE must enforce both.
- `GET /public/centers` returns centers with `zips` (public). Members' home masjid = centerForZip(member ZIP), unless
  an approved center change (centerOverride) says otherwise.

## Roles and assignments (M2)
- `GET/PUT /admin/access` – roles (+ `areaScoped`) and admins: main role (`roleId`, `zones`, `centers`, `zips`,
  `expiresOn`, `givenBy`) and `more: Assignment[]` (max 10). `memberId` links the person's own member record.
- Every endpoint checks the acting assignment: session → person → chosen dashboard index → role + scope.
  inScope(member) uses zone, center and ZIP (area roles see only their ZIPs inside their masjid).
- `PUT /admin/access` by a masjid leader (team.manage, no admins.manage): allowed only if every added/removed
  assignment passes cannotAssign (masjid roles only, own masjid, permissions ⊆ the leader's, never team.manage roles)
  and roles / organization settings are unchanged; people with roles elsewhere cannot be edited. Same check as
  teamChangeProblem(). Reset (DELETE) needs admins.manage. 403 with a plain message otherwise.
- Path guards: /team → team.manage; /settings/sign-in → settings.manage.

## Sign-in and dashboards (M4)
- `GET/PUT /admin/sign-in` (settings.manage) – SignInSchema. `GET /public/sign-in` – the same (no secrets).
- `GET /auth/dashboards` – from the session only (never an email in the request): list of
  `{ kind: member|organization|zone|masjid|area, label, role, where, index, adminId }` for active, unexpired
  assignments whose kind is enabled; membership first. No emails or member data.
- Choosing a dashboard: `POST /auth/dashboard { index }` sets it on the session (demo: cookie `isgh-dash`;
  website → admin hand-over `?as=&dash=` exists only in the demo and must not exist live).
- Methods: Google OAuth, email OTP, SMS OTP (needs SMS integration), password (optional; two-step still required
  for sensitive roles). Responses never reveal whether an email/phone has an account before the code is verified.

## Home pages (M5/M6)
- `GET /admin/home` returns numbers for the acting scope (masjid / area / zone / organization).
- `GET /member/me` includes home masjid (by ZIP), its office phone, and the public officials for that masjid/ZIP.

## M5 – home ZIP and the shared masjid filter (added 2026-10-16)
- `AdminUser.homeZip` (5 digits, '' only for Owners). Server rejects publishing an active non-Owner admin without a
  resolvable home ZIP once the org is out of demo mode (FE shows a warning today). Home masjid = centerForZip(homeZip).
- Every list endpoint accepts `?zone=<id>` and `?masjid=<name>` (or `masjid=~none` for unrouted records); the server
  intersects them with the caller's scope and returns 403 for an area the caller may not see. Counts/badges on the
  same screen come from the same filtered query.
