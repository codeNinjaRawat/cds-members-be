/**
 * The outbox worker: everything the API wants to send (sign-in codes, receipts, replies, bulk messages…) is a row in
 * platform.outbox; this drains it through the configured providers. Rows are claimed (so two workers never send the
 * same row), addresses that bounced or replied STOP are suppressed, failures are retried up to 5 times, and a bulk
 * message's delivery rows follow (queued → sent / failed).
 */
import type { Db } from '../db/sql.js';
import { rows } from '../db/sql.js';
import { PLATFORM, document } from '../http/core.js';
import { emailProvider, smsProvider, type EmailProvider, type SmsProvider } from './providers.js';
import { CommunicationSchema, mockCommunication } from '@/lib/community/communication';

const MAX_TRIES = 5;
type Row = { id: string; org_id: string | null; channel: 'email' | 'sms'; to_address: string; subject: string; body: string; kind: string; ref: string; attempts: number };
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const html = (text: string) => esc(text).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join('');

export async function drainOutbox(db: Db, opts: { limit?: number; email?: EmailProvider; sms?: SmsProvider } = {}) {
  const email = opts.email ?? emailProvider(); const sms = opts.sms ?? smsProvider();
  const claimed = (await rows(db, PLATFORM, `UPDATE platform.outbox SET claimed_at = now() WHERE id IN (
      SELECT id FROM platform.outbox WHERE sent_at IS NULL AND status = 'queued' AND attempts < ${MAX_TRIES} AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes') ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING id::text, org_id::text, channel, to_address::text, subject, body, kind, ref, attempts`, [opts.limit ?? 200])) as Row[];
  const senders = new Map<string, { fromName: string; replyTo: string }>();
  const senderOf = async (org: string | null) => {
    if (!org) return { fromName: process.env.MAIL_FROM_NAME ?? 'Masjid Solutions', replyTo: process.env.MAIL_FROM ?? 'notices@example.org' };
    if (!senders.has(org)) { const p = CommunicationSchema.safeParse(await document(db, org, 'communication')); const c = p.success ? p.data : mockCommunication; senders.set(org, { fromName: c.sender.fromName, replyTo: c.sender.replyTo }); }
    return senders.get(org)!;
  };
  let sent = 0, failed = 0, suppressed = 0;
  for (const r of claimed) {
    // bounced addresses and STOP replies are never sent to again (sign-in codes by email still go: the person asked for them)
    const blocked = r.org_id ? (await rows(db, { org: r.org_id, role: 'app_api' }, `SELECT 1 AS x FROM app.contact_prefs WHERE channel = $1 AND address = $2 AND (bounced OR ($1 = 'sms' AND unsubscribed))`, [r.channel, r.channel === 'sms' ? r.to_address.replace(/\D/g, '').slice(-10) : r.to_address])).length > 0 : false;
    if (blocked && !(r.channel === 'email' && r.kind === 'sign-in-code')) {
      await db.run(PLATFORM, [{ sql: `UPDATE platform.outbox SET status = 'suppressed', error = 'Address bounced or opted out', claimed_at = NULL WHERE id = $1::bigint`, params: [r.id] }]);
      await follow(db, r, 'skipped', '', 'bounced or opted out'); suppressed++; continue;
    }
    try {
      const s = r.channel === 'email' ? await email.send({ to: r.to_address, subject: r.subject, text: r.body, html: html(r.body), ...(await senderOf(r.org_id)), tag: r.kind }) : await sms.send({ to: r.to_address, body: r.body });
      await db.run(PLATFORM, [{ sql: `UPDATE platform.outbox SET sent_at = now(), status = 'sent', provider = $2, provider_ref = $3, attempts = attempts + 1, error = '', claimed_at = NULL WHERE id = $1::bigint`, params: [r.id, r.channel === 'email' ? email.name : sms.name, s.ref] }]);
      await follow(db, r, 'sent', s.ref); sent++;
    } catch (e) {
      const last = r.attempts + 1 >= MAX_TRIES;
      await db.run(PLATFORM, [{ sql: `UPDATE platform.outbox SET attempts = attempts + 1, error = $2, claimed_at = NULL, status = CASE WHEN $3::boolean THEN 'failed' ELSE 'queued' END WHERE id = $1::bigint`, params: [r.id, String((e as Error).message).slice(0, 500), last] }]);
      if (last) await follow(db, r, 'failed', '', String((e as Error).message).slice(0, 200));
      failed++;
    }
  }
  return { claimed: claimed.length, sent, failed, suppressed };
}
/** A bulk message's delivery row follows its outbox row. */
async function follow(db: Db, r: Row, status: string, ref: string, reason = '') {
  if (!r.org_id || !r.ref.startsWith('msg:')) return;
  await db.run({ org: r.org_id, role: 'app_api' }, [{ sql: `UPDATE app.deliveries SET status = $3, provider_ref = $4, skip_reason = $5, at = now() WHERE message_id = $1::uuid AND address = $2 AND status = 'queued'`, params: [r.ref.slice(4), r.channel === 'sms' ? r.to_address.replace(/\D/g, '').slice(-10) : r.to_address, status, ref, reason] }]);
}
