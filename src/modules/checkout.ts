/**
 * B5b Online payments. The website opens a checkout at the payment provider; the provider's webhook says it was paid
 * (or expired, or refunded) and the API applies it exactly once – dues become paid (membership follows), an event
 * registration is confirmed, a gift is recorded in Donations with its campaign and fund.
 *
 *   POST /public/checkout  {kind: 'dues', paymentIds[]} | {kind: 'event', ref, token} | {kind: 'gift', amountCents, fund?, campaignId?, pageId?, name, email, anonymous?, showName?, monthly?}
 *        → { url } (the provider's page; success / cancel return to the website)
 *   POST /webhooks/pay/stripe              checkout.session.completed | .expired | .async_payment_failed, charge.refunded
 *
 * Providers (PAYMENTS_PROVIDER = stripe | fake): Stripe with plain fetch. Each organization takes money into its own
 * Stripe account: the key is STRIPE_SECRET_KEY_<SLUG> (e.g. STRIPE_SECRET_KEY_ISGH), else STRIPE_SECRET_KEY; webhooks
 * are verified with STRIPE_WEBHOOK_SECRET (Stripe-Signature, HMAC-SHA256 of "t.body"). `fake` opens nothing (tests,
 * development) – its sessions are paid by posting a signed webhook, the same code path as Stripe.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/sql.js';
import { one, rows } from '../db/sql.js';
import { HttpError, PLATFORM, audit, document, route, todayCT, type Ctx, type Req, type Res, type Route } from '../http/core.js';
import { sha256hex } from '../auth/crypto.js';
import { movePayment } from './website.js';
import { donationSettings } from './giving.js';
import { systemContext } from '../jobs/runner.js';
import * as D from '@/lib/community/donations';
import * as F from '@/lib/community/fundraising';
import { touchPerson } from './contacts.js';
import { siteOf } from './join-drafts.js';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/* ---------------- providers ---------------- */
type Session = { id: string; url: string };
type Open = { orgSlug: string; amountCents: number; description: string; email: string; successUrl: string; cancelUrl: string; metadata: Record<string, string>; monthly?: boolean };
interface PayProvider { name: string; open(o: Open): Promise<Session> }
const stripe: PayProvider = {
  name: 'stripe',
  async open(o) {
    const key = process.env[`STRIPE_SECRET_KEY_${o.orgSlug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] ?? process.env.STRIPE_SECRET_KEY; if (!key) throw new HttpError(503, 'Card payments are not set up yet – please pay at the office.');
    const f = new URLSearchParams({ mode: o.monthly ? 'subscription' : 'payment', success_url: o.successUrl, cancel_url: o.cancelUrl, customer_email: o.email, 'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(o.amountCents), 'line_items[0][price_data][product_data][name]': o.description.slice(0, 120) });
    if (o.monthly) f.set('line_items[0][price_data][recurring][interval]', 'month');
    for (const [k, v] of Object.entries(o.metadata)) { f.set(`metadata[${k}]`, v); if (!o.monthly) f.set(`payment_intent_data[metadata][${k}]`, v); }
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': o.metadata.intent }, body: f.toString() });
    const j = await r.json() as { id?: string; url?: string; error?: { message?: string } };
    if (!r.ok || !j.id || !j.url) throw new HttpError(502, `The card page could not be opened: ${j.error?.message ?? r.status}`);
    return { id: j.id, url: j.url };
  },
};
const fake: PayProvider = { name: 'fake', open: async (o) => { const id = `cs_fake_${randomUUID().replace(/-/g, '')}`; return { id, url: `${new URL(o.successUrl).origin}/pay/fake?session=${id}` }; } };
const provider = (): PayProvider => (process.env.PAYMENTS_PROVIDER === 'stripe' ? stripe : fake);
// Stripe-format webhooks for both: the fake provider's events are signed the same way (STRIPE_WEBHOOK_SECRET)
const providerName = () => provider().name;

const site = siteOf;   // the website the visitor is on, else the organization's own website

const Gift = z.object({ amountCents: z.number().int().min(100).max(10_000_000), fund: z.string().default(''), campaignId: z.string().default(''), pageId: z.string().default(''), name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(120), anonymous: z.boolean().default(false), showName: z.boolean().default(true), monthly: z.boolean().default(false), center: z.string().max(80).default('') });

export const CHECKOUT_ROUTES: Route[] = [
  route('POST', /^\/public\/checkout$/, async (ctx) => {
    const b = body(ctx); const kind = String(b.kind ?? ''); const pay = provider(); const base = await site(ctx);
    let amount = 0, ref = '', description = '', email = '', payload: Record<string, unknown> = {}, monthly = false;
    if (kind === 'dues') {
      const ids = (Array.isArray(b.paymentIds) ? b.paymentIds : []).map(String).filter((x) => /^[0-9a-f-]{36}$/.test(x)); if (!ids.length) throw new HttpError(400, 'Which payment?');
      const ps = (await rows(ctx.db, API(ctx), `SELECT p.id::text, p.status, p.amount_cents, p.method, p.member_id, m.email, m.first_name || ' ' || m.last_name AS name, m.record->>'householdOf' AS household_of FROM app.payments p JOIN app.members m ON m.org_id = p.org_id AND m.id = p.member_id WHERE p.id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb))::uuid[])`, [JSON.stringify(ids)])) as { id: string; status: string; amount_cents: number; method: string; member_id: string; email: string; name: string; household_of: string | null }[];
      if (ps.length !== ids.length) throw new HttpError(404, 'No such payment.');
      if (ps.some((p) => p.status !== 'pending' && p.status !== 'failed')) throw new HttpError(409, 'This payment is not waiting for a card.');
      // one person pays for their household in one go: every other row must belong to a family member on their application
      const heads = ps.filter((p) => !p.household_of || !ps.some((q) => q.member_id === p.household_of));
      const head = heads[0]; if (!head || heads.some((p) => p.member_id !== head.member_id)) throw new HttpError(400, 'One household per checkout.');
      const others = Array.from(new Set(ps.filter((p) => p.member_id !== head.member_id).map((p) => p.member_id))).length;
      amount = ps.reduce((a, p) => a + p.amount_cents, 0); ref = ids.join(','); email = head.email; description = `Membership dues – ${head.name}${others ? ` + ${others} family member${others === 1 ? '' : 's'}` : ''}`;
    } else if (kind === 'event') {
      const token = String(b.token ?? ''); const r = await one<{ id: string; status: string; total_cents: number; paid_cents: number; email: string; event_id: string }>(ctx.db, API(ctx), `SELECT id, status, total_cents, paid_cents, email::text, event_id FROM app.registrations WHERE id = $1 AND manage_hash = $2`, [String(b.ref ?? ''), sha256hex(token)]);
      if (!r) throw new HttpError(404, 'No such registration.');
      if (r.status !== 'pending-payment') throw new HttpError(409, r.status === 'confirmed' ? 'Already paid.' : `This registration is ${r.status}.`);
      amount = r.total_cents - r.paid_cents; ref = r.id; email = r.email; description = `Event registration ${r.id}`;
    } else if (kind === 'gift') {
      const p = Gift.safeParse(b); if (!p.success) throw new HttpError(422, 'Check the gift.', issues(p.error)); const g = p.data;
      const s = await donationSettings(ctx); const fr = F.FundraisingSchema.safeParse(await document(ctx.db, ctx.orgId, 'fundraising'));
      let fund = g.fund;
      if (g.campaignId) { const c = fr.success ? fr.data.campaigns.find((x) => x.id === g.campaignId) : undefined; if (!c || F.campaignState(c, todayCT()) !== 'live') throw new HttpError(422, 'This campaign is not taking gifts now.'); fund = c.fund; if (g.pageId && !fr.data!.pages.some((x) => x.id === g.pageId && x.campaignId === c.id && x.status === 'approved')) throw new HttpError(422, 'No such personal page.'); }
      if (!s.funds.some((f) => f.id === fund && f.active)) throw new HttpError(422, 'Pick a fund.');
      amount = g.amountCents; email = g.email; monthly = g.monthly; description = `Gift – ${s.funds.find((f) => f.id === fund)!.name}`; payload = { ...g, fund };
    } else throw new HttpError(400, 'kind: dues, event or gift.');
    if (amount < 50) throw new HttpError(409, 'Nothing to pay.');
    const intent = randomUUID();
    const sess = await pay.open({ orgSlug: ctx.slug, amountCents: amount, description, email, monthly, successUrl: `${base}/pay/done?intent=${intent}`, cancelUrl: `${base}/pay/cancelled?intent=${intent}`, metadata: { intent, org: ctx.slug, kind } });
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.checkout_intents (org_id, id, kind, ref, amount_cents, payload, provider, session_id) VALUES ($1::uuid, $2::uuid, $3, $4, $5::int, $6::jsonb, $7, $8)`, params: [ctx.orgId, intent, kind, ref, amount, JSON.stringify(payload), pay.name, sess.id] },
      ...(kind === 'dues' ? [{ sql: `UPDATE app.payments SET checkout_ref = $2 WHERE id = ANY(ARRAY(SELECT unnest(string_to_array($1, ',')))::uuid[])`, params: [ref, sess.id] }] : [])]);
    return { status: 201, body: { url: sess.url, session: sess.id, amountCents: amount } };
  }),
];

