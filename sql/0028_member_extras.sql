-- 0028 The member's own family tree (member portal) – C5. Re-runnable.
CREATE TABLE IF NOT EXISTS app.member_families (
  org_id      uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  member_id   text NOT NULL,
  family      jsonb NOT NULL,                                   -- web/src/lib/family/family.ts Family (heritage stays private)
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, member_id),
  FOREIGN KEY (org_id, member_id) REFERENCES app.members(org_id, id) ON DELETE CASCADE
);
SELECT app.tenant_table('app.member_families');
