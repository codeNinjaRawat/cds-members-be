-- 0037 People page on 10k+ people: the lookups it makes per person
CREATE INDEX IF NOT EXISTS registrations_email ON app.registrations (org_id, email);
CREATE INDEX IF NOT EXISTS contacts_email ON app.contacts (org_id, email);
CREATE INDEX IF NOT EXISTS contacts_seen ON app.contacts (org_id, last_seen_at DESC);
