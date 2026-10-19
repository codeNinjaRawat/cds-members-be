# API contract – F2 Zakat and Sadaqah (demo built 2026-10-15)

Rules live in `web/src/lib/community/zakat.ts` (synced to the admin). The BE imports the same functions and runs them
before every write; the admin hides what a role cannot do, the BE refuses it.

## Documents
- `zakat-settings` – GET/PUT /admin/zakat/settings. Publish needs `zakat.settings`. Shape: `ZakatSettingsSchema`
  (levels 1–3 limits in cents, max request regular/emergency, response hours regular/emergency, recurring max months,
  sadaqah routing + fast threshold, home visit above, channels).

## Cases (table `zakat_cases`, RLS by organization; center-limited roles only see their centers)
- GET /admin/zakat/cases?status=&zone=&fund=&urgent= – list (needs `zakat.view`).
- POST /admin/zakat/cases – intake (`zakat.intake`), body = new case; server runs `intakeProblems`, routes by ZIP with
  `zoneForZip` (org-structure), assigns the first active center unless chosen; id `ZKT-YYYY-NNN`.
- POST /admin/zakat/cases/{id}/checks – documents / income / hardship, home visit (`zakat.verify`).
- POST /admin/zakat/cases/{id}/decision {fund: zakat|sadaqah|none} – `decideEligibility` after `verifyProblems` is empty.
- POST /admin/zakat/cases/{id}/request-info {note} – status info-requested.
- POST /admin/zakat/cases/{id}/approve {amountCents, note, override?} – `approve()`; level = the admin's role level;
  override needs `zakat.override`. One person approves a case once (since the last send-back).
- POST /admin/zakat/cases/{id}/return|reject {note} – `decline()`; note required.
- POST /admin/zakat/cases/{id}/payouts {method, ref} – `pay()`; needs `zakat.disburse`; whoever approved cannot pay.
  Monthly help: one payout per month until `months` payouts.
- Every change writes the audit log (area `zakat`). Applicant data is sensitive: contact details only for roles with
  zakat permissions in scope; exports logged.

## Public intake (next)
- POST /public/zakat/apply – website / app form (channel website|app), rate limited, OTP to the phone; creates status new.
