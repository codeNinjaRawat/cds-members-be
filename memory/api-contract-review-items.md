# API contract – items from the Owner review calls (2026-10-18)

Every rule below is configuration on an existing document; nothing is ISGH-only. ISGH's values ship as presets.

## Elected officials – history (E1)
- `history: Term[]` on `GET/PUT /admin/officials` (see web/src/lib/community/officials.ts `TermSchema`): one record per
  election year × position × person; `kind` may be `other` with the title as written. `website.pastLeadership` switch.
- `POST /admin/officials/history/check` – body `{ csv }` → `HistoryPlan` (same `planHistoryImport` as the browser);
  `POST /admin/officials/history` – body `{ terms: Term[] }` appends (ids made unique server-side).
- `GET /public/leadership` adds `past: { year, terms: { seat, name, term }[] }[]` from `publicPastLeadership()` when
  the switch is on (never Area Representatives, Secretaries or member IDs).

## Membership rules (P1–P3, J1–J3, A1)
- `membership-settings` document grew: `rules` (qualifyingGifts, lifetimeByDonation, household, approval),
  `identity` (name-must-match-ID note, policy, consent + version), `guide` (sign-up page), `legal` (Terms/Privacy links).
  Older documents parse (defaults). Validation in `MembershipSettingsSchema`.
- `GET /public/membership/settings` returns them; the join form sends `identityConsentVersion` with the application.
- Eligibility (`GET /admin/members/:id/eligibility`, voter list): when `rules.qualifyingGifts.enabled` and the member
  holds that plan, the dues check is `qualifiesByGifts(rule, recurringGifts, year)` – the BE reads the member's
  recurring gifts from Donations. `lifetimeByDonationReached()` flags donors for the lifetime plan (approval queue).
- Approval: `POST /admin/members/:id/approve` and the batch endpoint refuse with 409 and `approvalBlockers()` text
  when `rules.approval.requireFullPayment` / `requireIdCheck` are not met.
- Presets (`PLAN_PRESETS`, `STRUCTURE_PRESETS`) are client-side constants; loading one is an ordinary PUT.

## Member import (M1)
- `POST /admin/members/import/check` – body `{ csv, preset?, mapping? }` (preset id from `IMPORT_PRESETS`, mapping
  by heading) → the `planImport` result; `POST /admin/members/import` – body `{ rows, defaultPlan, withDuplicates }`.
  Active rows → approved + this year's dues as a payment record; Lapsed → approved, no payment; Pending → pending;
  Archived → archived. `externalId` is kept on the record (`externalIds: { wildapricot: '10234' }` suggested).

## Giving platforms (I1)
- `integrations.giving.accounts[]` (see admin/src/lib/integrations/integrations.ts): provider, scope organization /
  center, formUrl, keys (secrets in the secrets manager, last 4 in the document), lastSync.
- Webhooks: `POST /api/webhooks/:org/giving/:accountId` (signature by the account's secret). Sync job per account:
  gifts and payouts → Donations with `platform: 'zeffy' | 'paypal' | …` and `center` = the account's masjid.
- Donations `platforms` record gained `zeffy` (`ONLINE_PLATFORMS`).

## Records library (R1)
- New `records` document: `GET/PUT /admin/records` (write needs `center.content`; masjid roles may only write records
  of their masjid), `GET /public/records` (audience public only), `GET /member/records` (public + members),
  leaders-only records through `/admin/records` only. Files: `url` is a path in the organization's storage
  (`/files/...`, uploaded through the existing private-file endpoint) or an https link.