/* ---------------- the provider's webhook ---------------- */
function verify(req: Req) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET; if (!secret) throw new HttpError(503, 'Payment webhooks are not configured.');
  const h = String(req.headers['stripe-signature'] ?? ''); const parts = Object.fromEntries(h.split(',').map((x) => x.split('=') as [string, string]));
  const t = Number(parts.t); if (!t || Math.abs(Date.now() / 1000 - t) > 300) throw new HttpError(400, 'Old or missing timestamp.');
  const want = createHmac('sha256', secret).update(`${t}.${req.raw ?? ''}`).digest('hex');
  const got = h.split(',').filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
  if (!got.some((g) => g.length === want.length && timingSafeEqual(Buffer.from(g), Buffer.from(want)))) throw new HttpError(400, 'Bad signature.');
}
type Intent = { id: string; kind: 'dues' | 'event' | 'gift'; ref: string; amount_cents: number; payload: any; status: string; payment_ref: string; refunded_cents: number };

export async function handlePayWebhook(db: Db, req: Req): Promise<Res> {
  if (req.method !== 'POST' || !/^\/webhooks\/pay\/(stripe|fake)$/.test(req.path)) throw new HttpError(404, 'No such webhook.');
  verify(req);
  const ev = req.body as { id: string; type: string; data: { object: any } };
  const fresh = await one(db, PLATFORM, `INSERT INTO platform.webhook_events (provider, event_id, kind, payload) VALUES ('stripe', $1, $2, $3::jsonb) ON CONFLICT DO NOTHING RETURNING event_id`, [String(ev.id), String(ev.type), JSON.stringify(ev)]);
  if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
  const o = ev.data?.object ?? {}; const name = providerName();
  const session = String(o.object === 'checkout.session' ? o.id : ''); const payment = String(o.object === 'charge' ? o.payment_intent : o.payment_intent ?? '');
  const orgRow = await one<{ o: string | null }>(db, PLATFORM, 'SELECT platform.intent_org($1, $2, $3)::text AS o', [name, session, payment]);
  if (!orgRow?.o) return { status: 200, body: { ok: true, ignored: 'unknown checkout' } };
  const org = await one<{ slug: string }>(db, PLATFORM, 'SELECT slug FROM platform.organizations WHERE id = $1::uuid', [orgRow.o]);
  const ctx = await systemContext(db, orgRow.o, org!.slug);
  const it = await one<Intent>(db, API(ctx), `SELECT id::text, kind, ref, amount_cents, payload, status, payment_ref, refunded_cents FROM app.checkout_intents WHERE provider = $1 AND ((session_id = $2 AND $2 <> '') OR (payment_ref = $3 AND $3 <> ''))`, [name, session, payment]);
  if (!it) return { status: 200, body: { ok: true, ignored: 'unknown checkout' } };

  if (ev.type === 'checkout.session.completed' && (o.payment_status === 'paid' || o.payment_status === 'no_payment_required')) {
    if (it.status !== 'open') return { status: 200, body: { ok: true, already: it.status } };
    const pref = String(o.payment_intent ?? o.subscription ?? session);
    await db.run(API(ctx), [{ sql: `UPDATE app.checkout_intents SET status = 'paid', payment_ref = $2, paid_at = now() WHERE id = $1::uuid`, params: [it.id, pref] }]);
    await apply(ctx, it, pref, Number(o.amount_total ?? it.amount_cents));
    return { status: 200, body: { ok: true, applied: it.kind } };
  }
  if (ev.type === 'checkout.session.expired' || ev.type === 'checkout.session.async_payment_failed') {
    if (it.status !== 'open') return { status: 200, body: { ok: true, already: it.status } };
    await db.run(API(ctx), [{ sql: `UPDATE app.checkout_intents SET status = $2 WHERE id = $1::uuid`, params: [it.id, ev.type.endsWith('expired') ? 'expired' : 'failed'] }]);
    if (it.kind === 'dues' && ev.type.endsWith('failed')) for (const id of it.ref.split(',')) await movePayment(ctx, id, 'failed', 'Card payment', { name, ref: '' }).catch(() => null);
    // an unpaid event seat goes back (the waitlist moves up)
    if (it.kind === 'event') await db.run(API(ctx), [{ sql: `UPDATE app.registrations SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'Checkout not completed' WHERE id = $1 AND status = 'pending-payment'`, params: [it.ref] }, { sql: `SELECT app.event_promote(event_id) FROM app.registrations WHERE id = $1`, params: [it.ref] }]);
    return { status: 200, body: { ok: true, closed: it.kind } };
  }
  if (ev.type === 'charge.refunded') {
    const refunded = Number(o.amount_refunded ?? 0); const full = refunded >= Number(o.amount ?? it.amount_cents);
    if (it.status !== 'paid' && it.status !== 'partially_refunded') return { status: 200, body: { ok: true, already: it.status } };
    await db.run(API(ctx), [{ sql: `UPDATE app.checkout_intents SET status = $2, refunded_cents = $3::int WHERE id = $1::uuid`, params: [it.id, full ? 'refunded' : 'partially_refunded', refunded] }]);
    if (it.kind === 'dues') for (const id of it.ref.split(',')) await movePayment(ctx, id, full ? 'refunded' : 'partially_refunded', 'Card refund', { name, ref: '' }).catch(() => null);
    if (it.kind === 'event') await db.run(API(ctx), [{ sql: `UPDATE app.registrations SET status = CASE WHEN $3::boolean THEN 'refunded' ELSE status END, refund_cents = $2::int, cancelled_at = CASE WHEN $3::boolean THEN now() ELSE cancelled_at END WHERE id = $1`, params: [it.ref, refunded, full] }, { sql: `SELECT app.event_promote(event_id) FROM app.registrations WHERE id = $1`, params: [it.ref] }]);
    if (it.kind === 'gift' && full) await db.run(API(ctx), [{ sql: `UPDATE app.donations SET state = 'refunded', refunded_at = now(), refund_reason = 'Refunded on Stripe' WHERE platform = 'stripe' AND platform_ref = $1`, params: [it.payment_ref] }]);
    await audit(ctx, 'payments', 'Card refund', `${it.kind} ${(refunded / 100).toFixed(2)}`, it.ref || it.id);
    return { status: 200, body: { ok: true, refunded: it.kind } };
  }
  return { status: 200, body: { ok: true, ignored: ev.type } };
}

