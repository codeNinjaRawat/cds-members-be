# BE → Member app (iOS/Android) API (built 2026-10-19, C5)

> Consumer: `mobile/` (Expo, `APP_MODE=live`). Shapes: `mobile/src/data/contracts*.ts` (zod) – the BE suite
> `tests/app-contracts.test.ts` runs the app's own client, token manager and schemas against the API, so a shape the app
> cannot read fails there. Server: `BE/src/modules/app.ts`. **Change both sides together.**

## Organization and errors
- The app has no address of its own: every call sends `X-Org: <slug>`, accepted on `/app/*` only (websites are placed
  by their address). A token belongs to one organization; another `X-Org` with it is signed out.
- Errors: the usual `{error, detail, code}` plus `message` and `fields {field: text}` (the app's form errors). 401 →
  the app refreshes once; 409 conflict; 422 fields; 429 too many.
- Writes take `Idempotency-Key`: the same key again (one day) gets the first answer, nothing happens twice.

## Sign-in
| Endpoint | Body | Answer |
|---|---|---|
| `POST /app/auth/otp/start` | `{channel: email|sms, value}` | 202 `{sentTo (masked), channel, resendAfterSec}` – a member gets a sign-in code, a new email a join code; the answer is the same |
| `POST /app/auth/otp/verify` | `{channel, value, code}` | member: `{tokens{accessToken, refreshToken, expiresAt ms}, existingMember: true, firstName}` · new email: `{tokens: null, existingMember: false, joinToken}` |
| `POST /app/auth/token/refresh` | `{refreshToken}` | a new pair; each refresh token works once – an old one used again signs that chain out (401) |
| `POST /app/auth/logout` | `{allDevices}` | this phone, or every sign-in of this person in this organization (website too) |
Access token = a member session (`platform.sessions`, method `app`) for 15 minutes, sent as `Authorization: Bearer`.
Refresh tokens: `platform.app_refresh_tokens` (sha-256 only), 60 days. Phones: `app.member_devices`.

## Screens (Bearer unless marked public)
| Screen | Endpoint | Made from |
|---|---|---|
| App start (public) | `GET /app/bootstrap` | organization, site-config (names, support, announcement), sign-in and membership settings (flags, code rules), links; `app{minVersion…}` from APP_MIN_VERSION / APP_LATEST_VERSION / APP_STORE_IOS / APP_STORE_ANDROID |
| Home, card | `GET /app/me` | /member/portal + /member/renewal; `card.qr` = `MS1.<org>.<memberId>.<expires>.<signature>` (5 minutes) – the office checks a scanned card with `POST /admin/member-card/check {token}` |
| Notices | `GET /app/notifications` · `POST /app/notifications/read {ids|'all'}` | app.member_notifications (renewal started, registered…) |
| Renew | `GET /app/renewals/options` · `POST /app/renewals/quote` · `POST /app/renewals {planId, years, payerId, pledgeVersion, method}` | membership settings, priceFor + checkoutTotal; POST /member/renewal + /public/checkout → `checkoutUrl`. Plan changes stay with the office (409). An old pledge version is refused (409); the pledge is stored as a consent. |
| Payments | `GET /app/payments` | dues payments (every status), gifts (/member/giving), paid event registrations; `statements: []` for now |
| Household | `GET /app/household` · `POST /app/household/invites {email}` | spouse link, relationships; the invite is an email with the join link (3 a day) |
| Profile | `GET /app/profile` · `PATCH /app/profile {phone?, street?, city?, zip?, preferred?}` | the name and email are the office's; editing follows Configuration › self-service |
| Masjid change | `POST /app/center-requests {reason, center?}` | with a masjid: a masjid-change request; without: a help-desk request for the office |
| Photo ID | `POST /app/id-checks {name, mime, bytes}` → `{fileId, upload{url, method, headers}}` · PUT the photo to `upload.url` · `POST /app/id-checks/:fileId/complete` | private file (area id-check, deleted after review); the member's ID check becomes "pending" |
| My masjid | `GET /app/masjid` | centers, today's times (dayTimes), Jumu'ah, who serves (officials), members' records |
| Prayer times | `GET /app/prayer-times` (public; the member's masjid when signed in) | prayer-times document + Jumu'ah |
| Masjids (public) | `GET /app/masjids` | active centers with a place (the ZIP code's middle until a pin is set) |
| Events | `GET /app/events` · `GET /app/events/:id` · `POST /app/events/:id/register {seats}` · `POST /app/events/:id/cancel` | /public/events + /member/events/registrations; the cheapest type open to the member; paid → `checkoutUrl` |
| Give | `GET /app/giving/options` · `POST /app/giving/donations {fundId, masjidId, amountCents, coverFee, monthly, method}` | Donation settings, live campaigns; /public/checkout (gift) → `checkoutUrl` |
| Benefits | `GET /app/benefits` | live offers of approved partners; codes only for current members on the offer's plans |
| Election | `GET /app/election` | /member/elections/:year (404 when none is planned) |
| Settings | `GET /app/preferences` · `PATCH /app/preferences` (the whole Preferences) | /member/preferences (newsletter, events topics), directory listing, push choices (stored), devices |
| My data | `POST /app/data-export` | an email to the member's own address with their record (once a day; photo IDs are never included) |
| Push / crashes | `POST /app/devices {pushToken, platform}` · `POST /app/crashes {reports[]}` (public) | app.member_devices · app.app_crashes |
| Family | `GET /app/family` · `POST /app/family {name, relation, birthYear}` | the website's family tree (/member/family), as the app lists it; relations: Spouse, Son, Daughter, Father, Mother, Brother, Sister |
| Community | `GET /app/community?q=` · `POST /app/groups/:id/join` | /member/directory + /member/groups (join or ask to join) |
| Check-O-Matic | `GET|PATCH /app/check-o-matic` · `POST /app/check-o-matic/pay-now` | membership rule "qualifying gifts" + the member's gifts; 404 when the rule is off |
| Join (public) | `GET /app/join/options` · `POST /app/residency {address}` · `POST /app/join/applications` | membership settings + join form; ZIP → masjid; the website's application (joinToken from verify) → tokens for the new member + `checkoutUrl` |

## Visitor mode (app branch `visitor-first`, planned 2026-10-20 – see mobile/memory/10-visitor-first-plan.md)
The app opens without a sign-in. Public (no token, `X-Org` only): `GET /app/bootstrap`, `GET /app/prayer-times`,
`GET /app/masjids`, `GET /app/events`, `GET /app/events/:id`, `GET /app/giving/options`, join routes, `POST /app/crashes`.
Member routes keep refusing without a session (401) – the app's guard is convenience, the API is the lock.
**BE change needed (step 6):** `POST /app/giving/donations` must accept a visitor: no token + `guest {name, email}` →
gift checkout with the donor's name/email (receipt emailed; no member row). With a token, `guest` is ignored.
**BE nicety (step 3):** `GET /app/masjids` lists the organization's main center first (sort `is_main` desc, name).

## Not yet
- Sending push notifications (tokens are kept; `APP_PUSH=1` once a sender exists). Google sign-in in the app.
- Year-end statements (PDF) – `statements` stays empty until the website has them.
