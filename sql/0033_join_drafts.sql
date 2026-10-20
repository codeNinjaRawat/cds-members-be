-- 0033 Join form drafts: a 30-day link to finish a saved application ('join-resume'), and a quick look-up of the
-- people who started the join form but did not finish (Work queues › Incomplete applications).
ALTER TABLE platform.login_codes DROP CONSTRAINT IF EXISTS login_codes_purpose_check;
ALTER TABLE platform.login_codes ADD CONSTRAINT login_codes_purpose_check CHECK (purpose IN ('sign-in', 'join', 'verify-email', 'verify-phone', 'two-step', 'staff', 'join-resume'));
CREATE INDEX IF NOT EXISTS members_unfinished ON app.members (org_id, lower(email::text)) WHERE record->>'joinStage' = 'incomplete';
