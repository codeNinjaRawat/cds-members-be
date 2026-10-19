-- 0021 Groups and communication API (B4f). Groups stay in the `groups` document; app.groups / app.group_members are
-- its projection (manual members from the document, automatic members kept by the nightly job, join requests as rows).
-- A bulk message keeps the message as written (`spec`); deliveries are one row per person with the reason a person was skipped.
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS topic text NOT NULL DEFAULT 'announcement';
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS spec jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS skipped jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS group_id text NOT NULL DEFAULT '';            -- a group leader's message
ALTER TABLE app.groups ADD COLUMN IF NOT EXISTS spec jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app.groups DROP CONSTRAINT IF EXISTS groups_who_can_join_check;
ALTER TABLE app.groups ADD CONSTRAINT groups_who_can_join_check CHECK (who_can_join IN ('staff', 'ask', 'anyone', 'admins', 'open', 'request'));
