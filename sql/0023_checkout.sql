-- 0023 Online payments (B5b). One row per checkout the website opens (dues, an event registration, a gift); the
-- provider's webhook finds it by the session id and applies the payment exactly once.
CREATE TABLE IF NOT EXISTS app.checkout_intents (
  org_id          uuid NOT NULL REFERENCES platform.organizations(id) ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('dues', 'event', 'gift')),
  ref             text NOT NULL DEFAULT '',                 -- payment ids (dues), REG-… (event), '' (gift)
  amount_cents    integer NOT NULL CHECK (amount_cents > 0),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,       -- what to record when it is paid (gift: donor, fund, campaign…)
  provider        text NOT NULL,
  session_id      text NOT NULL,
  payment_ref     text NOT NULL DEFAULT '',                 -- the provider's payment id once paid (refunds find it)
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'expired', 'failed', 'refunded', 'partially_refunded')),
  refunded_cents  integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS checkout_session ON app.checkout_intents (provider, session_id);
CREATE INDEX IF NOT EXISTS checkout_payment ON app.checkout_intents (provider, payment_ref) WHERE payment_ref <> '';
SELECT app.tenant_table('app.checkout_intents');
-- webhooks have no organization: they find the intent through this (platform role only)
CREATE OR REPLACE FUNCTION platform.intent_org(p_provider text, p_session text, p_payment text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT org_id FROM app.checkout_intents WHERE provider = p_provider AND ((p_session <> '' AND session_id = p_session) OR (p_payment <> '' AND payment_ref = p_payment)) LIMIT 1
$$;
REVOKE ALL ON FUNCTION platform.intent_org(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.intent_org(text, text, text) TO app_platform;
