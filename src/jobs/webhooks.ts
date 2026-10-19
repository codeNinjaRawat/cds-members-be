/**
 * Provider webhooks (no organization in the address – the outbox row a provider id belongs to tells us whose it is).
 *   POST /webhooks/email/:provider   postmark | sendgrid | resend – delivered, bounced, complained, opened, clicked
 *   POST /webhooks/sms/twilio        delivery status, and replies: STOP / UNSUBSCRIBE … → no more texts; START → texts again
 * Authentication: email webhooks carry EMAIL_WEBHOOK_TOKEN (header x-webhook-token, or the password of basic auth –
 * Postmark's way); Twilio requests are signed with the account token (X-Twilio-Signature, HMAC-SHA1). Every event is
 * kept once in platform.webhook_events, so a provider's retries change nothing twice.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/sql.js';
import { one, rows } from '../db/sql.js';
import { HttpError, PLATFORM, type Req, type Res } from '../http/core.js';

type Ev = { id: string; ref: string; address: string; kind: 'delivered' | 'bounced' | 'complained' | 'opened' | 'clicked' | 'unsubscribed' | 'other'; hard: boolean };
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function emailAuth(req: Req) {
  const want = process.env.EMAIL_WEBHOOK_TOKEN;
  if (!want) { if (process.env.AUTH_DEV_HEADER === '1') return; throw new HttpError(503, 'Webhooks are not configured.'); }
  const basic = String(req.headers.authorization ?? '').replace(/^Basic /, ''); const pw = basic ? Buffer.from(basic, 'base64').toString().split(':').slice(1).join(':') : '';
  const got = String(req.headers['x-webhook-token'] ?? '') || pw;
  if (!got || !same(got, want)) throw new HttpError(401, 'Not signed.');
}
function parse(provider: string, req: Req): Ev[] {
  const b = req.body as any;
  if (provider === 'postmark') {
    const t = String(b?.RecordType ?? '');
    const kind: Ev['kind'] = t === 'Delivery' ? 'delivered' : t === 'Bounce' ? 'bounced' : t === 'SpamComplaint' ? 'complained' : t === 'Open' ? 'opened' : t === 'Click' ? 'clicked' : t === 'SubscriptionChange' ? 'unsubscribed' : 'other';
    return [{ id: String(b?.ID ?? `${b?.MessageID}:${t}`), ref: String(b?.MessageID ?? ''), address: String(b?.Email ?? b?.Recipient ?? '').toLowerCase(), kind, hard: kind === 'bounced' && ['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated'].includes(String(b?.Type ?? 'HardBounce')) }];
  }
  if (provider === 'sendgrid') {
    return (Array.isArray(b) ? b : []).map((e: any) => {
      const k = String(e.event ?? ''); const kind: Ev['kind'] = k === 'delivered' ? 'delivered' : k === 'bounce' || k === 'dropped' ? 'bounced' : k === 'spamreport' ? 'complained' : k === 'open' ? 'opened' : k === 'click' ? 'clicked' : k === 'unsubscribe' || k === 'group_unsubscribe' ? 'unsubscribed' : 'other';
      return { id: String(e.sg_event_id ?? `${e.sg_message_id}:${k}`), ref: String(e.sg_message_id ?? '').split('.')[0], address: String(e.email ?? '').toLowerCase(), kind, hard: kind === 'bounced' && e.type !== 'blocked' };
    });
  }
  if (provider === 'resend') {
    const t = String(b?.type ?? ''); const kind: Ev['kind'] = t === 'email.delivered' ? 'delivered' : t === 'email.bounced' ? 'bounced' : t === 'email.complained' ? 'complained' : t === 'email.opened' ? 'opened' : t === 'email.clicked' ? 'clicked' : 'other';
    return [{ id: String(req.headers['svix-id'] ?? `${b?.data?.email_id}:${t}`), ref: String(b?.data?.email_id ?? ''), address: String((b?.data?.to ?? [])[0] ?? '').toLowerCase(), kind, hard: kind === 'bounced' }];
  }
  throw new HttpError(404, 'Unknown provider.');
}
const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, opened: 3, clicked: 4, bounced: 9, complained: 9, failed: 9 };

export async function handleWebhook(db: Db, req: Req): Promise<Res> {
  const m = req.path.match(/^\/webhooks\/(email|sms)\/([a-z]+)$/); if (!m || req.method !== 'POST') throw new HttpError(404, 'No such webhook.');
  if (m[1] === 'email') {
    emailAuth(req); let handled = 0;
    for (const e of parse(m[2], req)) {
      const fresh = await one(db, PLATFORM, `INSERT INTO platform.webhook_events (provider, event_id, kind, payload) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING RETURNING event_id`, [m[2], e.id, e.kind, JSON.stringify(req.body ?? {})]);
      if (!fresh || e.kind === 'other' || !e.ref) continue;
      const o = await one<{ org_id: string; ref: string; to_address: string }>(db, PLATFORM, `SELECT org_id::text, ref, to_address::text FROM platform.outbox WHERE provider_ref = $1 OR provider_ref LIKE $1 || '.%' LIMIT 1`, [e.ref]);
      if (!o?.org_id) continue;
      const API = { org: o.org_id, role: 'app_api' as const }; const address = e.address || o.to_address;
      if (o.ref.startsWith('msg:')) {
        const cur = await one<{ status: string }>(db, API, 'SELECT status FROM app.deliveries WHERE message_id = $1::uuid AND address = $2', [o.ref.slice(4), address]);
        if (cur && (RANK[e.kind] ?? 0) > (RANK[cur.status] ?? 0)) await db.run(API, [{ sql: 'UPDATE app.deliveries SET status = $3, at = now() WHERE message_id = $1::uuid AND address = $2', params: [o.ref.slice(4), address, e.kind] }]);
      }
      if ((e.kind === 'bounced' && e.hard) || e.kind === 'complained' || e.kind === 'unsubscribed')
        await db.run(API, [{ sql: `INSERT INTO app.contact_prefs (org_id, address, channel, bounced, unsubscribed) VALUES ($1::uuid, $2, 'email', $3::boolean, $4::boolean)
          ON CONFLICT (org_id, channel, address) DO UPDATE SET bounced = app.contact_prefs.bounced OR EXCLUDED.bounced, unsubscribed = app.contact_prefs.unsubscribed OR EXCLUDED.unsubscribed, updated_at = now()`, params: [o.org_id, address, e.kind === 'bounced', e.kind !== 'bounced'] }]);
      handled++;
    }
    return { status: 200, body: { ok: true, handled } };
  }
  if (m[2] !== 'twilio') throw new HttpError(404, 'Unknown provider.');
  const token = process.env.TWILIO_TOKEN;
  if (token) {
    const url = `${process.env.PUBLIC_API_URL ?? ''}${req.path}`; const p = (req.body ?? {}) as Record<string, string>;
    const sig = createHmac('sha1', token).update(url + Object.keys(p).sort().map((k) => k + p[k]).join('')).digest('base64');
    if (!same(String(req.headers['x-twilio-signature'] ?? ''), sig)) throw new HttpError(401, 'Not signed.');
  } else if (process.env.AUTH_DEV_HEADER !== '1') throw new HttpError(503, 'Webhooks are not configured.');
  const b = (req.body ?? {}) as Record<string, string>;
  const id = String(b.MessageSid ?? b.SmsSid ?? ''); if (!id) throw new HttpError(400, 'No message id.');
  const fresh = await one(db, PLATFORM, `INSERT INTO platform.webhook_events (provider, event_id, kind, payload) VALUES ('twilio', $1, $2, $3::jsonb) ON CONFLICT DO NOTHING RETURNING event_id`, [`${id}:${b.MessageStatus ?? 'inbound'}`, b.MessageStatus ?? 'inbound', JSON.stringify(b)]);
  if (!fresh) return { status: 200, body: { ok: true, handled: 0 } };
  if (b.Body !== undefined && b.From) {
    // a reply: STOP words end texts for every organization that texted this number; START brings them back
    const word = b.Body.trim().toUpperCase(); const digits = b.From.replace(/\D/g, '').slice(-10);
    const stop = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(word); const start = ['START', 'UNSTOP', 'YES'].includes(word);
    if (!stop && !start) return { status: 200, body: { ok: true, handled: 0 } };
    const orgs = (await rows(db, PLATFORM, `SELECT DISTINCT org_id::text FROM platform.outbox WHERE channel = 'sms' AND right(regexp_replace(to_address, '\\D', '', 'g'), 10) = $1 AND org_id IS NOT NULL`, [digits])) as { org_id: string }[];
    for (const o of orgs) {
      const API = { org: o.org_id, role: 'app_api' as const };
      const ms = (await rows(db, API, `SELECT id, email FROM app.members WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1`, [digits])) as { id: string; email: string }[];
      await db.run(API, [
        { sql: `INSERT INTO app.contact_prefs (org_id, address, channel, unsubscribed) VALUES ($1::uuid, $2, 'sms', $3::boolean) ON CONFLICT (org_id, channel, address) DO UPDATE SET unsubscribed = EXCLUDED.unsubscribed, updated_at = now()`, params: [o.org_id, digits, stop] },
        ...ms.map((x) => ({ sql: `INSERT INTO app.consents (org_id, member_id, email, kind, version, given) VALUES ($1::uuid, $2, $3, 'sms', 'reply', $4::boolean)`, params: [o.org_id, x.id, x.email, start] })),
      ]);
    }
    return { status: 200, body: { ok: true, handled: orgs.length } };
  }
  const o = await one<{ org_id: string; ref: string; to_address: string }>(db, PLATFORM, `SELECT org_id::text, ref, to_address::text FROM platform.outbox WHERE provider_ref = $1 LIMIT 1`, [id]);
  if (o?.org_id && o.ref.startsWith('msg:')) {
    const status = ['delivered'].includes(b.MessageStatus) ? 'delivered' : ['failed', 'undelivered'].includes(b.MessageStatus) ? 'failed' : '';
    if (status) await db.run({ org: o.org_id, role: 'app_api' }, [{ sql: `UPDATE app.deliveries SET status = $3, at = now() WHERE message_id = $1::uuid AND address = $2`, params: [o.ref.slice(4), o.to_address, status] }]);
  }
  return { status: 200, body: { ok: true, handled: 1 } };
}
