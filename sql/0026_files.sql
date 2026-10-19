-- 0026 Files (B6c). Uploads go straight to object storage (S3-compatible) with a short-lived signed address; this
-- table is the index: what it is, whose it is, who may see it, and when it must be deleted (photo IDs do not stay).
ALTER TABLE app.files ALTER COLUMN sha256 DROP NOT NULL;
ALTER TABLE app.files ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'deleted'));
ALTER TABLE app.files ADD COLUMN IF NOT EXISTS member_id text;
ALTER TABLE app.files ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.files ADD COLUMN IF NOT EXISTS ref text NOT NULL DEFAULT '';            -- what it belongs to: a record id, ZKT-…, T-…
CREATE INDEX IF NOT EXISTS files_member ON app.files (org_id, member_id) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS files_purge ON app.files (purge_after) WHERE status <> 'deleted' AND purge_after IS NOT NULL;
