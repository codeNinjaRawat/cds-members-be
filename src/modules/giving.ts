/**
 * B4c Giving and fundraising. Gifts are rows (app.donations); funds, Check-o-matic, receipts and routing come from the
 * `donation-settings` document; campaigns and personal pages from `fundraising` (projected to app.campaigns). The rules
 * are the admin's own (web/src/lib/community/donations.ts and fundraising.ts) – rows are loaded into Donation / Gift shapes.
 *
 * Donations (donations.view to see; donations.reconcile or finance.manage to change; masjid roles see their masjid's gifts)
 *   GET   /admin/donations?state=&fund=&center=&campaign=&q=&from=&to=   list + stats
 *   POST  /admin/donations                      cash or check entered at a masjid (entryProblems)
 *   POST  /admin/donations/import               {platform, gifts[]} – a platform sync / CSV (idempotent by the platform's id)
 *   PATCH /admin/donations/:id                  reconcile: fund, masjid, donor, campaign
 *   POST  /admin/donations/:id/refund {reason}  (payments.refund) · POST /admin/donations/:id/receipt · POST /admin/donations/receipts (all due)
 *   POST  /admin/payouts                         {platform, id, amountCents, feeCents, arrivedOn, refs[]} – a bank deposit; matches its gifts
 *   GET   /admin/donations/checkomatic          who qualified and what it means (settings decide)
 *   GET   /member/giving?year=                   the member's own gifts and the tax-deductible total
 * Fundraising (fundraising.manage)
 *   GET  /public/campaigns · GET /public/campaigns/:id              totals, matching, donor wall (first names only), approved pages
 *   POST /member/campaigns/:id/pages {title, story, goalCents}      a personal page (waits for approval when the campaign asks)
 *   GET  /admin/fundraising?year=               campaigns with progress, matching, pages, pledges, warnings, donor insights
 *   POST /admin/fundraising/pages/:id/decision {decision: approve | reject | hide, note}
 *   GET  /admin/pledges?campaign= · POST /admin/pledges {campaignId, name, email?, memberId?, totalCents, dueBy}
 */
