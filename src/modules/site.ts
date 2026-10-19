/**
 * C1 – what our own website server needs from the API (the browser never calls these directly).
 *   GET /site/documents/:key   the organization's whole document (or its starter content) for the website's server
 *                              components – they filter before anything reaches a browser, exactly as in demo mode.
 *                              Only our apps (x-edge-key) may ask in production; keys with secrets are never served.
 *   POST /public/members/verify {memberId, lastName, zip}  the public "is this person a member?" check: all three
 *                              must match; answers only active / not found (20 tries per address per 15 minutes)
 *   GET /member/portal         the signed-in member's home: card, voting checks, payments, household, groups – the
 *                              shape the website's member pages and the mobile app use.
 */
import { one, rows } from '../db/sql.js';
import { HttpError, document, fromEdge, needMember, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { isDocKey } from '../registry.js';
import { eligibility, paidThroughOf, planDef, statusOf } from '@/lib/members/members';
import { MembershipSettingsSchema, mockMembershipSettings } from '@/lib/content/membership';
import { MEMBER_SQL, toMember, type MemberRow } from './member-shape.js';

/** The documents the website reads (web/src/lib/api/demo-store.ts DEMO_STORE_KEYS, without admin-access). */
export const SITE_KEYS = ['site-config', 'home', 'membership-settings', 'giving', 'pages', 'news', 'themes', 'join-form', 'events', 'groups', 'communication', 'org-config', 'benefits', 'officials', 'org-structure', 'prayer-times', 'fundraising', 'sign-in', 'records', 'elections', 'work-settings'] as const;
const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });

/** Next record date on or after today: the election year whose voter list this member is working towards. */
export const electionYear = (today: string) => (today.slice(5) <= '06-30' ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) + 1);

const tries = new Map<string, number[]>();
function limited(key: string, max = 20, ms = 15 * 60_000) {
  const now = Date.now(); const list = (tries.get(key) ?? []).filter((t) => now - t < ms); list.push(now); tries.set(key, list);
  if (tries.size > 10_000) for (const [k, v] of tries) if (!v.some((t) => now - t < ms)) tries.delete(k);
  return list.length > max;
}

