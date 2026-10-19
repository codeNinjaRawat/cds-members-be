# API contract – F3 Donations and Check-o-matic (demo built 2026-10-16)

Rules live in `web/src/lib/community/donations.ts` (synced to the admin). The BE imports the same functions and runs
them before every write; the admin hides what a role cannot do, the BE refuses it. Demo: no platform is called.

## Document
- `donation-settings` – GET/PUT /admin/donations/settings. Publish needs `finance.manage`. Shape:
  `DonationSettingsSchema` (funds, mainCenter, platforms {enabled, lastSync}, receiptAboveCents, checkomatic {mode,
  minCents, funds, countsAsDues}). Refines: unique fund ids, Check-o-matic funds exist, at least one fund unless off,
  countsAsDues only with mode `member`, one active Zakat fund. Platform keys are NOT here (Integrations, last 4 only).

## Gifts (table `donations`, RLS by organization; center-limited roles see only their centers)
- GET /admin/donations?fund=&platform=&center=&state= – list (`donations.view`).
- POST /admin/donations – cash or check entered by staff (`donations.reconcile`); server runs `entryProblems`
  (amount, fund, center, check number for checks, name or anonymous); id `D-NNNNN`, enteredBy = admin.
- PATCH /admin/donations/{id} – place (fund, donor), receiptSent, refunded (`donations.reconcile`). Audited
  (area `donations`).
- POST /admin/donations/payouts/{platform}/arrived – marks that platform's pending gifts with the payout id
  (live: comes from the platform's payout webhook / report instead).
- Webhooks: POST /hooks/stripe, /hooks/paypal, /hooks/medina, /hooks/bloomerang – verify signature, upsert by
  platform ref, fee from the platform, payout id when paid out. Unknown donor or fund → state "needs a fund or donor".

## Derived (same functions as the admin)
- `reconState`, `routedCenter` (fund route given/main/all), `netOf`, `needsReceipt` (≥ receiptAboveCents, not
  anonymous, not refunded), `donationStats`.
- Check-o-matic: `checkomatic(gift)` / `checkomaticDonors(list)` – qualifying gifts ≥ minCents to listed funds,
  valid until the next June 30. Mode `application` creates a membership application (Board approves); `member`
  approves directly; dues payment only if `countsAsDues`. Member created with source `import`, note and audit.

## Open with the owner
- Check-o-matic default (now: application, not dues). Real fund list and main center. Receipt wording (IRS).
