# BE ↔ admin – admins, roles, scopes, audit (A10 → B-auth)

Source of truth: `admin/src/lib/access/access.ts` (PERMISSIONS, BUILT_IN_ROLES, AccessSchema, can, inScope, permissionForDoc, permissionForPath, accessWarnings).

## Data
- admin_roles(org_id, id, name, description, permissions text[], zone_scoped bool, built_in bool) – built-in rows are read-only.
- admin_users(org_id, id, name, email citext unique per org, role_id, zones text[], status invited|active|suspended, two_step bool, last_active date, expires_on date null).
- Rules (same as AccessSchema): ≥1 active owner; owner role keeps every permission; zone-scoped roles need zones (others none); with requireTwoStepFor = sensitive|everyone, active admins with sensitive permissions must have two-step; one email per org.

## Every request
- Session → admin → role. `can(doc, admin, permission, today)` on every endpoint (403 with the missing permission name). Suspended, invited or expired (expires_on < today) → no access.
- Zone-scoped admins: member queries add `zone = ANY(admin.zones)` (also in exports, reports, groups, messages audiences).
- Without `members.contact`: phone, email, street, birth date are removed from responses (age and city stay).
- Document publishes: permissionForDoc(key). Voter-list snapshots: voters.freeze. Refunds: payments.refund.

## Audit (append-only table, no UPDATE/DELETE grants)
audit_log(org_id, at, admin_id, admin_name, area members|content|export|voters|messages|access|events|payments, action, detail, target, ip).
Written for: publishes, member changes, approvals, payments/refunds, imports/archives, every export (rows + filters), voter-list snapshots, messages sent/scheduled, admin and role changes, sign-ins and failed sign-ins. GET /admin/audit?area=&who=&q=&from=&to= (admins.manage) + CSV.

## Platform link
The SaaS panel's invitations (owner/admin/editor/viewer) create admin_users with roles owner/admin/website-editor/viewer.