export const SITE_ROUTES: Route[] = [
  route('POST', /^\/public\/members\/verify$/, async (ctx) => {
    const b = (ctx.req.body ?? {}) as Record<string, unknown>;
    if (limited(`${ctx.orgId}|${ctx.req.ip ?? ''}`)) throw new HttpError(429, 'Too many checks – please try again later.');
    const id = String(b.memberId ?? '').trim().toUpperCase(); const last = String(b.lastName ?? '').trim().toLowerCase(); const zip = String(b.zip ?? '').trim().slice(0, 5);
    if (!/^[A-Z]{2,5}-\d{4,8}$/.test(id) || last.length < 2 || !/^\d{5}$/.test(zip)) throw new HttpError(422, 'Enter the member ID, last name and ZIP code.');
    const row = await one<MemberRow>(ctx.db, API(ctx), `${MEMBER_SQL} WHERE m.id = $1 AND lower(m.last_name) = $2 AND left(m.zip, 5) = $3 AND m.archived IS NULL`, [id, last, zip]);
    if (!row) return { status: 200, body: { found: false } };
    const m = toMember(row); const msp = MembershipSettingsSchema.safeParse(await document(ctx.db, ctx.orgId, 'membership-settings')); const ms = msp.success ? msp.data : mockMembershipSettings;
    const today = todayCT(); const st = String((row as { status?: string }).status ?? statusOf(m, Number(today.slice(0, 4))));   // the database's status (paid-through aware)
    if (st !== 'active' && st !== 'life') return { status: 200, body: { found: false } };
    const through = planDef(m, ms.plans).term === 'lifetime' ? null : paidThroughOf(m, ms.plans);
    return { status: 200, body: { found: true, status: 'Active', validThrough: through ? `${through.slice(5, 7)}/${through.slice(8, 10)}/${through.slice(0, 4)}` : 'Lifetime', votingEligible: eligibility(m, electionYear(today), ms.plans, ms.rules).eligible } };
  }),

  route('GET', /^\/site\/documents\/([a-z0-9-]+)$/, async (ctx, mm) => {
    if (!fromEdge(ctx.req) && process.env.TENANT_FROM_HOST === '1') throw new HttpError(403, 'Only the organization’s website may read this.');
    const key = mm[1];
    if (!isDocKey(key) || !(SITE_KEYS as readonly string[]).includes(key)) throw new HttpError(404, 'Not a website document.');
    const r = await one<{ version: number; published_at: string }>(ctx.db, API(ctx), 'SELECT version, published_at::text FROM app.documents WHERE key = $1', [key]);
    return { status: 200, headers: { 'cache-control': 'no-store' }, body: { key, data: await document(ctx.db, ctx.orgId, key), version: r?.version ?? 0, publishedAt: r?.published_at ?? null, source: r ? 'published' : 'default' } };
  }),

  route('GET', /^\/member\/portal$/, async (ctx) => {
    const id = needMember(ctx);
    const row = await one<MemberRow>(ctx.db, API(ctx), `${MEMBER_SQL} WHERE m.id = $1 AND m.archived IS NULL`, [id]);
    if (!row) throw new HttpError(404, 'Your record is not available.');
    const m = toMember(row);
    const msp = MembershipSettingsSchema.safeParse(await document(ctx.db, ctx.orgId, 'membership-settings'));
    const ms = msp.success ? msp.data : mockMembershipSettings;
    const today = todayCT(); const year = electionYear(today);
    const plan = planDef(m, ms.plans);
    const st = String((row as { status?: string }).status ?? statusOf(m, Number(today.slice(0, 4))));   // app.refresh_status keeps it (paid-through aware)
    const el = eligibility(m, year, ms.plans, ms.rules);
    const spouse = m.spouseId ? await one<{ first_name: string; last_name: string; status: string }>(ctx.db, API(ctx), 'SELECT first_name, last_name, status FROM app.members WHERE id = $1', [m.spouseId]) : null;
    const groups = (await rows(ctx.db, API(ctx), `SELECT group_id, status FROM app.group_members WHERE member_id = $1 AND status IN ('in', 'asked')`, [id])) as { group_id: string; status: string }[];
    const paidYears = m.payments.map((p) => p.year);
    return { status: 200, body: { member: {
      email: m.email, firstName: m.first, lastName: m.last, memberId: m.id, plan: plan.name, planId: plan.id,
      memberSince: m.joined, status: st === 'pending' ? 'Pending approval' : st === 'active' || st === 'life' ? 'Active' : st === 'expired' || st === 'lapsed' ? 'Expired' : 'Inactive',
      validThrough: plan.term === 'lifetime' ? null : paidThroughOf(m, ms.plans), paidThroughYear: plan.term === 'lifetime' ? null : paidYears.length ? Math.max(...paidYears) : null,
      zone: m.zone, center: m.center, phone: m.phone, address: [m.street, `${m.city}${m.city ? ', ' : ''}${m.zip}`].filter((x) => x.trim()),
      household: spouse ? [{ name: `${spouse.first_name} ${spouse.last_name}`, relation: 'Spouse', status: spouse.status }] : [],
      votingYear: year, eligible: el.eligible,
      checks: el.checks.map((c) => ({ label: c.label, state: c.ok ? 'ok' : c.fix === 'payment' ? 'todo' : c.id === 'id' || /photo id/i.test(c.label) ? (m.idCheck === 'pending' ? 'wait' : 'todo') : 'no', note: c.reason })),
      payments: [...m.payments].reverse().map((p) => ({ date: String(p.paidOn).slice(0, 10), label: plan.term === 'lifetime' ? plan.name : `${p.year} ${plan.name}`, amountCents: p.amountCents, receipt: p.ref })),
      idVerified: m.idCheck === 'verified',
      groupIds: groups.filter((g) => g.status === 'in').map((g) => g.group_id), requestedGroupIds: groups.filter((g) => g.status === 'asked').map((g) => g.group_id),
    } } };
  }),
];
