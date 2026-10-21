# BE → Web public API (must implement in phase 3)

> Consumer: `web` (Next.js). Contract in web code: `web/src/lib/site-config/schema.ts`, `web/src/lib/theme/theme-css.ts`.
> Full description: `../../web/memory/api-contract.md`. **Do not change shapes without updating both.**

| Endpoint | BE module | Admin screens that feed it |
|---|---|---|
| `GET /public/site-config` | B7 CMS + B2 Settings/Flags | CMS Menus, Announcements, Footer; Settings Organization; Feature flags (public ones only); active website theme |
| `GET /public/theme` | B7 (theme) | Website theme editor A8 (draft → approve → publish/schedule; contrast-checked) |
| `POST /public/newsletter/subscriptions` | B8 Notifications + B11 email gateway | Marketing › Subscribers |

## Rules
- Public endpoints: no auth, rate-limited, return only published content and **public** flags
- Include `version` (published config version id) for audit/cache busting
- On publish, call the web revalidation hook with tag `site-config` or `theme` (to build in B7)
- Validate theme contrast server-side too (same pairs as web `CONTRAST_PAIRS`)
- Newsletter: store email (citext), consent text + version, timestamp, IP, source; send double opt-in; idempotent per email


## Added 2026-10-13 – endpoints the website now calls (must implement)
| Endpoint | BE module | Notes |
|---|---|---|
| `GET /public/pages/home` | B7 CMS | shape = web `src/lib/content/home.ts` (zones with centers list, images with alt + credit) |
| `GET /public/pages/{slug}` | B7 CMS | blocks: heading, paragraph, list, callout, faq, facts, cta, contact; status draft/published |
| `GET /public/news?limit=` | B7 CMS | slug, title, date, excerpt |
| `GET /public/membership/settings` | B2 Settings + B4 Plans | plans (price cents, unit, term, class, maxYearsAhead, discount ≤ Bylaws cap), recordDate, ages, commitments, pledge (versioned), consents (versioned), payerRelationships, OTP, flags |
| `POST /public/auth/otp/start` / `verify` | B1 Auth | hashed codes, expiry, rate limits per email/IP, returns `existingMember`; session cookie httpOnly |
| `POST /public/residency/lookup` | B6 Residency | geocode + PostGIS zone polygons; `nearBorder` (≤ 5 miles setting) + alternatives; `estimate` false when exact |
| `POST /public/membership/applications` | B3/B4/B5 + B11 Stripe | re-validate all rules, recompute price, store consents/pledge versions + signature, payer relationship, spouse invite, create Stripe Checkout → `{applicationId, checkoutUrl}`; status pending approval |


## Added 2026-10-13 – layout & design settings
- site-config.theme: add `defaultMode` (light/dark/system)
- pages/home: add `layout` (classic/zones), `sections` (ordered keys: stats, bento, steps, plans, life, journey, houston, closing), `classicHero {title, lead}`


## Planned public endpoints (website forms in demo mode, 2026-10-13)
- `POST /public/feedback` – store rating/topic/comment/email; reference FB-######; admin dashboard of ratings
- `POST /public/complaints` – reference CMP-######; categories from settings; anonymous allowed; SLA (default 5 business days); confidential; audit
- `POST /public/membership/verify` – member ID + last name + ZIP; returns status only; strict rate limit + logging

## Planned – Google sign-in (2026-10-13)
- `GET /auth/google/start` → Google consent; `GET /auth/google/callback` → verify ID token, create/link account, session cookie; response tells the website `{ existingMember, profile: { email, firstName, lastName } }`.

## Added 2026-10-13 – footer fields in site-config
`footer.cta`, `footer.tagline`, `footer.hours`, `footer.hoursLabel`, `footer.mapUrl`. "Was this page helpful?" posts to `POST /public/feedback` with topic `Page /path`.

## Added 2026-10-13 – branding uploads
Admin upload endpoint (auth, role: brand admin) stores files in media storage, sanitizes SVG, validates size/square, generates icon set with sharp (16/32/48 ico, 180, 192, 512, maskable, 1024) + web manifest, returns URLs; site-config.branding updated on publish with a new `version`.

## Added 2026-10-13 – giving content + donations (planned)
`GET /public/giving` – shape in web/memory/api-contract.md. BE publish rules: a `story` needs consent `written` or `anonymized`; `program`/`event` needs `source`; anonymized needs never return names/addresses; `sample` items are never returned in production unless the admin flag `showSamples` is on; `raisedCents`/`donors` are computed from donations (not typed by hand).
`POST /public/giving/donations` – validate amount ($5–$50,000), fund must be `sadaqah` unless the need is `zakatEligible`, idempotency key, Stripe Checkout/PaymentIntent, receipt email (tax receipt), recurring via Stripe subscriptions for `monthly`.
Tables (proposed): giving_verses, giving_impact, giving_needs, donations, donation_allocations, consents (file upload of signed consent).

## Planned – member home (W5)
`GET /member/me` (shape in web/memory/api-contract.md); eligibility computed server-side from Bylaws rules (approved, age on record date, commitment, residency, own dues paid by record date or Life, ID verified flag). Receipts: `GET /member/receipts/{id}.pdf`. Wallet passes: `GET /member/card/apple.pkpass`, Google Wallet save link. Sign-out: `POST /auth/logout`.

## SaaS (2026-10-15)
Every endpoint above is **per organization**: the edge resolves the Host (`<slug>.nextgrow.pro`, a verified own domain, or ISGH's member-web) to an org and the API answers for that org only. A new org without published content gets its template's starter content. See `saas-architecture.md`.

## 2026-10-21 – pages v2 (O1)
- `pages` document: new optional page fields `scope`, `template`, `seo`, `visibility`, `status` (5 states), `publishAt`, `unpublishAt`, `owner`, `reviewedAt`; 30 block types
  (see web `src/lib/content/pages.ts`). Storage unchanged (opaque JSON); publish projection unchanged. Later (O1.5): per-masjid editor scopes + review state on the admin side.
