# API contract – F4 Member benefits (demo built 2026-10-16)

Rules live in `web/src/lib/community/benefits.ts` (synced to the admin). The BE runs the same functions before every
write. Not the same as the dues/event discount codes in `org-config` (those lower what ISGH charges).

## Document
- `benefits` – GET/PUT /admin/benefits. Publish needs `benefits.manage` (Owner, Admin, Benefits coordinator).
  Shape `BenefitsSchema`: enabled, requireReview, showLocked, partners[], offers[]. Refines: unique ids, offer
  partner exists, percent 1–100, amounts > 0, shared code `^[A-Z0-9-]{3,20}$`, link https, until ≥ from; a live offer
  needs an approved partner (and a review date when requireReview) and may not end after the partner agreement; an
  approved partner needs an agreement end date.

## Member side
- GET /member/benefits – returns `memberSafe(doc)` only (no staff contacts, notes, reviewer names, drafts, paused
  offers or non-approved partners). The website lists them with `memberOffers(doc, facts, myUses, today)`.
  Facts come from the member record: plan, active (active or life), goodStanding (dues for this year or life).
- POST /member/benefits/{offerId}/use – server checks `offerState === live`, `eligibility`, `usage` (once / monthly /
  yearly), stores a Redemption (via `portal`) and returns how to use it: card / shared code / personal code
  `memberCode(memberId, offerId)` / partner link.
- Partner check: the existing Verify page (member ID + last name + ZIP, rate-limited) returns `partnerView` only –
  first name, last initial, active or not, valid through. Never address, phone, email or birth date.

## Use log (table `benefit_uses`, RLS by organization)
- GET /admin/benefits/uses?offer=&via= (benefits.manage) – member IDs only, no names.
- POST /admin/benefits/uses – office records a use (via `office`), same checks as the member endpoint. Audited
  (area `benefits`).

## Open with the owner
- Who does the suitability review (Board, Imam, committee). Real partner list. Whether locked offers should show.
