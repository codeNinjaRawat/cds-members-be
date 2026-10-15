# Research – multi-tenant data for the SaaS (October 2026)

## Options compared
| Option | For | Against | Verdict |
|---|---|---|---|
| Database per tenant | Strong isolation, easy per-org restore | Many DBs to migrate/back up/pay for; heavy for small orgs | Later, only for a very large org (`db_shard`) |
| Schema per tenant | Good isolation | Migrations × N schemas, catalog bloat | No |
| **Shared schema + `org_id` + Row Level Security** | One migration, cheap, DB enforces isolation even if app code forgets a filter | Must set the tenant per transaction; policies must be tested | **Chosen** |

## Best practices we follow (from the sources)
- **Policies on every tenant table:**
  - `ENABLE` + `FORCE ROW LEVEL SECURITY`
  - policy `USING` and `WITH CHECK` on `org_id = current_setting('app.org_id')::uuid`
- Set the tenant with `SET LOCAL` / `set_config(..., true)` **inside the transaction**. This is safe with transaction pooling.
- **DB roles:**
  - the app role has no `BYPASSRLS` and is not the table owner
  - platform/reporting use a separate role, and its cross-org reads are audited
- `org_id` leads every index. Unique constraints are per org.
- Automated isolation tests in CI: cross-tenant read, write and count must all fail.

## Sources
- https://oneuptime.com/blog/post/2026-01-25-use-row-level-security-postgresql/view
- https://skylinecodes.substack.com/p/how-to-architect-a-multi-tenant-saas
- https://edana.ch/en/2026/06/25/ensuring-multi-tenant-data-isolation-with-postgresql-row-level-security-rls/
- https://medium.com/@anand_thakkar/row-level-security-rls-in-postgresql-for-multi-tenant-saas-apps-ef8c324031d0
- https://stackharbor.com/en/knowledge-base/pg-row-level-security-multi-tenant/
