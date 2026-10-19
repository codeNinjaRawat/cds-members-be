# BE ↔ admin – integrations (A11 → B11)

Source: `admin/src/lib/integrations/integrations.ts`; background: `memory/20-integrations.md`.
- GET/PUT /admin/integrations – body = IntegrationsSchema WITHOUT secrets. Secrets travel only in
  PUT /admin/integrations/secret {integration, kind, value} → checkKey shape → stored encrypted (KMS / secrets manager) → returns {last4, setAt, setBy}. Never returned again.
- Permission `integrations.manage`. fourEyes(before, after, actor, approvers): a sensitive change is held as a pending change until a DIFFERENT admin with the permission approves it on their own session (409 otherwise). Audit both steps.
- Adapters: EmailProvider / SmsProvider / StripeAdapter + Fake; fallback provider used on 5xx/timeouts; per-org usage counters (SaaS plan limits).
- Webhooks: POST /api/webhooks/{org}/{email|sms|stripe} – verify signature with the stored secret, store raw event, idempotent by provider event id, then: bounces/complaints → suppress; STOP/HELP → consent off / help text; Stripe → payment state via PAYMENT_MOVES.
- Test sends: POST /admin/integrations/test {kind, to} – rate-limited (5/hour/admin), logged.
- Readiness: same readiness() over the stored settings + real DNS lookups (SPF/DKIM/DMARC TXT records) + provider API "account status".
