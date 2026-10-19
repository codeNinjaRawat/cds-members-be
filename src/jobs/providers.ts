/**
 * Email and text-message providers. The platform picks one of each with environment variables (the organization never
 * sees keys): EMAIL_PROVIDER = log | postmark | sendgrid | resend, SMS_PROVIDER = log | twilio. `log` sends nothing (it
 * is the default for development and tests) and returns a reference so the whole flow can be followed.
 *   postmark  POSTMARK_TOKEN            sendgrid  SENDGRID_KEY            resend  RESEND_KEY
 *   twilio    TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM (or TWILIO_MESSAGING_SERVICE)
 *   MAIL_FROM  the platform's sending address (e.g. notices@nextgrow.pro); the organization's name and reply-to come from
 *              its Communication settings, so mail reads "ISGH Membership <notices@…>" and replies go to the organization.
 * Every adapter is plain fetch – no SDK – so nothing extra is installed.
 */
import { randomUUID } from 'node:crypto';

export type Mail = { to: string; subject: string; text: string; html?: string; fromName: string; replyTo: string; tag: string };
export type Text = { to: string; body: string };
export type Sent = { ref: string };
export interface EmailProvider { name: string; send(m: Mail): Promise<Sent> }
export interface SmsProvider { name: string; send(t: Text): Promise<Sent> }

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
async function post(url: string, headers: Record<string, string>, body: string, okRef: (j: any) => string): Promise<Sent> {
  const r = await fetch(url, { method: 'POST', headers, body });
  const t = await r.text(); let j: any = {}; try { j = JSON.parse(t); } catch { /* not json */ }
  if (!r.ok) throw new Error(`${r.status} ${(j.message ?? j.Message ?? t).toString().slice(0, 300)}`);
  return { ref: okRef(j) || randomUUID() };
}
const from = (m: Mail) => `${m.fromName.replace(/[<>"]/g, '')} <${process.env.MAIL_FROM ?? 'notices@example.org'}>`;

export const emailProviders: Record<string, () => EmailProvider> = {
  log: () => ({ name: 'log', send: async (m) => { if (process.env.MAIL_LOG) console.log(`[mail] ${m.to} · ${m.subject}`); return { ref: `log-${randomUUID()}` }; } }),
  /** For tests: every send fails (retries and give-up are tested with it). */
  fail: () => ({ name: 'fail', send: async () => { throw new Error('provider unavailable'); } }),
  postmark: () => ({ name: 'postmark', send: (m) => post('https://api.postmarkapp.com/email', { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': need('POSTMARK_TOKEN') },
    JSON.stringify({ From: from(m), To: m.to, ReplyTo: m.replyTo, Subject: m.subject, TextBody: m.text, HtmlBody: m.html, Tag: m.tag, MessageStream: m.tag === 'bulk' ? 'broadcast' : 'outbound' }), (j) => j.MessageID) }),
  sendgrid: () => ({ name: 'sendgrid', send: (m) => post('https://api.sendgrid.com/v3/mail/send', { Authorization: `Bearer ${need('SENDGRID_KEY')}`, 'Content-Type': 'application/json' },
    JSON.stringify({ personalizations: [{ to: [{ email: m.to }] }], from: { email: process.env.MAIL_FROM, name: m.fromName }, reply_to: { email: m.replyTo }, subject: m.subject, categories: [m.tag],
      content: [{ type: 'text/plain', value: m.text }, ...(m.html ? [{ type: 'text/html', value: m.html }] : [])] }), () => '') }),
  resend: () => ({ name: 'resend', send: (m) => post('https://api.resend.com/emails', { Authorization: `Bearer ${need('RESEND_KEY')}`, 'Content-Type': 'application/json' },
    JSON.stringify({ from: from(m), to: [m.to], reply_to: m.replyTo, subject: m.subject, text: m.text, html: m.html, tags: [{ name: 'kind', value: m.tag.replace(/[^a-z0-9_-]/gi, '_') }] }), (j) => j.id) }),
};
export const smsProviders: Record<string, () => SmsProvider> = {
  log: () => ({ name: 'log', send: async (t) => { if (process.env.MAIL_LOG) console.log(`[sms] ${t.to} · ${t.body.slice(0, 40)}`); return { ref: `log-${randomUUID()}` }; } }),
  fail: () => ({ name: 'fail', send: async () => { throw new Error('provider unavailable'); } }),
  twilio: () => ({ name: 'twilio', send: (t) => {
    const sid = need('TWILIO_SID'); const form = new URLSearchParams({ To: t.to.startsWith('+') ? t.to : `+1${t.to.replace(/\D/g, '').slice(-10)}`, Body: t.body, ...(process.env.TWILIO_MESSAGING_SERVICE ? { MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE } : { From: need('TWILIO_FROM') }) });
    return post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { Authorization: `Basic ${Buffer.from(`${sid}:${need('TWILIO_TOKEN')}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, form.toString(), (j) => j.sid);
  } }),
};
export const emailProvider = (): EmailProvider => (emailProviders[process.env.EMAIL_PROVIDER ?? 'log'] ?? emailProviders.log)();
export const smsProvider = (): SmsProvider => (smsProviders[process.env.SMS_PROVIDER ?? 'log'] ?? smsProviders.log)();