import { z } from 'zod';
import { one, rows, type Statement } from '../db/sql.js';
import { HttpError, PLATFORM, audit, document, need, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { saveDocument } from './projections.js';
import { can, inScope, roleOf, type Permission } from '@/lib/community/access';
import * as D from '@/lib/community/donations';
import * as F from '@/lib/community/fundraising';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
const has = (ctx: Ctx, p: Permission) => !!ctx.me && can(ctx.access, ctx.me, p, todayCT());
function needAny(ctx: Ctx, ...ps: Permission[]) { if (!ps.some((p) => has(ctx, p))) need(ctx, ps[0]); }
const scoped = (ctx: Ctx) => { const r = roleOf(ctx.access, ctx.me); return !!(r?.centerScoped || r?.zoneScoped || r?.areaScoped); };

export async function donationSettings(ctx: Ctx): Promise<D.DonationSettings> { const p = D.DonationSettingsSchema.safeParse(await document(ctx.db, ctx.orgId, 'donation-settings')); return p.success ? p.data : D.mockDonationSettings; }
async function fundraisingDoc(ctx: Ctx): Promise<F.Fundraising> { const p = F.FundraisingSchema.safeParse(await document(ctx.db, ctx.orgId, 'fundraising')); return p.success ? p.data : F.mockFundraising; }
async function centers(ctx: Ctx) {
  const list = await rows(ctx.db, API(ctx), 'SELECT c.id, c.name, z.code AS zone FROM app.centers c JOIN app.zones z ON z.org_id = c.org_id AND z.id = c.zone_id') as { id: string; name: string; zone: string }[];
  return { byName: new Map(list.map((c) => [c.name, c])), byId: new Map(list.map((c) => [c.id, c])) };
}
type Centers = Awaited<ReturnType<typeof centers>>;
const mine = (ctx: Ctx, c: Centers, center: string) => !scoped(ctx) || (!!center && inScope(ctx.access, ctx.me, c.byName.get(center)?.zone ?? '', center));

/* ---------------- rows ⇄ Donation ---------------- */
const METHOD: Record<D.Platform, string> = { stripe: 'card', paypal: 'paypal', medina: 'kiosk', bloomerang: 'other', zeffy: 'zeffy', cash: 'cash', check: 'check' };
const DON_SQL = `SELECT d.id, d.donor_name, d.donor_email::text AS donor_email, coalesce(d.member_id, '') AS member_id, d.anonymous, d.show_name, coalesce(d.fund_id, '') AS fund_id, d.center_id, coalesce(d.campaign_id, '') AS campaign_id,
  coalesce(d.page_id, '') AS page_id, d.amount_cents::int AS amount_cents, d.fee_cents::int AS fee_cents, d.given_on::text AS given_on, to_char(d.created_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS at_time, d.platform, d.platform_ref, d.check_no, d.payout_id,
  d.monthly, d.recurring_id IS NOT NULL AS recurring, d.state, d.receipt_no, d.receipt_sent_at IS NOT NULL AS receipt_sent, d.entered_by, d.source, coalesce(d.pledge_id::text, '') AS pledge_id FROM app.donations d`;
type DRow = Record<string, any>;
function toDonation(r: DRow, c: Centers): D.Donation & { campaignId: string; pageId: string; source: string; receiptNo: string; showName: boolean; pledgeId: string } {
  const platform = (r.platform in D.PLATFORMS ? r.platform : 'cash') as D.Platform;
  return { id: r.id, at: `${r.given_on}T${r.at_time}Z`, donor: { name: r.donor_name, email: r.donor_email, memberId: r.member_id, anonymous: r.anonymous }, amountCents: r.amount_cents, feeCents: r.fee_cents,
    fund: r.fund_id, center: r.center_id ? c.byId.get(r.center_id)?.name ?? '' : '', platform, ref: r.platform_ref || r.check_no, payout: r.payout_id, recurring: r.recurring || r.monthly,
    refunded: r.state === 'refunded', receiptSent: r.receipt_sent, enteredBy: r.entered_by, campaignId: r.campaign_id, pageId: r.page_id, source: r.source, receiptNo: r.receipt_no, showName: r.show_name, pledgeId: r.pledge_id };
}
const STATE: Record<D.ReconState, string> = { matched: 'ok', unmatched: 'needs-fund-or-donor', pending: 'awaiting-payout', refunded: 'refunded' };
const donorKey = (d: { memberId?: string; email?: string; name: string }) => d.memberId || (d.email ?? '').toLowerCase() || d.name.trim().toLowerCase();
const toGift = (d: ReturnType<typeof toDonation>): F.Gift => ({ id: d.id, campaignId: d.campaignId, pageId: d.pageId, at: d.at, amountCents: d.amountCents, monthly: d.recurring,
  source: (d.source === 'pledge' ? 'pledge' : d.source === 'office' ? 'office' : 'online'), donor: { key: donorKey(d.donor), name: d.donor.name, memberId: d.donor.memberId, anonymous: d.donor.anonymous, showName: d.showName } });

async function loadDonations(ctx: Ctx, c: Centers, where = '', params: unknown[] = []) {
  return ((await rows(ctx.db, API(ctx), `${DON_SQL} ${where}`, params)) as DRow[]).map((r) => toDonation(r, c)).filter((d) => mine(ctx, c, d.center));
}
async function giftsFor(ctx: Ctx, c: Centers) { return ((await rows(ctx.db, API(ctx), `${DON_SQL} WHERE d.campaign_id IS NOT NULL AND d.state <> 'refunded'`)) as DRow[]).map((r) => toGift(toDonation(r, c))); }
async function pledgesFor(ctx: Ctx): Promise<(F.Pledge & { email: string; status: string })[]> {
  return ((await rows(ctx.db, API(ctx), `SELECT p.ref AS id, p.campaign_id, p.donor_key, p.donor_name, p.donor_email::text AS email, p.amount_cents::int AS total, coalesce(p.due_on::text, '') AS due, p.status FROM app.pledges p ORDER BY p.created_at`)) as DRow[])
    .map((r) => ({ id: r.id, campaignId: r.campaign_id, donor: { key: r.donor_key, name: r.donor_name }, totalCents: r.total, dueBy: r.due, email: r.email, status: r.status }));
}

/** The statements that store one gift (insert or update) – state follows the reconciliation rule. */
function saveDonation(ctx: Ctx, d: ReturnType<typeof toDonation>, c: Centers, insert: boolean): Statement {
  const p = [ctx.orgId, d.id, d.donor.name, d.donor.email, d.donor.memberId, d.donor.anonymous, d.fund, d.center ? c.byName.get(d.center)?.id ?? '' : '', d.campaignId, d.pageId, d.amountCents, d.feeCents, d.at.slice(0, 10),
    METHOD[d.platform], ['cash', 'check'].includes(d.platform) && d.platform === 'check' ? d.ref : '', d.platform, ['cash', 'check'].includes(d.platform) ? '' : d.ref, d.payout, STATE[D.reconState(d)], d.enteredBy, d.source, d.recurring, d.showName, d.pledgeId];
  return insert
    ? { sql: `INSERT INTO app.donations (org_id, id, donor_name, donor_email, member_id, anonymous, fund_id, center_id, campaign_id, page_id, amount_cents, fee_cents, given_on, method, check_no, platform, platform_ref, payout_id, state, entered_by, source, monthly, show_name, pledge_id)
        VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), $6::boolean, NULLIF($7, ''), NULLIF($8, '')::uuid, NULLIF($9, ''), NULLIF($10, ''), $11::bigint, $12::bigint, $13::date, $14, $15, $16, $17, $18, $19, $20, $21, $22::boolean, $23::boolean, NULLIF($24, '')::uuid)`, params: p }
    : { sql: `UPDATE app.donations SET donor_name = $3, donor_email = $4, member_id = NULLIF($5, ''), anonymous = $6::boolean, fund_id = NULLIF($7, ''), center_id = NULLIF($8, '')::uuid, campaign_id = NULLIF($9, ''), page_id = NULLIF($10, ''),
        payout_id = $18, state = $19, show_name = $23::boolean WHERE org_id = $1::uuid AND id = $2 AND ($11::text, $12::text, $13::text, $14::text, $15::text, $16::text, $17::text, $20::text, $21::text, $22::text, $24::text) IS NOT NULL`, params: p };
}
async function nextDonationId(ctx: Ctx) { return `D-${(await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, 'donation', 10001)::text AS n`, [ctx.orgId]))!.n}`; }
async function loadOne(ctx: Ctx, c: Centers, id: string) { const d = (await loadDonations(ctx, c, 'WHERE d.id = $1', [id]))[0]; if (!d) throw new HttpError(404, `No gift ${id}.`); return d; }

/** A gift may name a campaign (and a page / pledge of it); the campaign's fund wins – Zakat stays Zakat. */
async function campaignLink(ctx: Ctx, fr: F.Fundraising, campaignId: string, pageId: string, pledgeRef: string) {
  if (!campaignId) return { fund: '', pledgeId: '' };
  const camp = fr.campaigns.find((x) => x.id === campaignId); if (!camp || camp.status === 'draft') throw new HttpError(422, `No campaign “${campaignId}”.`);
  if (pageId && !fr.pages.some((p) => p.id === pageId && p.campaignId === camp.id && p.status === 'approved')) throw new HttpError(422, 'That personal page is not part of this campaign.');
  let pledgeId = '';
  if (pledgeRef) { const p = await one<{ id: string }>(ctx.db, API(ctx), `SELECT id::text FROM app.pledges WHERE ref = $1 AND campaign_id = $2 AND status = 'open'`, [pledgeRef, camp.id]); if (!p) throw new HttpError(422, `No open pledge ${pledgeRef} for this campaign.`); pledgeId = p.id; }
  return { fund: camp.fund, pledgeId };
}
async function closePledges(ctx: Ctx, c: Centers) {
  const [gifts, pledges] = await Promise.all([giftsFor(ctx, c), pledgesFor(ctx)]);
  const done = pledges.filter((p) => p.status === 'open' && F.pledgeStatus(p, gifts, todayCT()).done);
  if (done.length) await ctx.db.run(API(ctx), done.map((p) => ({ sql: `UPDATE app.pledges SET status = 'fulfilled' WHERE ref = $1`, params: [p.id] })));
}

const Entry = z.object({ amountCents: z.number().int().min(100).max(100_000_000), platform: z.enum(['cash', 'check']), ref: z.string().trim().max(60).default(''), fund: z.string().default(''), center: z.string().default(''),
  givenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), name: z.string().trim().min(2).max(80), email: z.union([z.literal(''), z.string().trim().toLowerCase().email().max(120)]).default(''), memberId: z.string().max(20).default(''),
  anonymous: z.boolean().default(false), showName: z.boolean().default(true), campaignId: z.string().default(''), pageId: z.string().default(''), pledge: z.string().default(''), note: z.string().max(300).default('') });
const ImportGift = z.object({ ref: z.string().trim().min(1).max(60), at: z.string().regex(/^\d{4}-\d{2}-\d{2}/), amountCents: z.number().int().min(100).max(100_000_000), feeCents: z.number().int().min(0).default(0),
  name: z.string().trim().max(80).default(''), email: z.union([z.literal(''), z.string().trim().toLowerCase().email()]).default(''), memberId: z.string().max(20).default(''), anonymous: z.boolean().default(false),
  fund: z.string().default(''), center: z.string().default(''), campaignId: z.string().default(''), pageId: z.string().default(''), payout: z.string().max(60).default(''), recurring: z.boolean().default(false), refunded: z.boolean().default(false) });

export const GIVING_ROUTES: Route[] = [
  route('GET', /^\/admin\/donations$/, async (ctx) => {
    needAny(ctx, 'donations.view', 'finance.view');
    const [c, s] = await Promise.all([centers(ctx), donationSettings(ctx)]); const q = ctx.req.query;
    const from = q.get('from') ?? '0001-01-01', to = q.get('to') ?? '9999-12-31';
    const all = await loadDonations(ctx, c, 'WHERE d.given_on BETWEEN $1::date AND $2::date ORDER BY d.given_on DESC, d.id DESC', [/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : '0001-01-01', /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : '9999-12-31']);
    const text = (q.get('q') ?? '').toLowerCase();
    const list = all.filter((d) => (!q.get('state') || D.reconState(d) === q.get('state') || (q.get('state') === 'receipts' && D.needsReceipt(d, s))) && (!q.get('fund') || d.fund === q.get('fund')) && (!q.get('center') || d.center === q.get('center'))
      && (!q.get('campaign') || d.campaignId === q.get('campaign')) && (!text || `${d.id} ${d.donor.name} ${d.donor.email} ${d.ref}`.toLowerCase().includes(text)));
    return { status: 200, body: { count: list.length, stats: D.donationStats(list, s), donations: list.slice(0, Number(q.get('limit') ?? 500)).map((d) => ({ ...d, state: D.reconState(d), bookedTo: D.routedCenter(d, s), netCents: D.netOf(d), needsReceipt: D.needsReceipt(d, s) })) } };
  }),
  route('POST', /^\/admin\/donations$/, async (ctx) => {
    needAny(ctx, 'donations.reconcile', 'payments.record', 'finance.manage');
    const p = Entry.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the gift.', issues(p.error));
    const b = p.data; const [c, s, fr] = await Promise.all([centers(ctx), donationSettings(ctx), fundraisingDoc(ctx)]);
    const link = await campaignLink(ctx, fr, b.campaignId, b.pageId, b.pledge);
    const at = `${b.givenOn ?? todayCT()}T12:00:00Z`;
    const d = { id: await nextDonationId(ctx), at, donor: { name: b.name, email: b.email, memberId: b.memberId.toUpperCase(), anonymous: b.anonymous }, amountCents: b.amountCents, feeCents: 0, fund: link.fund || b.fund, center: b.center,
      platform: b.platform, ref: b.ref, payout: '', recurring: false, refunded: false, receiptSent: false, enteredBy: ctx.me!.name, campaignId: b.campaignId, pageId: b.pageId, source: link.pledgeId ? 'pledge' : 'office', receiptNo: '', showName: b.showName, pledgeId: link.pledgeId } as ReturnType<typeof toDonation>;
    const problems = D.entryProblems(d, s); if (problems.length) throw new HttpError(422, problems[0], problems);
    if (!c.byName.has(d.center)) throw new HttpError(422, `“${d.center}” is not a masjid.`);
    if (!mine(ctx, c, d.center)) throw new HttpError(403, 'You enter gifts for your own masjid only.');
    if (b.givenOn && b.givenOn > todayCT()) throw new HttpError(422, 'The gift date is in the future.');
    if (d.donor.memberId && !(await one(ctx.db, API(ctx), 'SELECT 1 AS x FROM app.members WHERE id = $1', [d.donor.memberId]))) throw new HttpError(422, `No member ${d.donor.memberId}.`);
    await ctx.db.run(API(ctx), [saveDonation(ctx, d, c, true)]);
    if (link.pledgeId) await closePledges(ctx, c);
    await audit(ctx, 'donations', 'Gift entered', `${d.id} ${D.usd(d.amountCents)} ${d.platform} → ${d.fund}`, d.id);
    return { status: 201, body: { donation: { ...d, state: D.reconState(d), bookedTo: D.routedCenter(d, s), checkomatic: D.checkomatic(d, s), needsReceipt: D.needsReceipt(d, s) } } };
  }),
  route('POST', /^\/admin\/donations\/import$/, async (ctx) => {
    needAny(ctx, 'donations.reconcile', 'finance.manage', 'integrations.manage');
    const b = body(ctx); const platform = String(b.platform ?? '') as D.Platform;
    if (!(D.ONLINE as string[]).includes(platform)) throw new HttpError(400, `Platform: ${D.ONLINE.join(', ')}.`);
    const p = z.array(ImportGift).min(1).max(5000).safeParse(b.gifts); if (!p.success) throw new HttpError(400, 'Check the gifts.', issues(p.error).slice(0, 20));
    const [c, s, fr] = await Promise.all([centers(ctx), donationSettings(ctx), fundraisingDoc(ctx)]);
    if (!s.platforms[platform as keyof typeof s.platforms]?.enabled) throw new HttpError(409, `${D.PLATFORMS[platform]} is switched off in donation settings.`);
    const known = new Set(((await rows(ctx.db, API(ctx), `SELECT platform_ref FROM app.donations WHERE platform = $1`, [platform])) as { platform_ref: string }[]).map((r) => r.platform_ref));
    let added = 0, skipped = 0, refunded = 0; const stmts: Statement[] = [];
    for (const g of p.data) {
      if (known.has(g.ref)) {   // the platform says it again: only a refund changes a gift we have
        if (g.refunded) { stmts.push({ sql: `UPDATE app.donations SET state = 'refunded', refunded_at = coalesce(refunded_at, now()), refund_reason = 'Refunded on the platform' WHERE platform = $1 AND platform_ref = $2 AND state <> 'refunded'`, params: [platform, g.ref] }); refunded++; } else skipped++;
        continue;
      }
      const camp = g.campaignId ? fr.campaigns.find((x) => x.id === g.campaignId) : undefined;
      const fund = camp?.fund ?? (s.funds.some((f) => f.id === g.fund && f.active) ? g.fund : '');
      const d = { id: await nextDonationId(ctx), at: g.at.length === 10 ? `${g.at}T12:00:00Z` : g.at, donor: { name: g.name || 'Unknown donor', email: g.email, memberId: g.memberId.toUpperCase(), anonymous: g.anonymous }, amountCents: g.amountCents, feeCents: g.feeCents,
        fund, center: c.byName.has(g.center) ? g.center : '', platform, ref: g.ref, payout: g.payout, recurring: g.recurring, refunded: g.refunded, receiptSent: false, enteredBy: `${D.PLATFORMS[platform]} sync`,
        campaignId: camp ? camp.id : '', pageId: camp && fr.pages.some((x) => x.id === g.pageId && x.campaignId === camp.id) ? g.pageId : '', source: 'online', receiptNo: '', showName: true, pledgeId: '' } as ReturnType<typeof toDonation>;
      stmts.push(saveDonation(ctx, d, c, true)); known.add(g.ref); added++;
    }
    if (stmts.length) await ctx.db.run(API(ctx), stmts);
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.giving_accounts SET last_sync = now() WHERE provider = $1`, params: [platform] }]);
    await audit(ctx, 'donations', 'Platform gifts imported', `${D.PLATFORMS[platform]}: ${added} new, ${skipped} known, ${refunded} refunded`, platform);
    return { status: 200, body: { added, skipped, refunded } };
  }),
  route('PATCH', /^\/admin\/donations\/(D-\d+)$/, async (ctx, mm) => {
    needAny(ctx, 'donations.reconcile', 'finance.manage');
    const [c, s, fr] = await Promise.all([centers(ctx), donationSettings(ctx), fundraisingDoc(ctx)]); const cur = await loadOne(ctx, c, mm[1]);
    if (cur.refunded) throw new HttpError(409, 'A refunded gift does not change.');
    const P = z.object({ fund: z.string().optional(), center: z.string().optional(), donor: z.object({ name: z.string().trim().min(2).max(80).optional(), email: z.union([z.literal(''), z.string().email()]).optional(), memberId: z.string().max(20).optional(), anonymous: z.boolean().optional() }).optional(), campaignId: z.string().optional(), pageId: z.string().optional() }).strict();
    const p = P.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the changes.', issues(p.error));
    const b = p.data; let d = { ...cur, donor: { ...cur.donor, ...(b.donor ?? {}), memberId: (b.donor?.memberId ?? cur.donor.memberId).toUpperCase() } };
    if (b.fund !== undefined) { if (b.fund && !s.funds.some((f) => f.id === b.fund && f.active)) throw new HttpError(422, 'That fund is not active.'); d.fund = b.fund; }
    if (b.center !== undefined) { if (b.center && !c.byName.has(b.center)) throw new HttpError(422, `“${b.center}” is not a masjid.`); if (!mine(ctx, c, b.center)) throw new HttpError(403, 'Only to your own masjid.'); d.center = b.center; }
    if (b.campaignId !== undefined) { const link = await campaignLink(ctx, fr, b.campaignId, b.pageId ?? '', ''); d = { ...d, campaignId: b.campaignId, pageId: b.pageId ?? '', fund: link.fund || d.fund }; }
    if (d.donor.memberId && !(await one(ctx.db, API(ctx), 'SELECT 1 AS x FROM app.members WHERE id = $1', [d.donor.memberId]))) throw new HttpError(422, `No member ${d.donor.memberId}.`);
    // moving a gift out of Zakat (or into it) is not reconciling – that is a refund and a new gift
    const zakat = new Set(s.funds.filter((f) => f.zakat).map((f) => f.id));
    if (cur.fund && zakat.has(cur.fund) !== zakat.has(d.fund) && d.fund) throw new HttpError(409, 'Zakat stays Zakat – a gift cannot move into or out of the Zakat fund.');
    await ctx.db.run(API(ctx), [saveDonation(ctx, d, c, false)]);
    await audit(ctx, 'donations', 'Gift reconciled', `${d.id}: ${Object.keys(b).join(', ')}`, d.id);
    return { status: 200, body: { donation: { ...d, state: D.reconState(d), bookedTo: D.routedCenter(d, s) } } };
  }),
  route('POST', /^\/admin\/donations\/(D-\d+)\/refund$/, async (ctx, mm) => {
    need(ctx, 'payments.refund'); const c = await centers(ctx); const d = await loadOne(ctx, c, mm[1]);
    if (d.refunded) throw new HttpError(409, 'Already refunded.');
    const reason = String(body(ctx).reason ?? '').trim(); if (reason.length < 3) throw new HttpError(400, 'Give the reason.');
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.donations SET state = 'refunded', refunded_at = now(), refund_reason = $2 WHERE id = $1`, params: [d.id, reason.slice(0, 300)] }]);
    await audit(ctx, 'donations', 'Gift refunded', `${d.id} ${D.usd(d.amountCents)}: ${reason}`, d.id);
    return { status: 200, body: { id: d.id, refunded: true, note: ONLINE_NOTE(d.platform) } };
  }),
  route('POST', /^\/admin\/donations\/((D-\d+)\/receipt|receipts)$/, async (ctx, mm) => {
    needAny(ctx, 'donations.reconcile', 'finance.manage');
    const [c, s] = await Promise.all([centers(ctx), donationSettings(ctx)]);
    const list = mm[2] ? [await loadOne(ctx, c, mm[2])] : (await loadDonations(ctx, c, `WHERE d.receipt_sent_at IS NULL AND d.state <> 'refunded'`)).filter((d) => D.needsReceipt(d, s));
    if (mm[2]) { const d = list[0]; if (d.refunded) throw new HttpError(409, 'Refunded – no receipt.'); if (d.donor.anonymous || !d.donor.email) throw new HttpError(409, 'No email for this donor – print the receipt instead.'); }
    let sent = 0;
    for (const d of list.filter((x) => x.donor.email && !x.donor.anonymous)) {
      const year = d.at.slice(0, 4);
      const no = d.receiptNo || `R-${year}-${String((await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, $2, 1)::text AS n`, [ctx.orgId, `receipt-${year}`]))!.n).padStart(5, '0')}`;
      await ctx.db.run(API(ctx), [{ sql: `UPDATE app.donations SET receipt_no = $2, receipt_sent_at = now() WHERE id = $1`, params: [d.id, no] }]);
      await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, 'donation-receipt')`,
        params: [ctx.orgId, d.donor.email, `Your receipt ${no}`, `Assalamu alaikum ${d.donor.name.split(' ')[0]},\n\nJazakAllahu khayran for your gift of ${D.usd(d.amountCents)} on ${d.at.slice(0, 10)} to ${s.funds.find((f) => f.id === d.fund)?.name ?? 'our community'}.\nReceipt ${no}. No goods or services were provided in return for this gift.`] }]);
      sent++;
    }
    return { status: 200, body: { sent } };
  }),
  route('POST', /^\/admin\/payouts$/, async (ctx) => {
    needAny(ctx, 'donations.reconcile', 'finance.manage');
    const P = z.object({ platform: z.enum(D.ONLINE_PLATFORMS), id: z.string().trim().min(2).max(60), amountCents: z.number().int(), feeCents: z.number().int().min(0).default(0), arrivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), bankLast4: z.string().regex(/^\d{0,4}$/).default(''), refs: z.array(z.string().max(60)).min(1).max(5000) });
    const p = P.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the deposit.', issues(p.error)); const b = p.data;
    const gifts = (await rows(ctx.db, API(ctx), `SELECT id, platform_ref, (amount_cents - fee_cents)::int AS net, state FROM app.donations WHERE platform = $1 AND platform_ref = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, [b.platform, JSON.stringify(b.refs)])) as { id: string; platform_ref: string; net: number; state: string }[];
    const missing = b.refs.filter((r) => !gifts.some((g) => g.platform_ref === r));
    const net = gifts.filter((g) => g.state !== 'refunded').reduce((a, g) => a + g.net, 0); const diff = b.amountCents - net;
    await ctx.db.run(API(ctx), [
      { sql: `INSERT INTO app.payouts (org_id, id, platform, amount_cents, fee_cents, arrived_on, bank_last4, matched, gifts, difference_cents) VALUES ($1::uuid, $2, $3, $4::bigint, $5::bigint, $6::date, $7, $8::boolean, $9::int, $10::bigint)
        ON CONFLICT (org_id, platform, id) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, fee_cents = EXCLUDED.fee_cents, arrived_on = EXCLUDED.arrived_on, matched = EXCLUDED.matched, gifts = EXCLUDED.gifts, difference_cents = EXCLUDED.difference_cents`,
        params: [ctx.orgId, b.id, b.platform, b.amountCents, b.feeCents, b.arrivedOn, b.bankLast4, diff === 0 && !missing.length, gifts.length, diff] },
      { sql: `UPDATE app.donations SET payout_id = $2, state = CASE WHEN state = 'awaiting-payout' THEN 'ok' ELSE state END WHERE platform = $1 AND platform_ref = ANY(ARRAY(SELECT jsonb_array_elements_text($3::jsonb)))`, params: [b.platform, b.id, JSON.stringify(b.refs)] }]);
    await audit(ctx, 'donations', 'Deposit matched', `${b.platform} ${b.id}: ${gifts.length} gifts, difference ${D.usd(diff)}`, b.id);
    return { status: 200, body: { matched: diff === 0 && !missing.length, gifts: gifts.length, missing, differenceCents: diff } };
  }),
  route('GET', /^\/admin\/donations\/checkomatic$/, async (ctx) => {
    needAny(ctx, 'donations.view', 'members.view');
    const [c, s] = await Promise.all([centers(ctx), donationSettings(ctx)]);
    const list = D.checkomaticDonors(await loadDonations(ctx, c, `WHERE d.state <> 'refunded'`), s);
    const ids = list.map((x) => x.memberId).filter(Boolean);
    const members = ids.length ? (await rows(ctx.db, API(ctx), `SELECT id, status FROM app.members WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`, [JSON.stringify(ids)])) as { id: string; status: string }[] : [];
    return { status: 200, body: { mode: s.checkomatic.mode, label: D.CHECKOMATIC_MODES[s.checkomatic.mode], donors: list.map((x) => ({ name: x.name, email: x.email, memberId: x.memberId, totalCents: x.total, lastGift: x.last.id, until: x.until, memberStatus: members.find((m) => m.id === x.memberId)?.status ?? '' })) } };
  }),
  route('GET', /^\/member\/giving$/, async (ctx) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const [c, s] = await Promise.all([centers(ctx), donationSettings(ctx)]);
    const m = await one<{ email: string }>(ctx.db, API(ctx), 'SELECT email FROM app.members WHERE id = $1', [ctx.memberId]);
    const list = ((await rows(ctx.db, API(ctx), `${DON_SQL} WHERE d.member_id = $1 OR (d.member_id IS NULL AND $2 <> '' AND d.donor_email = $2) ORDER BY d.given_on DESC`, [ctx.memberId, m?.email ?? ''])) as DRow[]).map((r) => toDonation(r, c));
    const year = Number(ctx.req.query.get('year') ?? todayCT().slice(0, 4));
    const yearList = list.filter((d) => d.at.startsWith(String(year)) && !d.refunded);
    const byYear = Array.from(new Set(list.map((d) => d.at.slice(0, 4)))).sort().reverse().map((y) => ({ year: Number(y), totalCents: list.filter((d) => d.at.startsWith(y) && !d.refunded).reduce((a, d) => a + d.amountCents, 0) }));
    return { status: 200, body: { year, totalCents: yearList.reduce((a, d) => a + d.amountCents, 0), deductibleCents: yearList.reduce((a, d) => a + d.amountCents, 0), byYear,
      gifts: list.map((d) => ({ id: d.id, date: d.at.slice(0, 10), amountCents: d.amountCents, fund: s.funds.find((f) => f.id === d.fund)?.name ?? 'Not assigned yet', center: d.center, campaign: d.campaignId, receipt: d.receiptNo, refunded: d.refunded })) } };
  }),

  /* ---------------- fundraising ---------------- */
  route('GET', /^\/public\/campaigns(?:\/([a-z0-9-]{3,60}))?$/, async (ctx, mm) => {
    const [c, fr] = await Promise.all([centers(ctx), fundraisingDoc(ctx)]);
    const list = F.publicCampaigns(fr, await giftsFor(ctx, c), await pledgesFor(ctx), todayCT());
    if (mm[1]) { const one1 = list.find((x) => x.id === mm[1]); if (!one1) throw new HttpError(404, 'No such campaign.'); return { status: 200, body: { campaign: one1 } }; }
    return { status: 200, body: { enabled: fr.website.enabled, campaigns: list } };
  }),
  route('POST', /^\/member\/campaigns\/([a-z0-9-]{3,60})\/pages$/, async (ctx, mm) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const fr = await fundraisingDoc(ctx); const camp = fr.campaigns.find((x) => x.id === mm[1]);
    if (!camp || F.campaignState(camp, todayCT()) !== 'live' || !camp.p2p.enabled) throw new HttpError(409, 'This campaign does not take personal pages now.');
    const b = body(ctx); const title = String(b.title ?? '').trim(); const story = String(b.story ?? '').trim().slice(0, 1200); const goal = Number(b.goalCents ?? 0);
    if (title.length < 3 || title.length > 80) throw new HttpError(422, 'Give the page a title.');
    if (!Number.isInteger(goal) || goal < camp.p2p.minGoalCents || goal > camp.goalCents) throw new HttpError(422, `Set a goal between ${F.usd(camp.p2p.minGoalCents)} and ${F.usd(camp.goalCents)}.`);
    if (fr.pages.filter((p) => p.owner.memberId === ctx.memberId && p.campaignId === camp.id && p.status !== 'rejected').length) throw new HttpError(409, 'You already have a page for this campaign.');
    const m = await one<{ first_name: string; last_name: string }>(ctx.db, API(ctx), 'SELECT first_name, last_name FROM app.members WHERE id = $1', [ctx.memberId]);
    let id = F.slug(title); while (fr.pages.some((p) => p.id === id)) id = `${F.slug(title).slice(0, 44)}-${Math.random().toString(36).slice(2, 6)}`;
    const page: F.P2PPage = { id: id.length >= 3 ? id : `${id}-page`, campaignId: camp.id, owner: { name: `${m!.first_name} ${m!.last_name.slice(0, 1)}.`, memberId: ctx.memberId }, title, story, goalCents: goal, status: camp.p2p.approval ? 'pending' : 'approved', createdOn: todayCT(), note: '' };
    const next = { ...fr, pages: [...fr.pages, page] }; const v = F.FundraisingSchema.safeParse(next); if (!v.success) throw new HttpError(422, 'The page has problems.', issues(v.error));
    await saveDocument(ctx.db, ctx.orgId, 'fundraising', v.data, `Member ${ctx.memberId}`, `Personal page: ${title}`);
    return { status: 201, body: { page, waitsForApproval: page.status === 'pending' } };
  }),
  route('GET', /^\/admin\/fundraising$/, async (ctx) => {
    needAny(ctx, 'fundraising.manage', 'donations.view');
    const [c, fr, s] = await Promise.all([centers(ctx), fundraisingDoc(ctx), donationSettings(ctx)]); const today = todayCT();
    const [gifts, pledges] = await Promise.all([giftsFor(ctx, c), pledgesFor(ctx)]);
    const year = Number(ctx.req.query.get('year') ?? today.slice(0, 4));
    return { status: 200, body: {
      campaigns: fr.campaigns.map((x) => ({ ...x, state: F.campaignState(x, today), progress: F.progress(x, gifts, pledges, today), matching: F.matching(x, gifts), pages: fr.pages.filter((p) => p.campaignId === x.id).map((p) => ({ ...p, ...F.pageProgress(p, gifts) })) })),
      pledges: pledges.map((p) => ({ ...p, ...F.pledgeStatus(p, gifts, today) })),
      warnings: F.fundraisingWarnings(fr, gifts, pledges, today, s.funds.filter((f) => f.active).map((f) => f.id)),
      insights: F.donorInsights(gifts, year),
      gifts: ctx.req.query.get('gifts') === '1' ? gifts : undefined } };   // ?gifts=1: the campaign gifts themselves (the admin's screens)
  }),
  route('POST', /^\/admin\/fundraising\/pages\/([a-z0-9-]{3,60})\/decision$/, async (ctx, mm) => {
    need(ctx, 'fundraising.manage');
    const fr = await fundraisingDoc(ctx); const page = fr.pages.find((p) => p.id === mm[1]); if (!page) throw new HttpError(404, 'No such page.');
    const b = body(ctx); const decision = String(b.decision ?? ''); const note = String(b.note ?? '').trim().slice(0, 300);
    const to = ({ approve: 'approved', reject: 'rejected', hide: 'hidden' } as const)[decision as 'approve']; if (!to) throw new HttpError(400, 'Decide approve, reject or hide.');
    if (to !== 'approved' && note.length < 3) throw new HttpError(400, 'Say why – the member reads it.');
    const v = F.FundraisingSchema.safeParse({ ...fr, pages: fr.pages.map((p) => (p.id === page.id ? { ...p, status: to, note } : p)) }); if (!v.success) throw new HttpError(422, 'Cannot do that.', issues(v.error));
    await saveDocument(ctx.db, ctx.orgId, 'fundraising', v.data, ctx.me!.name, `Page ${page.id}: ${to}`);
    if (page.owner.memberId) {
      const m = await one<{ email: string }>(ctx.db, API(ctx), 'SELECT email FROM app.members WHERE id = $1', [page.owner.memberId]);
      if (m?.email) await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, 'fundraising-page')`, params: [ctx.orgId, m.email, `Your fundraising page: ${page.title}`, to === 'approved' ? 'Your page is live – share it with family and friends.' : `Your page is ${to}. ${note}`] }]);
    }
    await audit(ctx, 'fundraising', `Page ${to}`, `${page.title}${note ? ` – ${note}` : ''}`, page.id);
    return { status: 200, body: { id: page.id, status: to } };
  }),
  route('GET', /^\/admin\/pledges$/, async (ctx) => {
    needAny(ctx, 'fundraising.manage', 'donations.view');
    const c = await centers(ctx); const [gifts, pledges] = await Promise.all([giftsFor(ctx, c), pledgesFor(ctx)]); const camp = ctx.req.query.get('campaign');
    return { status: 200, body: { pledges: pledges.filter((p) => !camp || p.campaignId === camp).map((p) => ({ ...p, ...F.pledgeStatus(p, gifts, todayCT()) })) } };
  }),
  route('POST', /^\/admin\/pledges$/, async (ctx) => {
    need(ctx, 'fundraising.manage');
    const P = z.object({ campaignId: z.string(), name: z.string().trim().min(2).max(80), email: z.union([z.literal(''), z.string().trim().toLowerCase().email()]).default(''), memberId: z.string().max(20).default(''), totalCents: z.number().int().min(100).max(1_000_000_000), dueBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
    const p = P.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the pledge.', issues(p.error)); const b = p.data;
    const fr = await fundraisingDoc(ctx); const camp = fr.campaigns.find((x) => x.id === b.campaignId); if (!camp || camp.status === 'draft') throw new HttpError(422, 'Pick a campaign.');
    if (!(await one(ctx.db, API(ctx), 'SELECT 1 AS x FROM app.campaigns WHERE id = $1', [camp.id]))) throw new HttpError(409, `The campaign's fund “${camp.fund}” is not a donation fund.`);
    if (b.dueBy < todayCT()) throw new HttpError(422, 'The due date has passed.');
    const ref = `P-${(await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, 'pledge', 1001)::text AS n`, [ctx.orgId]))!.n}`;
    const key = donorKey({ memberId: b.memberId.toUpperCase(), email: b.email, name: b.name });
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.pledges (org_id, campaign_id, member_id, donor_name, donor_email, donor_key, amount_cents, due_on, ref, created_by) VALUES ($1::uuid, $2, NULLIF($3, ''), $4, $5, $6, $7::bigint, $8::date, $9, $10)`,
      params: [ctx.orgId, camp.id, b.memberId.toUpperCase(), b.name, b.email, key, b.totalCents, b.dueBy, ref, ctx.me!.name] }]);
    await audit(ctx, 'fundraising', 'Pledge recorded', `${ref} ${b.name} ${F.usd(b.totalCents)} for ${camp.name}`, ref);
    return { status: 201, body: { id: ref, donorKey: key } };
  }),
];
const ONLINE_NOTE = (p: D.Platform) => (D.ONLINE.includes(p) ? `Refund it on ${D.PLATFORMS[p]} too – the platform sends the money back.` : 'Return the cash or check to the donor and keep a note.');
