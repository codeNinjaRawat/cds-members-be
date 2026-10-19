# BE ↔ admin – Reports and voter list (A9 → B9)

Source of truth for the numbers: `admin/src/lib/reports/reports.ts` (pure functions; the BE must return the same results).

## Endpoints
- GET /admin/reports/membership?year= → membershipSummary
- GET /admin/reports/dues?year= → duesReport (not-renewed list includes phone/email: role scope "members:contact")
- GET /admin/reports/area-reps?year=&ratio=40&rounding=down|up → areaReps
- GET /admin/reports/candidates?year= → candidates (years in good standing; a year counts only if approved by that year's record date)
- GET /admin/reports/events → eventsReport (actual payments instead of the estimate)
- Every report: `?format=csv` using csvCell (formula-safe).

## Voter list (Bylaws Art. I §2)
- POST /admin/elections/{year}/voter-list {reason?} → snapshot after the record date only (409 before). Version 1 needs no reason; later versions need ≥10 characters.
- Table voter_list_versions(org_id, year, version, taken_at, taken_by, reason, fingerprint) + voter_list_rows(org_id, year, version, member_id, name, zone, center) – append-only (no UPDATE/DELETE grants), RLS by org.
- fingerprint = SHA-256 hex of the sorted member IDs joined by "\n" – published with the list so anyone can check it.
- GET …/voter-list/{version}.csv – ID, name, zone, center only (never DOB, phone, email). Audit every download.
- GET …/voter-list/diff?from=1&to=2 → diffSnapshots.
- Non-voters (appeals): GET …/non-voters → nonVoters (first rule not met + reason).
- Approved after the record date: listed separately for the Election Commission (approvedAfterRecord).

## Module dashboards (added 2026-10-16, admin) – demo only in FE for now
`GET /admin/dashboards/{module}?period=30d|90d|year|12m&ahead=0|1&zone=<id>&masjid=<name>`
module = members | queues | communication | masjids | events | meetings | elections | website | zakat | donations |
finance | benefits | officials | fundraising.
- Server applies the caller's scope first (masjid / zone / ZIP assignment), then the filters; a scoped role asking for
  another area gets 403. Returns totals only: `{ tiles: [{id,label,value,note}], charts: [{id,title,head[],rows[][]}],
  attention: [{text,href,level}] }` – no personal data.
- Export uses the same response (`?format=csv`), logged in the audit log as "Downloaded CSV".
- Permissions = the module's page permission (permissionForPath); /masjids/dashboard and /elections: members.view.