/** A paid checkout: dues → paid (membership follows), event → confirmed, gift → a donation (Zakat stays Zakat). */
async function apply(ctx: Ctx, it: Intent, pref: string, paidCents: number) {
  const name = providerName();
  if (it.kind === 'dues') {
    for (const [i, id] of it.ref.split(',').entries()) await movePayment(ctx, id, 'paid', 'Card payment', { name: 'stripe', ref: `${pref}:${i + 1}` });
    await audit(ctx, 'payments', 'Paid by card', `${(paidCents / 100).toFixed(2)} (${it.ref.split(',').length} payment${it.ref.includes(',') ? 's' : ''})`, it.ref);
  } else if (it.kind === 'event') {
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.registrations SET status = 'confirmed', paid_cents = total_cents, paid_method = 'card' WHERE id = $1 AND status = 'pending-payment'`, params: [it.ref] }]);
    const r = await one<{ email: string; name: string; event_id: string }>(ctx.db, API(ctx), 'SELECT email::text, name, event_id FROM app.registrations WHERE id = $1', [it.ref]);
    if (r) await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, 'event-registered')`, params: [ctx.orgId, r.email, `Paid – you are registered [${it.ref}]`, `Assalamu alaikum ${r.name.split(' ')[0]},\n\nWe received ${(paidCents / 100).toFixed(2)} USD. Your registration ${it.ref} is confirmed.`] }]);
  } else {
    const g = it.payload as z.infer<typeof Gift>; const s = await donationSettings(ctx);
    const id = `D-${(await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, 'donation', 10001)::text AS n`, [ctx.orgId]))!.n}`;
    const member = await one<{ id: string }>(ctx.db, API(ctx), 'SELECT id FROM app.members WHERE lower(email) = lower($1) AND archived IS NULL LIMIT 1', [g.email]);
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.donations (org_id, id, donor_name, donor_email, member_id, anonymous, show_name, fund_id, center_id, campaign_id, page_id, amount_cents, given_on, method, platform, platform_ref, state, entered_by, source, monthly)
      VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), $6::boolean, $7::boolean, $8, (SELECT id FROM app.centers WHERE name = $9), NULLIF($10, ''), NULLIF($11, ''), $12::bigint, current_date, 'card', 'stripe', $13, 'awaiting-payout', 'Website', 'online', $14::boolean)`,
      params: [ctx.orgId, id, g.name, g.email, member?.id ?? '', g.anonymous, g.showName, g.fund, g.center, g.campaignId, g.pageId, paidCents, pref, g.monthly] }]);
    await touchPerson(ctx, { firstName: g.name.split(' ')[0] ?? g.name, lastName: g.name.split(' ').slice(1).join(' '), email: g.email, source: 'donation', memberId: member?.id ?? null, gaveAt: new Date().toISOString() });   // People: a donor
    // the thank-you right away; the written receipt (IRS) when the amount asks for it
    const big = paidCents >= s.receiptAboveCents && !g.anonymous;
    const no = big ? `R-${todayCT().slice(0, 4)}-${String((await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, $2, 1)::text AS n`, [ctx.orgId, `receipt-${todayCT().slice(0, 4)}`]))!.n).padStart(5, '0')}` : '';
    if (no) await ctx.db.run(API(ctx), [{ sql: `UPDATE app.donations SET receipt_no = $2, receipt_sent_at = now() WHERE id = $1`, params: [id, no] }]);
    await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, 'donation-receipt')`,
      params: [ctx.orgId, g.email, no ? `Your receipt ${no}` : 'JazakAllahu khayran for your gift', `Assalamu alaikum ${g.name.split(' ')[0]},\n\nJazakAllahu khayran for your gift of ${D.usd(paidCents)} to ${s.funds.find((f) => f.id === g.fund)?.name ?? 'our community'}${g.monthly ? ' – every month' : ''}.${no ? `\nReceipt ${no}. No goods or services were provided in return for this gift.` : ''}`] }]);
    await audit(ctx, 'donations', 'Online gift', `${id} ${D.usd(paidCents)} → ${g.fund}${g.campaignId ? ` (${g.campaignId})` : ''}`, id);
  }
  void name;
}
