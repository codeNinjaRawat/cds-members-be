# BE ↔ SaaS panel / org admin – platform API (to implement)

> Consumers:
> - `saas/` – SaaS panel, platform staff only
> - `admin/` – the org admin, "me" and invitations
> - `web/` – host → org
>
> Shapes: `saas/src/lib/platform/platform.ts`. Demo routes in brackets. Every write → `platform_audit`.

## SaaS panel (platform staff, 2-step verification, role-checked)
| Endpoint | Demo route | Role | Notes |
|---|---|---|---|
| `GET /platform/state` (or split: /orgs, /plans, …) | `GET /api/platform/state` | any staff | tenants, plans, flags, announcements, settings, team, support, audit (300), invoices |
| `POST /platform/orgs` | `POST /api/platform/tenants` | owner, support | body = `NewOrgSchema`; 400 issues, 409 slug taken/reserved; returns org + invitation link |
| `POST /platform/orgs/{slug}/actions` | `POST /api/platform/tenants/{slug}` | per action | `{type: suspend\|restore\|cancel\|reactivate\|plan\|extendTrial\|convert\|paymentFixed\|module\|invite\|resend\|revoke\|role\|domain\|verifyDomain\|removeDomain\|support\|endSupport\|profile, …}` – rules in `saas/src/lib/platform/actions.ts`; **cancel of ISGH (client #1) → 409** |
| `GET/PUT /platform/docs/{plans\|flags\|announcements\|settings\|team}` | same under /api | owner (team, prices), support (announcements, flags) | `{data, baseVersion}` → 409 on version conflict; team must keep one active owner |
| `POST /platform/invoices/{id}` | `POST /api/platform/invoices` | owner, billing | `{status: paid\|void\|retry}` → Stripe API |

## Org admin
| Endpoint | Demo route | Notes |
|---|---|---|
| `GET /admin/platform/me` | `GET /api/platform/me` | `{productName, supportEmail, org{slug,name,shortName,status,color,plan,trialDaysLeft,suspendedReason}, modules[], announcements[], support, siteUrl}` – only the caller's org |
| `GET /auth/invitations/{token}` | `GET /api/platform/invite?token=` | 404 when not valid **for this org's address** |
| `POST /auth/invitations/{token}/accept` | `POST /api/platform/invite` | B1: sets password / passkey + 2-step; marks admin active; audit |
| all `/admin/*` writes | `/api/store/*` | **423** when the org is suspended or cancelled; 404 when the host is no org |

## Public (website)
- Every `/public/*` endpoint in `api-contract-web.md` is now **per org**: the edge resolves Host → org (`resolveHost` rules) and passes it to the API. Unknown host → 404 page "not in use"; suspended or cancelled → "temporarily unavailable".
- A new org has no published content yet → the API returns its **starter content** (template), never ISGH's.
