-- Real data (10,000+ members, thousands of notes): the member list reads each member's notes, so look them up by member.
CREATE INDEX IF NOT EXISTS member_notes_member ON app.member_notes (org_id, member_id, at);
