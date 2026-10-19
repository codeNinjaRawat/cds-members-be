-- 0020 Governance API (B4e). Elections and officials stay documents (`elections`, `officials`); the voter list is rows.
-- Officials are projected into app.official_terms (serving holders + the history), so "one elected office per member"
-- is also a database rule and reports can join terms with members.
ALTER TABLE app.voter_snapshot_rows ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE app.voter_snapshots ADD COLUMN IF NOT EXISTS fingerprint text NOT NULL DEFAULT '';   -- hex, as printed
ALTER TABLE app.official_terms DROP CONSTRAINT IF EXISTS official_terms_status_check;
ALTER TABLE app.official_terms ADD CONSTRAINT official_terms_status_check CHECK (status IN ('serving', 'vacant', 'ended'));
ALTER TABLE app.official_terms DROP CONSTRAINT IF EXISTS official_terms_source_check;
ALTER TABLE app.official_terms ADD CONSTRAINT official_terms_source_check CHECK (source IN ('admin', 'upload', 'election', 'manual', 'archived'));
ALTER TABLE app.official_terms ADD COLUMN IF NOT EXISTS zone_code text NOT NULL DEFAULT '';
ALTER TABLE app.official_terms ADD COLUMN IF NOT EXISTS center_name text NOT NULL DEFAULT '';
