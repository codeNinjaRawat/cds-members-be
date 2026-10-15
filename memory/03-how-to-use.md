# Backend (API) – How to Use

## Folder structure (planned)
```
BE/
  src/
    modules/
      auth/
      members/
      plans/
      payments/
      notifications/
    common/       middleware, guards, errors
    config/
    db/           schema, migrations, seed
  tests/
```

## SaaS additions (2026-10-15)
```
BE/src/modules/
  platform/      orgs (client_no), saas-plans, org-modules, domains, invitations, support-sessions, staff, announcements, flags, audit, billing (Stripe)
  tenancy/       host → org resolution, request org context, `SET LOCAL app.org_id`, RLS helpers + isolation tests
```
- Every query runs inside `withOrg(orgId, tx => …)`. Code without an org context cannot read tenant tables.
- Platform-only code uses the `platform` DB role and writes `platform_audit`.
