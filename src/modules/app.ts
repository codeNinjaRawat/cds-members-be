/**
 * C5 The member app (mobile/) on the API. Every answer has the shape mobile/src/data/contracts*.ts reads; the work is
 * done by the same routes and rules as the website (called with `inner`), so the app never decides prices, places or
 * eligibility itself. The app names its organization with `x-org` (it has no address of its own).
 *
 * Sign-in (no account needed first):
 *   POST /app/auth/otp/start {channel, value}           a 6-digit code; members get a sign-in code, a new address a join code
 *                                                        (the answer is the same either way)
 *   POST /app/auth/otp/verify {channel, value, code}    members → tokens; a new address → { tokens: null, joinToken }
 *   POST /app/auth/token/refresh {refreshToken}         a new pair (each refresh token works once; reuse ends the chain)
 *   POST /app/auth/logout {allDevices}                  this phone, or every sign-in of this person here
 * Public: GET /app/bootstrap · GET /app/masjids · GET /app/join/options · POST /app/residency {address}
 *         POST /app/join/applications · POST /app/crashes
 * Member (Bearer access token): me, notifications (+ /read), renewals/options|quote, renewals, payments, household
 *   (+ /invites), profile (GET, PATCH), center-requests, id-checks (+ /:id/complete), masjid, events (+ /:id,
 *   /:id/register, /:id/cancel), giving/options, giving/donations, benefits, election, preferences (GET, PATCH),
 *   data-export, devices, prayer-times, family (GET, POST), community, groups/:id/join, check-o-matic (GET, PATCH,
 *   /pay-now). Office: POST /admin/member-card/check {token} – what a scanned member card says (members.view).
 * Card payments open the payment provider's page: answers carry `checkoutUrl` and the app opens it.
 * Writes sent with `Idempotency-Key` are answered once; the same key again gets the first answer (one day).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, rows, type Statement } from '../db/sql.js';
import { HttpError, PLATFORM, audit, document, inner, need, needMember, orgTz, route, todayCT, type Ctx, type Res, type Route } from '../http/core.js';
import { checkCode, devCodes, event, IP_CODES, locked, lookup, normalize, sendCode, signInSettings } from '../auth/routes.js';
import { newToken, sha256hex, signLink } from '../auth/crypto.js';
import { electionYear } from './site.js';
import { registrationsByEmail } from './events.js';
import { donationSettings } from './giving.js';
import { MembershipSettingsSchema, mockMembershipSettings, DEFAULT_LIFECYCLE, type Plan } from '@/lib/content/membership';
import { priceFor, canRenew } from '@/lib/content/renewal';
import { JoinFormSchema, defaultJoinForm } from '@/lib/join/form-def';
import { OrgConfigSchema, mockOrgConfig, payMethods } from '@/lib/community/org-config';
import { checkoutTotal, type PayMethod } from '@/lib/community/payments';
import { BenefitsSchema, mockBenefits, CATEGORIES, LIMIT } from '@/lib/community/benefits';
import { OfficialsSchema, mockOfficials, seatLabel } from '@/lib/community/officials';
import { RecordsSchema, mockRecords, recordsFor } from '@/lib/community/records';
import { PrayerSettingsSchema, mockPrayerSettings, dayTimes, clock, IQAMAH_PRAYERS, PRAYERS, PRAYER_NAME } from '@/lib/community/prayer';
import * as E from '@/lib/community/events';
import type { Family, Person } from '@/lib/family/family';
import { siteOf } from './join-drafts.js';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const ACCESS_MIN = 15;
const parse = async <S extends z.ZodTypeAny>(ctx: Ctx, key: string, schema: S, fallback: z.output<S>): Promise<z.output<S>> => { const p = schema.safeParse(await document(ctx.db, ctx.orgId, key)); return p.success ? p.data : fallback; };
const settingsOf = (ctx: Ctx) => parse(ctx, 'membership-settings', MembershipSettingsSchema, mockMembershipSettings);
const configOf = (ctx: Ctx) => parse(ctx, 'org-config', OrgConfigSchema, mockOrgConfig);
const mask = (a: string) => (a.includes('@') ? a.replace(/^(.)[^@]*(@.*)$/, '$1•••$2') : `•••-•••-${a.replace(/\D/g, '').slice(-4)}`);
const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const nowLocal = () => new Date().toLocaleString('sv-SE', { timeZone: orgTz() }).slice(0, 16).replace(' ', 'T');
/** The app pays with the card page (Apple Pay and Google Pay show there as well) or a bank transfer. */
const appMethods = (cfg: Awaited<ReturnType<typeof configOf>>) => [...(cfg.payments.card ? ['wallet', 'card'] : []), ...(cfg.payments.ach ? ['ach'] : [])] as ('wallet' | 'card' | 'ach')[];
const payMethodOf = (m: unknown): PayMethod => (m === 'ach' ? 'ach' : 'card');

/* ---------------- tokens ---------------- */
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };
async function issue(ctx: Ctx, p: { userId: string; memberId: string; family?: string }): Promise<Tokens> {
  const family = p.family ?? randomUUID(); const access = newToken(); const refresh = newToken();
  await ctx.db.run(PLATFORM, [
    { sql: `INSERT INTO platform.sessions (id, user_id, org_id, kind, dashboard, member_id, method, two_step_ok, idle_minutes, expires_at, ip, user_agent, app_family)
        VALUES (decode($1, 'hex'), $2::uuid, $3::uuid, 'member', 0, $4, 'app', false, $5::int, now() + make_interval(mins => $5::int), NULLIF($6, '')::inet, $7, $8::uuid)`,
      params: [sha256hex(access), p.userId, ctx.orgId, p.memberId, ACCESS_MIN, ctx.req.ip ?? '', String(ctx.req.headers['x-client'] ?? ctx.req.headers['user-agent'] ?? '').slice(0, 300), family] },
    { sql: `INSERT INTO platform.app_refresh_tokens (id, family, user_id, org_id, member_id, device) VALUES (decode($1, 'hex'), $2::uuid, $3::uuid, $4::uuid, $5, $6)`,
      params: [sha256hex(refresh), family, p.userId, ctx.orgId, p.memberId, String(ctx.req.headers['x-client'] ?? '').slice(0, 80)] },
  ]);
  return { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + ACCESS_MIN * 60_000 };
}
async function endFamily(ctx: Ctx, family: string) {
  await ctx.db.run(PLATFORM, [
    { sql: `UPDATE platform.app_refresh_tokens SET revoked_at = now() WHERE family = $1::uuid AND revoked_at IS NULL`, params: [family] },
    { sql: `UPDATE platform.sessions SET revoked_at = now() WHERE app_family = $1::uuid AND revoked_at IS NULL`, params: [family] }]);
  await ctx.db.run(API(ctx), [{ sql: `DELETE FROM app.member_devices WHERE family = $1::uuid`, params: [family] }]);
}
async function userFor(ctx: Ctx, email: string) {
  if (!email) throw new HttpError(400, 'Sign in with the email address on your membership.');
  return (await one<{ id: string }>(ctx.db, PLATFORM, `INSERT INTO platform.users (email, last_login_at) VALUES ($1, now()) ON CONFLICT (email) DO UPDATE SET last_login_at = now() RETURNING id::text`, [email]))!.id;
}
/** A notice on the member's bell in the app. */
export async function notifyMember(ctx: Ctx, memberId: string, n: { kind: 'membership' | 'masjid' | 'events' | 'household' | 'security' | 'giving'; title: string; body?: string; link?: string }) {
  await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.member_notifications (org_id, member_id, kind, title, body, link) VALUES ($1::uuid, $2, $3, $4, $5, $6)`, params: [ctx.orgId, memberId, n.kind, n.title.slice(0, 160), (n.body ?? '').slice(0, 600), n.link ?? ''] }]);
}

/* ---------------- a write repeated with the same Idempotency-Key ---------------- */
type H = (ctx: Ctx, mm: RegExpMatchArray) => Promise<Res>;
const once = (h: H): H => async (ctx, mm) => {
  const key = String(ctx.req.headers['idempotency-key'] ?? '');
  if (!/^[A-Za-z0-9:._-]{8,100}$/.test(key)) return h(ctx, mm);
  const who = ctx.memberId ?? `ip:${ctx.req.ip ?? ''}`;
  const seen = await one<{ path: string; status: number; body: unknown }>(ctx.db, API(ctx), `SELECT path, status, body FROM app.app_requests WHERE who = $1 AND key = $2 AND at > now() - interval '1 day'`, [who, key]);
  if (seen) { if (seen.path !== ctx.req.path) throw new HttpError(409, 'This request key was used for something else.'); return { status: seen.status, body: seen.body }; }
  const res = await h(ctx, mm);
  if (res.status < 300) await ctx.db.run(API(ctx), [
    { sql: `DELETE FROM app.app_requests WHERE at < now() - interval '1 day'`, params: [] },
    { sql: `INSERT INTO app.app_requests (org_id, who, key, path, status, body) VALUES ($1::uuid, $2, $3, $4, $5::int, $6::jsonb) ON CONFLICT (org_id, who, key) DO NOTHING`, params: [ctx.orgId, who, key, ctx.req.path, res.status, JSON.stringify(res.body ?? null)] }]);
  return res;
};
const ok = (b: unknown, status = 200): Res => ({ status, body: b });

/* ---------------- the member ---------------- */
type Portal = { email: string; firstName: string; lastName: string; memberId: string; plan: string; planId: string; memberSince: number; status: string; validThrough: string | null; zone: string; center: string; phone: string; address: string[];
  household: { name: string; relation: string; status: string }[]; votingYear: number; eligible: boolean; checks: { label: string; state: string; note: string }[]; payments: { date: string; label: string; amountCents: number; receipt: string }[]; idVerified: boolean };
const portal = async (ctx: Ctx) => (await inner<{ member: Portal }>(ctx, 'GET', '/member/portal')).member;
type Row = { id: string; first_name: string; last_name: string; preferred_name: string; email: string; phone: string; street: string; city: string; state: string; zip: string; plan: string; status: string; center: string; zone: string; spouse_id: string | null; id_check: string; prefs: Record<string, unknown> | null; paid_through: string | null; dob: string | null };
async function row(ctx: Ctx): Promise<Row> {
  const id = needMember(ctx);
  const r = await one<Row>(ctx.db, API(ctx), `SELECT id, first_name, last_name, preferred_name, email, phone, street, city, state, zip, plan, status, center, zone, spouse_id, id_check, prefs, paid_through::text, dob::text FROM app.members WHERE id = $1 AND archived IS NULL`, [id]);
  if (!r) throw new HttpError(404, 'Your record is not available.');
  return r;
}
const appStatus = (s: string) => (s === 'Inactive' ? 'Expired' : s) as 'Active' | 'Expired' | 'Pending approval';
/** The member card's QR: who, until when, signed by this server (a screenshot stops working after a few minutes). */
function cardToken(ctx: Ctx, memberId: string) { const exp = Math.floor(Date.now() / 1000) + 300; const base = `${ctx.slug}.${memberId}.${exp}`; return `MS1.${base}.${signLink(`card|${base}`)}`; }

async function meOf(ctx: Ctx) {
  const p = await portal(ctx); const ms = await settingsOf(ctx);
  const rn = await inner<{ canRenew: { ok: boolean; opensOn: string | null }; options: { through: string }[] }>(ctx, 'GET', '/member/renewal').catch(() => null);
  const snap = await one<{ frozen_at: string }>(ctx.db, API(ctx), 'SELECT frozen_at::text FROM app.voter_snapshots WHERE year = $1 ORDER BY version DESC LIMIT 1', [p.votingYear]);
  return {
    profile: { firstName: p.firstName, lastName: p.lastName, email: p.email, phone: p.phone, address: p.address },
    memberId: p.memberId, plan: p.plan, memberSince: p.memberSince, status: appStatus(p.status), validThrough: p.validThrough, zone: p.zone, center: p.center, household: p.household,
    eligibility: { year: p.votingYear, eligible: p.eligible, frozenOn: snap?.frozen_at ?? null, checks: p.checks.map((c, i) => ({ key: `check-${i + 1}`, label: c.label, state: c.state, note: c.note })) },
    nextEligibility: null,
    payments: p.payments.map((x) => ({ ...x, status: 'paid' })),
    idVerified: p.idVerified,
    card: { qr: cardToken(ctx, p.memberId), refreshSec: 240 },
    renewal: rn ? { open: rn.canRenew.ok, forYear: rn.options[0]?.through ? Number(rn.options[0].through.slice(0, 4)) : ms.year, opensOn: rn.canRenew.opensOn ?? '' } : null,
  };
}

/* ---------------- renewals ---------------- */
async function renewalBasics(ctx: Ctx) {
  const m = await row(ctx); const [ms, cfg] = await Promise.all([settingsOf(ctx), configOf(ctx)]);
  const plan = ms.plans.find((p) => p.id === m.plan); if (!plan) throw new HttpError(404, 'Your plan is not available – contact the office.');
  const lc = ms.lifecycle ?? DEFAULT_LIFECYCLE; const today = todayCT();
  return { m, ms, cfg, plan, lc, today, may: canRenew(plan, m.paid_through, today, lc) };
}
const unitOf = (p: Plan) => (p.term === 'lifetime' ? 'once' : p.term === 'recurring' ? 'month' : 'year');
const Choice = z.object({ planId: z.string(), years: z.number().int().min(1).max(10), payerId: z.string().default('self'), pledgeVersion: z.string().default('') });
function quoteOf(b: Awaited<ReturnType<typeof renewalBasics>>, years: number, method: PayMethod) {
  const price = priceFor(b.plan, { start: b.today, years, saleYear: b.ms.year, current: b.m.paid_through, extendWithinDays: b.lc.overdueDays });
  const total = checkoutTotal(b.cfg, { label: `${b.plan.name} renewal`, kind: 'dues', priceCents: price.totalCents, planId: b.plan.id, method, today: b.today });
  return { price, total };
}

/* ---------------- events ---------------- */
type Reg = { id: string; eventId: string; status: string; seats: number; totalCents: number; paidCents: number; cancel: { allowed: boolean; text: string } | null };
async function viewer(ctx: Ctx): Promise<E.Viewer> {
  const m = await one<{ plan: string }>(ctx.db, API(ctx), 'SELECT plan FROM app.members WHERE id = $1', [ctx.memberId]);
  const g = (await rows(ctx.db, API(ctx), `SELECT group_id FROM app.group_members WHERE member_id = $1 AND status = 'in'`, [ctx.memberId])) as { group_id: string }[];
  return { signedIn: true, planId: m?.plan, groupIds: g.map((x) => x.group_id) };
}
/** The visitor behind a request without a token: `contactId` in the body → app.contacts (see contacts.ts). */
async function contactOf(ctx: Ctx): Promise<{ first_name: string; last_name: string; email: string; phone: string } | null> {
  const id = String(body(ctx).contactId ?? ctx.req.query.get('contactId') ?? '');
  return /^[0-9a-f-]{36}$/.test(id) ? one<{ first_name: string; last_name: string; email: string; phone: string }>(ctx.db, API(ctx), 'SELECT first_name, last_name, email::text, phone FROM app.contacts WHERE id = $1::uuid', [id]) : null;
}
async function visitorOf(ctx: Ctx): Promise<{ first_name: string; last_name: string; email: string; phone: string | null }> {
  const c = await contactOf(ctx);
  if (!c) throw new HttpError(401, 'Tell us who you are first (My masjid), or sign in.', undefined, 'sign-in');
  return c;
}
function eventItem(e: E.EventItem, v: E.Viewer, regs: Reg[], now: string) {
  const mine = regs.find((r) => r.eventId === e.id && ['confirmed', 'pending-payment', 'waitlist'].includes(r.status)) ?? regs.find((r) => r.eventId === e.id);
  const st = E.registrationState(e, now); const types = e.registration.types.filter((t) => t.enabled && t.availability !== 'code' && E.typeAvailable(t, v, undefined, e).ok);
  const left = E.spotsLeft(e);
  const active = mine && ['confirmed', 'pending-payment', 'waitlist'].includes(mine.status);
  return {
    id: e.id, title: e.title, startsAt: e.start, endsAt: e.end, location: [e.location.name, e.location.address].filter(Boolean).join(', '), center: e.location.center ?? null,
    audience: e.visibility === 'public' ? 'Everyone' : e.visibility === 'members' ? 'Members' : 'Groups', category: e.category, description: e.summary,
    priceCents: types.length ? Math.min(...types.map((t) => t.priceCents)) : 0, seatsLeft: Number.isFinite(left) ? left : null,
    registration: { status: !mine ? 'none' : mine.status === 'waitlist' ? 'waitlisted' : active ? 'registered' : 'cancelled', seats: mine?.seats ?? 0, ticket: active ? mine!.id : null, qr: active ? mine!.id : null, refundUntil: null },
    canRegister: !active && st.open && types.length > 0, reason: active ? (mine!.status === 'pending-payment' ? 'Your place is held until it is paid.' : null) : !st.open ? st.reason ?? null : types.length ? null : 'Not open to you – ask the office.',
    checkoutUrl: null as string | null,
  };
}
/** Events for a member (their registrations, member-only types) or for a visitor (public events, no registrations). */
async function eventsFor(ctx: Ctx) {
  if (!ctx.memberId) {
    const list = await inner<{ events: E.EventItem[] }>(ctx, 'GET', '/public/events');
    const v: E.Viewer = { signedIn: false, groupIds: [] };
    // a visitor with a contact (?contactId= or in the body) sees their own registrations too
    const c = await contactOf(ctx);
    const regs = c ? ((await registrationsByEmail(ctx, c.email)) as unknown as Reg[]) : [];
    return { events: list.events.filter((e) => E.canSee(e, v)), regs, v, now: nowLocal() };
  }
  const [list, regs, v] = await Promise.all([inner<{ events: E.EventItem[] }>(ctx, 'GET', '/public/events'), inner<{ registrations: Reg[] }>(ctx, 'GET', '/member/events/registrations'), viewer(ctx)]);
  return { events: list.events, regs: regs.registrations, v, now: nowLocal() };
}
async function oneEvent(ctx: Ctx, id: string) {
  const x = await eventsFor(ctx); const e = x.events.find((y) => y.id === id); if (!e) throw new HttpError(404, 'Event not found.');
  return { ...x, e, item: eventItem(e, x.v, x.regs, x.now) };
}

/* ---------------- family: the tree the website keeps, as the app lists it ---------------- */
const SUPPORTED = ['Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Brother', 'Sister'] as const;
function familyView(f: Family, today: string) {
  const root = f.rootId; const byId = new Map(f.people.map((p) => [p.id, p]));
  const rel = new Map<string, { relation: string; generation: number }>([[root, { relation: 'Self', generation: 0 }]]);
  const sexed = (p: Person, m: string, w: string) => (p.sex === 'f' ? w : m);
  const parentsOf = (id: string) => f.unions.filter((u) => u.children.includes(id));
  for (const u of parentsOf(root)) {
    for (const pid of [u.a, u.b].filter(Boolean) as string[]) { const p = byId.get(pid); if (p && !p.placeholder) rel.set(pid, { relation: sexed(p, 'Father', 'Mother'), generation: -1 });
      for (const g of parentsOf(pid)) for (const gid of [g.a, g.b].filter(Boolean) as string[]) { const gp = byId.get(gid); if (gp && !gp.placeholder && !rel.has(gid)) rel.set(gid, { relation: sexed(gp, 'Grandfather', 'Grandmother'), generation: -2 }); } }
    for (const c of u.children) { const p = byId.get(c); if (p && c !== root && !rel.has(c)) rel.set(c, { relation: sexed(p, 'Brother', 'Sister'), generation: 0 }); }
  }
  for (const u of f.unions.filter((x) => x.a === root || x.b === root)) {
    const other = u.a === root ? u.b : u.a; const o = other ? byId.get(other) : undefined; if (o && !o.placeholder) rel.set(o.id, { relation: 'Spouse', generation: 0 });
    for (const c of u.children) { const p = byId.get(c); if (p && !rel.has(c)) { rel.set(c, { relation: sexed(p, 'Son', 'Daughter'), generation: 1 });
      for (const g of f.unions.filter((x) => x.a === c || x.b === c)) for (const gc of g.children) { const q = byId.get(gc); if (q && !rel.has(gc)) rel.set(gc, { relation: sexed(q, 'Grandson', 'Granddaughter'), generation: 2 }); } } }
  }
  const people = f.people.filter((p) => !p.placeholder).map((p) => {
    const r = rel.get(p.id) ?? { relation: 'Relative', generation: 0 }; const by = p.born ? Number(p.born.slice(0, 4)) : null;
    const adultOn = p.born && p.born.length === 10 ? `${Number(p.born.slice(0, 4)) + 18}${p.born.slice(4)}` : by ? `${by + 18}-01-01` : null;
    return { id: p.id, name: `${p.first} ${p.last}`.trim(), relation: r.relation, generation: r.generation, birthYear: by, memberStatus: p.member ? ({ active: 'Active', life: 'Life member', expired: 'Expired', pending: 'Pending approval' } as Record<string, string>)[p.member.status] ?? p.member.status : 'Not a member',
      memberId: p.member?.memberId ?? null, isSelf: p.id === root, canJoinOn: r.generation >= 1 && adultOn && adultOn > today ? adultOn : null, addedBy: p.id === root || !p.member ? 'you' : 'office' };
  });
  return { people, relations: [...SUPPORTED], privacy: 'Your family tree is private to you. The office sees only who is a member – never the names of relatives who are not, or your family history.', canEdit: true };
}

/* ---------------- community ---------------- */
async function communityOf(ctx: Ctx, q: string) {
  needMember(ctx);
  const cfg = await configOf(ctx); const d = cfg.members.directory;
  const dir = d.enabled ? await inner<{ people: { name: string; center?: string }[]; listed: boolean }>(ctx, 'GET', '/member/directory') : { people: [], listed: false };
  const gs = await inner<{ groups: { id: string; name: string; description: string; isIn: boolean; requested: boolean; action: 'join' | 'request' | 'leave' | null }[] }>(ctx, 'GET', '/member/groups');
  const doc = await document<{ groups?: { id: string; kind: string; joinPolicy: string; memberIds: string[] }[] }>(ctx.db, ctx.orgId, 'groups');
  const counts = new Map(((await rows(ctx.db, API(ctx), `SELECT group_id, count(*)::int AS n FROM app.group_members WHERE status = 'in' GROUP BY group_id`)) as { group_id: string; n: number }[]).map((r) => [r.group_id, r.n]));
  const t = q.trim().toLowerCase();
  return {
    listed: dir.listed, shows: ['Name', d.showCenter ? 'masjid' : '', d.showPhone ? 'phone' : '', d.showEmail ? 'email' : ''].filter(Boolean).join(', '),
    hides: [!d.showPhone ? 'Phone' : '', !d.showEmail ? 'email' : '', 'address'].filter(Boolean).join(', '),
    members: d.enabled ? dir.people.filter((p) => !t || `${p.name} ${p.center ?? ''}`.toLowerCase().includes(t)).slice(0, 200).map((p, i) => ({ id: `d${i}-${sha256hex(p.name).slice(0, 8)}`, name: p.name, masjid: p.center ?? '', groups: [], canMessage: false })) : [],
    groups: gs.groups.map((g) => { const def = doc?.groups?.find((x) => x.id === g.id); return { id: g.id, name: g.name, kind: def?.kind === 'automatic' ? 'automatic' : def?.joinPolicy === 'request' ? 'request' : 'open', members: counts.get(g.id) ?? def?.memberIds.length ?? 0, joined: g.isIn, pending: g.requested, description: g.description }; }),
    rule: !d.enabled ? 'There is no member directory here.' : d.optIn ? 'Only members can see the directory, and only people who chose to be listed are in it.' : 'Only members can see the directory.',
  };
}

/* ---------------- check-o-matic (monthly gifts that count toward membership) ---------------- */
async function checkOMaticOf(ctx: Ctx) {
  const m = await row(ctx); const ms = await settingsOf(ctx); const rule = ms.rules.qualifyingGifts;
  if (!rule.enabled) throw new HttpError(404, 'Monthly contributions do not count toward membership here.');
  const today = todayCT(); const [mo, da] = rule.cutoff.split('-'); let year = Number(today.slice(0, 4)); if (today.slice(5) > `${mo}-${da}`) year += 1;
  const deadline = `${year}-${mo}-${da}`; const from = `${year - 1}-${mo}-${da}`;
  const s = await donationSettings(ctx); const counts = s.checkomatic.funds.length ? s.checkomatic.funds : s.funds.map((f) => f.id);
  const gifts = (await rows(ctx.db, API(ctx), `SELECT d.given_on::text AS on, d.amount_cents::int AS cents, coalesce(d.fund_id, '') AS fund, d.recurring_id IS NOT NULL AS recurring, d.state FROM app.donations d WHERE d.member_id = $1 AND d.given_on > $2::date AND d.given_on <= $3::date ORDER BY d.given_on DESC`, [m.id, from, deadline])) as { on: string; cents: number; fund: string; recurring: boolean; state: string }[];
  const counted = gifts.filter((g) => g.state !== 'refunded' && counts.includes(g.fund) && (rule.countsGifts === 'any' || g.recurring));
  const pref = ((m.prefs ?? {}) as { checkomatic?: { masjidId?: string; amountCents?: number } }).checkomatic ?? {};
  const centers = (await rows(ctx.db, API(ctx), `SELECT code, name FROM app.centers WHERE active ORDER BY sort, name`)) as { code: string; name: string }[];
  const masjid = centers.find((c) => c.code === pref.masjidId) ?? centers.find((c) => c.name === m.center) ?? centers[0];
  const months = new Map<string, number>(); for (const g of counted) months.set(g.on.slice(0, 7), (months.get(g.on.slice(0, 7)) ?? 0) + g.cents);
  const monthly = counted.some((g) => g.recurring && g.on >= new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10));
  return {
    active: monthly, masjidId: masjid?.code ?? '', masjidLabel: masjid?.name ?? '', amountCents: pref.amountCents ?? counted[0]?.cents ?? rule.minMonthlyCents, minCents: rule.minMonthlyCents,
    nextChargeOn: null, method: monthly ? 'Monthly gift' : 'Not set up', year, paidCents: counted.reduce((a, g) => a + g.cents, 0), thresholdCents: rule.totalCents, deadline,
    history: [...months.entries()].slice(0, 12).map(([month, amountCents]) => ({ month, amountCents, status: 'paid' as const })), problem: null,
    rule: `${rule.label}: monthly gifts of at least ${(rule.minMonthlyCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} that reach ${(rule.totalCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} by ${mdy(deadline)} count as membership for that year.`,
  };
}
async function giftCheckout(ctx: Ctx, p: { fund: string; center: string; amountCents: number; monthly: boolean }) {
  const m = await row(ctx);
  return inner<{ url: string; session: string; amountCents: number }>(ctx, 'POST', '/public/checkout', { kind: 'gift', amountCents: p.amountCents, fund: p.fund, name: `${m.first_name} ${m.last_name}`, email: m.email, monthly: p.monthly, center: p.center, anonymous: false, showName: true });
}

/* ---------------- join ---------------- */
function splitAddress(a: string) {
  const m = /^\s*(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/.exec(a.replace(/\s+/g, ' '));
  return m ? { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] } : null;
}
async function placeOf(ctx: Ctx, address: string) {
  const zip = /(\d{5})(?:-\d{4})?\s*$/.exec(address.trim())?.[1] ?? /\b(\d{5})\b/.exec(address)?.[1];
  if (!zip) throw new HttpError(422, 'Add the ZIP code to your address, like 14210 Cypress Creek Pkwy, Houston, TX 77070.', { address: 'Add the ZIP code to your address.' });
  const p = await inner<{ zone: string | null; zone_name: string | null; center: string | null; center_name: string | null; place: { state: string } | null; nearest: { name: string; id: string }[] }>(ctx, 'GET', `/public/place?zip=${zip}`);
  return { zip, p };
}

/* ---------------- routes ---------------- */
export const APP_ROUTES: Route[] = [
  route('GET', /^\/app\/bootstrap$/, async (ctx) => {
    const org = await one<{ slug: string; name: string; status: string; timezone: string }>(ctx.db, PLATFORM, 'SELECT slug, name, status, timezone FROM platform.organizations WHERE id = $1', [ctx.orgId]);
    const sc = await document<{ org?: { name?: string; shortName?: string; email?: string; phone?: { display?: string } }; announcement?: { id: string; text: string; tone?: string; link?: { href: string }; startsAt?: string; endsAt?: string } | null; announcements?: unknown[] }>(ctx.db, ctx.orgId, 'site-config');
    const [ms, si, ver] = await Promise.all([settingsOf(ctx), signInSettings(ctx.db, ctx.orgId), one<{ v: string }>(ctx.db, API(ctx), `SELECT coalesce(max(published_at), now())::text AS v FROM app.documents`)]);
    const site = (await siteOf(ctx)); const ann = sc?.announcement;
    return ok({
      org: { slug: org!.slug, name: sc?.org?.name || org!.name, shortName: sc?.org?.shortName || org!.slug.toUpperCase(), state: org!.status === 'maintenance' ? 'maintenance' : 'active', supportEmail: sc?.org?.email ?? '', supportPhone: sc?.org?.phone?.display ?? '', timezone: org!.timezone || 'America/Chicago' },
      flags: { 'auth.google': false, 'notify.sms': si.methods.phoneCode && ms.flags.sms, 'notify.push': process.env.APP_PUSH === '1', 'payments.wallets': false },
      otp: { length: 6, expiresMin: 10, resendSec: ms.otp.resendSeconds },
      quietHours: null,
      links: { join: `${site}/join`, help: `${site}/help`, privacy: ms.legal.privacyUrl || `${site}/privacy` },
      version: ver?.v ?? '',
      announcements: ann?.text ? [{ id: ann.id, text: ann.text, tone: ann.tone === 'warning' ? 'urgent' : 'info', link: ann.link?.href ?? null, startsOn: ann.startsAt?.slice(0, 10) ?? null, endsOn: ann.endsAt?.slice(0, 10) ?? null }] : [],
      app: process.env.APP_MIN_VERSION ? { minVersion: process.env.APP_MIN_VERSION, latestVersion: process.env.APP_LATEST_VERSION ?? process.env.APP_MIN_VERSION, storeUrl: { ios: process.env.APP_STORE_IOS ?? '', android: process.env.APP_STORE_ANDROID ?? '' }, message: null } : null,
    });
  }),

  /* sign-in */
  route('POST', /^\/app\/auth\/otp\/start$/, async (ctx) => {
    const b = body(ctx); const { channel, address } = normalize(b.value);
    if (b.channel && b.channel !== channel) throw new HttpError(422, channel === 'email' ? 'Enter a 10-digit US mobile number.' : 'Enter an email address like name@example.com.', { value: 'Check what you typed.' });
    const s = await signInSettings(ctx.db, ctx.orgId);
    if (channel === 'email' && !s.methods.emailCode) throw new HttpError(400, 'Email codes are switched off here.');
    if (channel === 'sms' && !s.methods.phoneCode) throw new HttpError(400, 'Text-message codes are switched off here.');
    if (await locked(ctx.db, address)) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.', undefined, 'locked');
    const recent = await one<{ a: number; ip: number }>(ctx.db, PLATFORM, `SELECT count(*) FILTER (WHERE address = $1)::int AS a, count(*) FILTER (WHERE ip = NULLIF($2, '')::inet)::int AS ip FROM platform.login_codes WHERE created_at > now() - interval '15 minutes'`, [address, ctx.req.ip ?? '']);
    if ((recent?.a ?? 0) >= 5 || (recent?.ip ?? 0) >= IP_CODES()) throw new HttpError(429, 'Too many codes asked for. Wait 15 minutes and try again.', undefined, 'rate');
    const who = await lookup(ctx, channel, address); let code = '';
    if (who?.memberId) code = await sendCode(ctx, channel, address, 'sign-in');
    else if (channel === 'email') code = await sendCode(ctx, channel, address, 'join');   // a new member proves the email, then joins
    else await event(ctx.db, { orgId: ctx.orgId, address, method: 'sms-code', ok: false, reason: 'unknown address', ip: ctx.req.ip });
    const ms = await settingsOf(ctx);
    return ok({ sentTo: mask(address), channel, resendAfterSec: ms.otp.resendSeconds, ...(devCodes() && code ? { devCode: code } : {}) }, 202);
  }),
  route('POST', /^\/app\/auth\/otp\/verify$/, async (ctx) => {
    const b = body(ctx); const { channel, address } = normalize(b.value); const code = String(b.code ?? '').trim();
    if (await locked(ctx.db, address)) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.', undefined, 'locked');
    const who = await lookup(ctx, channel, address);
    if (who?.memberId) {
      await checkCode(ctx, address, code, 'sign-in');
      const userId = await userFor(ctx, who.email);
      const tokens = await issue(ctx, { userId, memberId: who.memberId });
      await event(ctx.db, { orgId: ctx.orgId, address: who.email, method: channel === 'email' ? 'app-email-code' : 'app-sms-code', ok: true, userId, ip: ctx.req.ip });
      const m = await one<{ first_name: string; preferred_name: string }>(ctx.db, API(ctx), 'SELECT first_name, preferred_name FROM app.members WHERE id = $1', [who.memberId]);
      return ok({ tokens, existingMember: true, firstName: m?.preferred_name || m?.first_name || '' });
    }
    await checkCode(ctx, address, code, channel === 'email' ? 'join' : 'sign-in');
    const token = newToken();   // the join form's proof of this email (2 hours, one use) – same as the website's
    await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.login_codes (org_id, channel, address, purpose, code_hash, expires_at) VALUES ($1, 'email', $2, 'verify-email', decode($3, 'hex'), now() + interval '2 hours')`, params: [ctx.orgId, address, sha256hex(token)] }]);
    return ok({ tokens: null, existingMember: false, firstName: '', joinToken: token });
  }),
  route('POST', /^\/app\/auth\/token\/refresh$/, async (ctx) => {
    const t = String(body(ctx).refreshToken ?? ''); if (!/^[A-Za-z0-9_-]{32,100}$/.test(t)) throw new HttpError(401, 'Sign in again.', undefined, 'sign-in');
    const r = await one<{ id: string; family: string; user_id: string; org_id: string; member_id: string; used: boolean; dead: boolean }>(ctx.db, PLATFORM, `SELECT encode(id, 'hex') AS id, family::text, user_id::text, org_id::text, member_id, used_at IS NOT NULL AS used, (revoked_at IS NOT NULL OR expires_at < now()) AS dead FROM platform.app_refresh_tokens WHERE id = decode($1, 'hex')`, [sha256hex(t)]);
    if (!r || r.org_id !== ctx.orgId || r.dead) throw new HttpError(401, 'Sign in again.', undefined, 'sign-in');
    const reuse = async () => { await endFamily(ctx, r.family); await event(ctx.db, { orgId: ctx.orgId, address: r.member_id, method: 'app-refresh', ok: false, reason: 'refresh token used twice', userId: r.user_id, ip: ctx.req.ip }); return new HttpError(401, 'This sign-in was used somewhere else – sign in again.', undefined, 'sign-in'); };
    if (r.used) throw await reuse();
    const still = await one(ctx.db, API(ctx), `SELECT 1 AS x FROM app.members WHERE id = $1 AND archived IS NULL`, [r.member_id]);
    if (!still) { await endFamily(ctx, r.family); throw new HttpError(401, 'Your membership record is not available – contact the office.', undefined, 'sign-in'); }
    const took = await rows(ctx.db, PLATFORM, `UPDATE platform.app_refresh_tokens SET used_at = now() WHERE id = decode($1, 'hex') AND used_at IS NULL RETURNING 1 AS x`, [r.id]);
    if (!took.length) throw await reuse();
    const tokens = await issue(ctx, { userId: r.user_id, memberId: r.member_id, family: r.family });
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.member_devices SET last_seen = now() WHERE family = $1::uuid`, params: [r.family] }]);
    return ok(tokens);
  }),
  route('POST', /^\/app\/auth\/logout$/, async (ctx) => {
    const s = ctx.session; if (!s || s.org_id !== ctx.orgId) return ok({ signedOut: 0 });
    if (body(ctx).allDevices === true) {
      const fam = (await rows(ctx.db, PLATFORM, `UPDATE platform.app_refresh_tokens SET revoked_at = now() WHERE user_id = $1::uuid AND org_id = $2::uuid AND revoked_at IS NULL RETURNING family::text`, [s.user_id, ctx.orgId])) as { family: string }[];
      const n = await rows(ctx.db, PLATFORM, `UPDATE platform.sessions SET revoked_at = now() WHERE user_id = $1::uuid AND org_id = $2::uuid AND revoked_at IS NULL RETURNING 1 AS x`, [s.user_id, ctx.orgId]);
      if (s.member_id) await ctx.db.run(API(ctx), [{ sql: `DELETE FROM app.member_devices WHERE member_id = $1`, params: [s.member_id] }]);
      await event(ctx.db, { orgId: ctx.orgId, address: s.email, method: 'app-sign-out-everywhere', ok: true, userId: s.user_id, ip: ctx.req.ip });
      return ok({ signedOut: n.length, chains: new Set(fam.map((f) => f.family)).size });
    }
    if (s.app_family) await endFamily(ctx, s.app_family);
    else await ctx.db.run(PLATFORM, [{ sql: `UPDATE platform.sessions SET revoked_at = now() WHERE id = decode($1, 'hex')`, params: [s.id] }]);
    return ok({ signedOut: 1 });
  }),

  /* home */
  route('GET', /^\/app\/me$/, async (ctx) => ok(await meOf(ctx))),
  route('POST', /^\/admin\/member-card\/check$/, async (ctx) => {
    need(ctx, 'members.view');
    const t = String(body(ctx).token ?? ''); const m = /^MS1\.([a-z0-9-]+)\.([A-Z]{2,5}-\d{4,8})\.(\d{10})\.([0-9a-f]{32})$/.exec(t);
    if (!m || m[1] !== ctx.slug || signLink(`card|${m[1]}.${m[2]}.${m[3]}`) !== m[4]) return ok({ valid: false, reason: 'This is not one of our member cards.' });
    if (Number(m[3]) < Date.now() / 1000) return ok({ valid: false, reason: 'This card picture is old – ask the member to open the card in the app again.' });
    const r = await one<{ first_name: string; last_name: string; status: string; center: string }>(ctx.db, API(ctx), 'SELECT first_name, last_name, status, center FROM app.members WHERE id = $1 AND archived IS NULL', [m[2]]);
    if (!r) return ok({ valid: false, reason: 'No such member.' });
    return ok({ valid: true, memberId: m[2], name: `${r.first_name} ${r.last_name}`, status: r.status, current: ['active', 'life'].includes(r.status), center: r.center });
  }),

  /* notifications */
  route('GET', /^\/app\/notifications$/, async (ctx) => {
    const id = needMember(ctx);
    const list = (await rows(ctx.db, API(ctx), `SELECT id::text, kind, title, body, at::text, read_at IS NOT NULL AS read, NULLIF(link, '') AS link FROM app.member_notifications WHERE member_id = $1 ORDER BY at DESC LIMIT 100`, [id])) as { at: string; read: boolean }[];
    return ok({ items: list.map((n) => ({ ...n, at: new Date(n.at).toISOString() })), unread: list.filter((n) => !n.read).length });
  }),
  route('POST', /^\/app\/notifications\/read$/, async (ctx) => {
    const id = needMember(ctx); const ids = body(ctx).ids;
    if (ids === 'all') await ctx.db.run(API(ctx), [{ sql: `UPDATE app.member_notifications SET read_at = now() WHERE member_id = $1 AND read_at IS NULL`, params: [id] }]);
    else if (Array.isArray(ids)) await ctx.db.run(API(ctx), [{ sql: `UPDATE app.member_notifications SET read_at = now() WHERE member_id = $1 AND read_at IS NULL AND id::text = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, params: [id, JSON.stringify(ids.map(String).slice(0, 200))] }]);
    else throw new HttpError(400, 'Which notices?');
    return ok({ ok: true });
  }),

  /* renewals */
  route('GET', /^\/app\/renewals\/options$/, async (ctx) => {
    const b = await renewalBasics(ctx); const max = b.plan.term === 'calendar_year' ? b.plan.maxYearsAhead : 1;
    const first = b.may.ok ? quoteOf(b, 1, 'card').price : null;
    const through = first?.term.through ?? null; const startYear = through ? Number(through.slice(0, 4)) : b.ms.year;
    const rd = b.ms.recordDate.slice(0, 10);
    return ok({
      forYear: startYear, termLabel: through ? `01/01/${startYear} – ${mdy(through)}` : '',
      plans: [{ id: b.plan.id, name: b.plan.name, priceCents: b.plan.priceCents, unit: unitOf(b.plan), description: b.plan.summary, current: true, eligible: b.may.ok, reason: b.may.ok ? null : b.may.reason }],
      maxYearsAhead: Math.max(1, max), multiYearDiscountPct: b.plan.multiYearDiscountPct,
      payers: [{ id: 'self', label: 'Me', sub: `${b.m.first_name} ${b.m.last_name}` }],
      pledgeText: b.ms.pledge.text, pledgeVersion: b.ms.pledge.version,
      nonRefundableNote: b.cfg.payments.refundPolicy || 'Membership dues are not refunded.',
      afterRecordDateWarning: b.today > rd ? `The voter list for ${b.ms.year} was taken on ${mdy(rd)}. Paying now keeps your membership, but you are not on that year’s voter list.` : null,
      priceLockMinutes: 30, methods: appMethods(b.cfg),
    });
  }),
  route('POST', /^\/app\/renewals\/quote$/, async (ctx) => {
    const c = Choice.safeParse(body(ctx)); if (!c.success) throw new HttpError(422, 'Check your choice.');
    const b = await renewalBasics(ctx); if (!b.may.ok) throw new HttpError(409, b.may.reason);
    if (c.data.planId !== b.plan.id) throw new HttpError(409, 'Plan changes are made by the office – contact them to change your plan.');
    const { total } = quoteOf(b, c.data.years, 'card');
    return ok({ totalCents: total.totalCents, lines: total.lines.map((l) => ({ label: l.label, amountCents: l.cents })), lockedUntil: new Date(Date.now() + 30 * 60_000).toISOString() });
  }),
  route('POST', /^\/app\/renewals$/, once(async (ctx) => {
    const c = Choice.safeParse(body(ctx)); if (!c.success) throw new HttpError(422, 'Check your choice.');
    const b = await renewalBasics(ctx);
    if (c.data.planId !== b.plan.id) throw new HttpError(409, 'Plan changes are made by the office – contact them to change your plan.');
    if (c.data.pledgeVersion !== b.ms.pledge.version) throw new HttpError(409, 'The pledge was updated – read it again and confirm.');
    const method = payMethodOf(body(ctx).method);
    const r = await inner<{ ref: string; amountCents: number; paymentIds: string[]; payment: { status: string } }>(ctx, 'POST', '/member/renewal', { years: c.data.years, method });
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.consents (org_id, member_id, email, kind, version, ip, source) VALUES ($1::uuid, $2, $3, 'pledge', $4, NULLIF($5, '')::inet, 'app-renewal')`, params: [ctx.orgId, b.m.id, b.m.email, b.ms.pledge.version, ctx.req.ip ?? ''] }]);
    const co = r.amountCents > 0 ? await inner<{ url: string }>(ctx, 'POST', '/public/checkout', { kind: 'dues', paymentIds: r.paymentIds }) : null;
    await notifyMember(ctx, b.m.id, { kind: 'membership', title: 'Renewal started', body: `${b.plan.name} · ${(r.amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}. Your membership is renewed when the payment arrives (${r.ref}).` });
    return ok({ id: r.ref, status: 'pending', receipt: null, amountCents: r.amountCents,
      nextSteps: [{ label: 'Pay on the secure card page', sub: 'It opens now – Apple Pay and Google Pay work there too.', state: 'wait' }, { label: 'Receipt by email', sub: 'Sent when the payment arrives.', state: 'later' }, { label: 'Your card shows the new date', sub: 'Usually within a minute of paying.', state: 'later' }],
      message: co ? null : 'Nothing to pay.', checkoutUrl: co?.url ?? null }, 201);
  })),

  /* payments and household */
  route('GET', /^\/app\/payments$/, async (ctx) => {
    const id = needMember(ctx);
    const dues = (await rows(ctx.db, API(ctx), `SELECT id::text, year, paid_on::text AS date, amount_cents::int AS cents, method, status, coalesce(receipt_no, '') AS receipt, kind FROM app.payments WHERE member_id = $1 ORDER BY paid_on DESC, year DESC`, [id])) as { id: string; year: number; date: string; cents: number; method: string; status: string; receipt: string; kind: string }[];
    const gifts = await inner<{ gifts: { id: string; date: string; amountCents: number; fund: string; receipt: string; refunded: boolean }[] }>(ctx, 'GET', '/member/giving');
    const regs = await inner<{ registrations: { id: string; event?: { title: string; start: string }; paidCents: number; refundCents: number }[] }>(ctx, 'GET', '/member/events/registrations');
    const st = (s: string) => (s === 'paid' ? 'paid' : s === 'failed' || s === 'disputed' ? 'failed' : s.includes('refund') ? 'refunded' : 'pending');
    const items = [
      ...dues.map((p) => ({ id: p.id, date: p.date, label: p.kind === 'dues' ? `${p.year} membership dues` : `Payment ${p.year}`, category: p.kind === 'dues' ? 'dues' : 'other', method: ({ card: 'Card', ach: 'Bank transfer', check: 'Check', cash: 'Cash' } as Record<string, string>)[p.method] ?? p.method, amountCents: p.cents, status: st(p.status), receipt: p.receipt || null })),
      ...gifts.gifts.map((g) => ({ id: g.id, date: g.date, label: `Gift – ${g.fund}`, category: 'gift', method: '', amountCents: g.amountCents, status: g.refunded ? 'refunded' : 'paid', receipt: g.receipt || null })),
      ...regs.registrations.filter((r) => r.paidCents > 0).map((r) => ({ id: r.id, date: (r.event?.start ?? '').slice(0, 10), label: r.event?.title ?? r.id, category: 'event', method: 'Card', amountCents: r.paidCents, status: r.refundCents ? 'refunded' : 'paid', receipt: r.id })),
    ].sort((a, b) => b.date.localeCompare(a.date));
    return ok({ items, statements: [] });
  }),
  route('GET', /^\/app\/household$/, async (ctx) => {
    const m = await row(ctx); const p = await portal(ctx); const ms = await settingsOf(ctx);
    const plan = ms.plans.find((x) => x.id === m.plan);
    const spouse = m.spouse_id ? await one<{ id: string; first_name: string; last_name: string; status: string }>(ctx.db, API(ctx), 'SELECT id, first_name, last_name, status FROM app.members WHERE id = $1', [m.spouse_id]) : null;
    const named = (await rows(ctx.db, API(ctx), `SELECT relation, related_name FROM app.relationships WHERE member_id = $1`, [m.id]).catch(() => [])) as { relation: string; related_name: string }[];
    const word = (s: string) => ({ active: 'Active', life: 'Life member', pending: 'Pending approval', expired: 'Expired', lapsed: 'Expired' } as Record<string, string>)[s] ?? s;
    const members = [
      { id: m.id, name: `${m.first_name} ${m.last_name}`, relation: 'You', isSelf: true, isPrimary: true, adult: true, status: p.status, voter: p.eligible, note: null },
      ...(spouse ? [{ id: spouse.id, name: `${spouse.first_name} ${spouse.last_name}`, relation: 'Spouse', isSelf: false, isPrimary: false, adult: true, status: word(spouse.status), voter: null, note: null }] : []),
      ...named.filter((r) => !spouse || r.relation !== 'spouse').map((r, i) => ({ id: `rel-${i}`, name: r.related_name, relation: r.relation === 'spouse' ? 'Spouse' : r.relation, isSelf: false, isPrimary: false, adult: true, status: 'Invited', voter: null, note: 'Not linked to a membership yet.' })),
    ];
    return ok({ members, canInviteSpouse: plan?.category === 'household' && !spouse, rule: `${ms.rules.household.label}. Each adult has their own record, card and vote.` });
  }),
  route('POST', /^\/app\/household\/invites$/, once(async (ctx) => {
    const m = await row(ctx); const ms = await settingsOf(ctx); const plan = ms.plans.find((x) => x.id === m.plan);
    const email = String(body(ctx).email ?? '').trim().toLowerCase();
    if (!z.string().email().safeParse(email).success) throw new HttpError(422, 'Enter an email address like name@example.com.', { email: 'Enter an email address like name@example.com.' });
    if (plan?.category !== 'household' || m.spouse_id) throw new HttpError(409, 'Your plan does not include another adult, or your spouse is already linked.');
    const recent = await one<{ n: number }>(ctx.db, PLATFORM, `SELECT count(*)::int AS n FROM platform.outbox WHERE org_id = $1 AND kind = 'household-invite' AND body LIKE '%' || $2 || '%' AND created_at > now() - interval '1 day'`, [ctx.orgId, m.id]);
    if ((recent?.n ?? 0) >= 3) throw new HttpError(429, 'You sent several invitations today – try again tomorrow.');
    const org = await one<{ name: string }>(ctx.db, PLATFORM, 'SELECT name FROM platform.organizations WHERE id = $1', [ctx.orgId]);
    await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, 'household-invite')`, params: [ctx.orgId, email, `${m.first_name} ${m.last_name} invites you to ${org?.name ?? 'the community'}`,
      `Assalamu alaikum,\n\n${m.first_name} ${m.last_name} has a household membership and invites you to complete your own record (your own card and vote).\n\nStart here: ${(await siteOf(ctx))}/join?household=${encodeURIComponent(m.id)}\n\nHousehold of member ${m.id}.`] }]);
    await audit(ctx, 'members', 'Spouse invited from the app', mask(email), m.id);
    return ok({ sentTo: mask(email) }, 201);
  })),

  /* profile */
  route('GET', /^\/app\/profile$/, async (ctx) => ok(await profileOf(ctx))),
  route('PATCH', /^\/app\/profile$/, async (ctx) => {
    const b = body(ctx); const out: Record<string, string> = {};
    for (const k of ['phone', 'street', 'city', 'zip', 'preferred'] as const) if (typeof b[k] === 'string') out[k] = String(b[k]).trim();
    if (out.phone !== undefined && out.phone && out.phone.replace(/\D/g, '').replace(/^1/, '').length !== 10) throw new HttpError(422, 'Enter a 10-digit US mobile number.', { phone: 'Enter a 10-digit US mobile number.' });
    if (out.zip !== undefined && !/^\d{5}$/.test(out.zip)) throw new HttpError(422, 'Enter a 5-digit ZIP code.', { zip: 'Enter a 5-digit ZIP code.' });
    if (!Object.keys(out).length) throw new HttpError(422, 'Nothing to change. Your name and email are changed by the office.');
    await inner(ctx, 'PATCH', '/member/me', out);
    return ok(await profileOf(ctx));
  }),
  route('POST', /^\/app\/center-requests$/, once(async (ctx) => {
    const m = await row(ctx); const reason = String(body(ctx).reason ?? '').trim(); const center = String(body(ctx).center ?? '').trim();
    if (reason.length < 3) throw new HttpError(422, 'Say why you would like to belong to another masjid.', { reason: 'Say why you would like to belong to another masjid.' });
    if (center) { const r = await inner<{ id: string }>(ctx, 'POST', '/member/center-change', { center, reason }); return ok({ reference: r.id.slice(0, 8).toUpperCase() }, 201); }
    // no masjid picked: the office reads the reason and answers (a membership request on the help desk)
    const s = await document<{ helpdesk?: { categories?: { id: string; onWebsite: boolean; archived?: boolean }[] } }>(ctx.db, ctx.orgId, 'work-settings');
    const cats = (s?.helpdesk?.categories ?? []).filter((c) => c.onWebsite && !c.archived); const cat = cats.find((c) => c.id === 'membership') ?? cats.find((c) => c.id === 'request') ?? cats[0];
    const r = await inner<{ reference: string }>(ctx, 'POST', '/member/helpdesk/tickets', { subject: 'Masjid change request', detail: `Member ${m.id} (${m.center}) asks to belong to another masjid:\n\n${reason}`, categoryId: cat?.id ?? '' });
    return ok({ reference: r.reference }, 201);
  })),
  route('POST', /^\/app\/id-checks$/, async (ctx) => {
    needMember(ctx); const b = body(ctx);
    const r = await inner<{ id: string; upload: { url: string; method: string; headers: Record<string, string> } }>(ctx, 'POST', '/member/files', { name: String(b.name ?? 'id.jpg'), mime: String(b.mime ?? 'image/jpeg'), bytes: Number(b.bytes ?? 0) });
    return ok({ fileId: r.id, upload: r.upload }, 201);
  }),
  route('POST', /^\/app\/id-checks\/([0-9a-f-]{36})\/complete$/, async (ctx, mm) => {
    const id = needMember(ctx);
    await inner(ctx, 'POST', `/member/files/${mm[1]}/complete`);
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET id_check = 'pending' WHERE id = $1 AND id_check IS DISTINCT FROM 'verified'`, params: [id] }]);
    await audit(ctx, 'members', 'Photo ID sent from the app', '', id);
    return ok({ reference: mm[1].slice(0, 8).toUpperCase() });
  }),

  /* masjid, prayer times */
  route('GET', /^\/app\/masjid$/, async (ctx) => {
    const m = await row(ctx);
    const c = await one<{ id: string; code: string; name: string; zone: string; street: string; city: string; state: string; zip: string; phone: string; website: string; lat: string | null; lng: string | null }>(ctx.db, API(ctx), `SELECT c.id::text, c.code, c.name, z.name AS zone, c.street, c.city, c.state, c.zip, c.phone, c.website, c.lat::text, c.lng::text FROM app.centers c LEFT JOIN app.zones z ON z.org_id = c.org_id AND z.id = c.zone_id WHERE c.name = $1`, [m.center]);
    if (!c) throw new HttpError(404, 'You are not placed at a masjid yet – the office will place you by your address.');
    const jum = (await rows(ctx.db, API(ctx), `SELECT to_char(khutbah_at, 'HH24:MI') AS k FROM app.center_jumuah WHERE center_id = $1::uuid ORDER BY slot`, [c.id])) as { k: string }[];
    const ps = await parse(ctx, 'prayer-times', PrayerSettingsSchema, mockPrayerSettings); const today = todayCT();
    const d = dayTimes(ps, c.name, today, jum.map((j) => j.k));
    const off = await parse(ctx, 'officials', OfficialsSchema, mockOfficials);
    const recs = recordsFor(await parse(ctx, 'records', RecordsSchema, mockRecords), 'members').filter((r) => r.center === c.name).slice(0, 10);
    const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    return ok({
      id: c.code, name: c.name, zone: c.zone ?? '', address: [c.street, `${c.city}${c.city ? ', ' : ''}${c.state} ${c.zip}`.trim()].filter((x) => x.trim()), phone: c.phone || null, website: c.website || null,
      mapUrl: c.lat && c.lng ? `https://maps.apple.com/?daddr=${c.lat},${c.lng}&q=${encodeURIComponent(c.name)}` : null, distanceMiles: null,
      today: { date: today, times: PRAYERS.map((p) => ({ name: PRAYER_NAME[p], adhan: clock(d.adhan[p]), iqamah: d.iqamah && (IQAMAH_PRAYERS as readonly string[]).includes(p) ? clock(d.iqamah[p as (typeof IQAMAH_PRAYERS)[number]]) : null })), jumuah: jum.map((j) => ({ khutbah: clock(toMin(j.k)), prayer: clock(toMin(j.k) + 30) })) },
      serves: off.holders.filter((h) => h.status === 'serving' && h.center === c.name && h.name).map((h) => ({ role: seatLabel(h), name: h.name, contact: null })),
      records: recs.map((r) => ({ id: r.id, title: r.title, date: r.date, kind: r.category })),
    });
  }),
  route('GET', /^\/app\/prayer-times$/, async (ctx) => {
    const center = ctx.memberId ? (await one<{ center: string }>(ctx.db, API(ctx), 'SELECT center FROM app.members WHERE id = $1', [ctx.memberId]))?.center ?? '' : '';
    const ps = await parse(ctx, 'prayer-times', PrayerSettingsSchema, mockPrayerSettings);
    const name = center || (await donationSettings(ctx)).mainCenter;
    const jum = (await rows(ctx.db, API(ctx), `SELECT to_char(j.khutbah_at, 'HH24:MI') AS k FROM app.center_jumuah j JOIN app.centers c ON c.org_id = j.org_id AND c.id = j.center_id WHERE c.name = $1 ORDER BY j.slot`, [name])) as { k: string }[];
    return ok({ settings: ps, center: name, jumuah: jum.map((j) => j.k) });
  }),
  route('GET', /^\/app\/masjids$/, async (ctx) => {
    const list = (await rows(ctx.db, API(ctx), `SELECT c.code AS id, c.name, z.name AS zone, concat_ws(', ', NULLIF(c.street, ''), NULLIF(trim(c.city || ' ' || c.state || ' ' || c.zip), '')) AS address, coalesce(c.lat, g.lat)::float AS lat, coalesce(c.lng, g.lng)::float AS lng, NULLIF(c.phone, '') AS phone,
        coalesce((SELECT json_agg(to_char(j.khutbah_at, 'HH24:MI') ORDER BY j.slot) FROM app.center_jumuah j WHERE j.org_id = c.org_id AND j.center_id = c.id), '[]') AS jumuah
      FROM app.centers c LEFT JOIN app.zones z ON z.org_id = c.org_id AND z.id = c.zone_id LEFT JOIN geo.postal_codes g ON g.country = 'US' AND g.code = left(c.zip, 5)   -- no pin yet: the ZIP code's middle
      WHERE c.active AND coalesce(c.lat, g.lat) IS NOT NULL AND coalesce(c.lng, g.lng) IS NOT NULL ORDER BY z.sort, c.sort, c.name`)) as { zone: string | null }[];
    return ok(list.map((x) => ({ ...x, zone: x.zone ?? '' })));
  }),

  /* events */
  route('GET', /^\/app\/events$/, async (ctx) => { const x = await eventsFor(ctx); return ok(x.events.filter((e) => e.status !== 'cancelled' || x.regs.some((r) => r.eventId === e.id)).map((e) => eventItem(e, x.v, x.regs, x.now))); }),
  route('GET', /^\/app\/events\/([a-z0-9-]{2,80})$/, async (ctx, mm) => ok((await oneEvent(ctx, mm[1])).item)),
  route('POST', /^\/app\/events\/([a-z0-9-]{2,80})\/register$/, once(async (ctx, mm) => {
    const x = await oneEvent(ctx, mm[1]); const seats = Math.max(1, Math.min(21, Number(body(ctx).seats ?? 1) || 1));
    // a visitor registers with the contact they left on "My masjid" (app.contacts); a member with their record
    const who = ctx.memberId ? await row(ctx) : await visitorOf(ctx);
    if (!who.email) throw new HttpError(409, 'Your record has no email address – ask the office to add one, then register.');
    const types = x.e.registration.types.filter((t) => t.enabled && t.availability !== 'code' && E.typeAvailable(t, x.v, undefined, x.e, seats).ok).sort((a, b) => a.priceCents - b.priceCents);
    if (!types.length) throw new HttpError(409, x.item.reason ?? 'Registration is not open to you.');
    const r = await inner<{ status: string; ref: string; totalCents: number; manageToken: string }>(ctx, 'POST', `/public/events/${x.e.id}/registrations`, { typeId: types[0].id, guestNames: Array.from({ length: seats - 1 }, (_, i) => `Guest ${i + 1}`), name: `${who.first_name} ${who.last_name}`, email: who.email, phone: who.phone ?? '' });
    const co = r.status === 'pending-payment' && r.totalCents > 0 ? await inner<{ url: string }>(ctx, 'POST', '/public/checkout', { kind: 'event', ref: r.ref, token: r.manageToken }) : null;
    if (ctx.memberId) await notifyMember(ctx, ctx.memberId, { kind: 'events', title: r.status === 'waitlisted' ? `Waitlist: ${x.e.title}` : `Registered: ${x.e.title}`, body: `Reference ${r.ref}.`, link: `/events/${x.e.id}` });
    const after = await oneEvent(ctx, mm[1]);
    return ok({ ...after.item, checkoutUrl: co?.url ?? null }, 201);
  })),
  route('POST', /^\/app\/events\/([a-z0-9-]{2,80})\/cancel$/, once(async (ctx, mm) => {
    const x = await oneEvent(ctx, mm[1]); const r = x.regs.find((y) => y.eventId === x.e.id && ['confirmed', 'pending-payment', 'waitlist'].includes(y.status));
    if (!r) throw new HttpError(409, 'You are not registered for this event.');
    await inner(ctx, 'POST', `/member/events/registrations/${r.id}/cancel`);
    return ok((await oneEvent(ctx, mm[1])).item);
  })),

  /* giving */
  route('GET', /^\/app\/giving\/options$/, async (ctx) => {
    const [s, cfg] = await Promise.all([donationSettings(ctx), configOf(ctx)]);
    const centers = (await rows(ctx.db, API(ctx), `SELECT code AS id, name AS label FROM app.centers WHERE active ORDER BY sort, name`)) as { id: string; label: string }[];
    const camps = await inner<{ campaigns: { id: string; name: string; state: string; totalCents: number; goalCents: number; center: string }[] }>(ctx, 'GET', '/public/campaigns').catch(() => ({ campaigns: [] }));
    return ok({
      funds: s.funds.filter((f) => f.active).map((f) => ({ id: f.id, label: f.name, note: f.zakat ? 'Zakat-eligible' : f.restricted ? 'Used only for this purpose' : null })),
      masjids: centers, presetsCents: [2500, 5000, 10000, 25000], minCents: 100, maxCents: 10_000_000,
      feeCoverPct: cfg.payments.coverFees.enabled ? cfg.payments.coverFees.percent : 0, monthlyAllowed: cfg.payments.card,
      zakatApplication: { enabled: true, note: `Need help with Zakat? Apply on the website (${(await siteOf(ctx))}/zakat) – the committee answers in confidence.` },
      campaigns: (camps.campaigns ?? []).filter((c) => c.state === 'live').map((c) => ({ id: c.id, title: c.name, raisedCents: c.totalCents ?? 0, goalCents: c.goalCents ?? 0, masjid: c.center || null })),
    });
  }),
  route('POST', /^\/app\/giving\/donations$/, once(async (ctx) => {
    const b = body(ctx); const cfg = await configOf(ctx);
    const amount = Number(b.amountCents ?? 0); if (!Number.isInteger(amount) || amount < 100 || amount > 10_000_000) throw new HttpError(422, 'Enter an amount between $1 and $100,000.', { amount: 'Enter an amount between $1 and $100,000.' });
    const c = await one<{ name: string }>(ctx.db, API(ctx), 'SELECT name FROM app.centers WHERE code = $1 AND active', [String(b.masjidId ?? '')]);
    const fee = b.coverFee === true && cfg.payments.coverFees.enabled ? Math.round(amount * cfg.payments.coverFees.percent / 100) : 0;
    const co = await giftCheckout(ctx, { fund: String(b.fundId ?? ''), center: c?.name ?? '', amountCents: amount + fee, monthly: b.monthly === true });
    return ok({ id: co.session, status: 'pending', receipt: null, amountCents: co.amountCents, checkoutUrl: co.url }, 201);
  })),

  /* benefits */
  route('GET', /^\/app\/benefits$/, async (ctx) => {
    const m = await row(ctx); const d = await parse(ctx, 'benefits', BenefitsSchema, mockBenefits); const today = todayCT();
    if (!d.enabled) return ok({ intro: 'There are no member benefits yet.', items: [], categories: [] });
    const used = new Map(((await rows(ctx.db, API(ctx), `SELECT offer_id, count(*)::int AS n FROM app.benefit_redemptions WHERE member_id = $1 GROUP BY offer_id`, [m.id])) as { offer_id: string; n: number }[]).map((r) => [r.offer_id, r.n]));
    const current = ['active', 'life'].includes(m.status);
    const items = d.offers.filter((o) => o.status === 'live' && o.from <= today && o.until >= today).flatMap((o) => {
      const p = d.partners.find((x) => x.id === o.partnerId); if (!p || p.status !== 'approved') return [];
      const planOk = (o.plans as string[]).includes(m.plan); const eligible = current && planOk;
      if (!eligible && !d.showLocked) return [];
      return [{ id: o.id, partner: p.name, offer: o.details ? `${o.title} – ${o.details}` : o.title, category: CATEGORIES[p.category], how: o.redeem === 'link' ? 'link' : o.redeem === 'card' ? 'card' : 'code',
        code: eligible ? (o.redeem === 'code' ? o.code : o.redeem === 'unique' ? `${o.code}${o.code ? '-' : ''}${m.id}` : o.redeem === 'link' ? o.url : null) : null,
        limit: LIMIT[o.limit], validUntil: o.until, uses: used.get(o.id) ?? 0, eligible, reason: eligible ? null : !current ? 'For current members – renew to use it.' : 'For members on another plan.' }];
    });
    return ok({ intro: 'Show your member card or use the code. Partners were checked by the office.', items, categories: [...new Set(items.map((i) => i.category))] });
  }),

  /* election */
  route('GET', /^\/app\/election$/, async (ctx) => {
    needMember(ctx); const year = electionYear(todayCT());
    const mine = await inner<{ electionDay: string; status: string; eligibleNow: boolean; onVoterList: boolean | null; nominationsOpen: boolean; mySeats: { key: string; label: string; candidates: string[] }[] }>(ctx, 'GET', `/member/elections/${year}`);
    const notes = [`Status: ${mine.status}.`, mine.onVoterList === null ? 'The voter list is taken on the record date.' : mine.onVoterList ? 'You are on the voter list.' : 'You are not on the voter list for this election.', ...(mine.nominationsOpen ? ['Nominations are open – nominate on the website.'] : [])];
    return ok({ year, title: `${year} election`, electionDay: mine.electionDay, pollingPlace: null, hours: null, bring: ['Your photo ID'], eligible: mine.onVoterList ?? mine.eligibleNow, onlineBallot: 'off',
      candidates: mine.mySeats.flatMap((s) => s.candidates.map((n, i) => ({ id: `${s.key}-${i + 1}`, name: n, office: s.label, zone: null, since: null, statement: null }))), notes });
  }),

  /* settings */
  route('GET', /^\/app\/preferences$/, async (ctx) => ok(await prefsOf(ctx))),
  route('PATCH', /^\/app\/preferences$/, async (ctx) => {
    const P = z.object({ email: z.object({ newsletter: z.boolean(), reminders: z.boolean() }), sms: z.object({ enabled: z.boolean() }).passthrough(), push: z.object({ membership: z.boolean(), masjid: z.boolean(), events: z.boolean() }), directoryListed: z.boolean() }).passthrough();
    const p = P.safeParse(body(ctx)); if (!p.success) throw new HttpError(422, 'Check the choices.');
    const cur = await inner<{ prefs: { email: boolean; sms: boolean; optOut: string[] } }>(ctx, 'GET', '/member/preferences');
    const optOut = new Set(cur.prefs.optOut.filter((t) => !['newsletter', 'events'].includes(t)));
    if (!p.data.email.newsletter) optOut.add('newsletter'); if (!p.data.email.reminders) optOut.add('events');
    await inner(ctx, 'PUT', '/member/preferences', { email: cur.prefs.email, sms: p.data.sms.enabled, optOut: [...optOut] });
    await inner(ctx, 'PUT', '/member/directory', { listed: p.data.directoryListed });
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET prefs = coalesce(prefs, '{}'::jsonb) || jsonb_build_object('push', $2::jsonb) WHERE id = $1`, params: [ctx.memberId, JSON.stringify(p.data.push)] }]);
    return ok(await prefsOf(ctx));
  }),
  route('POST', /^\/app\/data-export$/, once(async (ctx) => {
    const m = await row(ctx);
    const recent = await one<{ n: number }>(ctx.db, PLATFORM, `SELECT count(*)::int AS n FROM platform.outbox WHERE org_id = $1 AND kind = 'data-export' AND to_address = $2 AND created_at > now() - interval '1 day'`, [ctx.orgId, m.email]);
    if ((recent?.n ?? 0) >= 1) throw new HttpError(429, 'Your data was sent today – check your email.');
    const me = await meOf(ctx); const pays = await rows(ctx.db, API(ctx), `SELECT year, paid_on::text, amount_cents, method, status FROM app.payments WHERE member_id = $1 ORDER BY paid_on`, [m.id]);
    const consents = await rows(ctx.db, API(ctx), `SELECT kind, version, given, at::text FROM app.consents WHERE member_id = $1 ORDER BY at`, [m.id]).catch(() => []);
    const data = { member: { ...me.profile, memberId: me.memberId, plan: me.plan, memberSince: me.memberSince, status: me.status, zone: me.zone, center: me.center, dob: m.dob }, payments: pays, consents, preferences: m.prefs ?? {} };
    await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, 'Your membership data', $3, 'data-export')`, params: [ctx.orgId, m.email, `Assalamu alaikum,\n\nHere is the information we keep about your membership, as you asked in the app. Photo IDs are not included – they are deleted after review.\n\n${JSON.stringify(data, null, 2)}`] }]);
    await audit(ctx, 'members', 'Data export sent', 'from the app', m.id);
    return ok({ sentTo: mask(m.email) }, 201);
  })),
  route('POST', /^\/app\/devices$/, async (ctx) => {
    const id = needMember(ctx); const fam = ctx.session?.app_family; if (!fam) throw new HttpError(400, 'Sign in with the app first.');
    const b = body(ctx); const platform = ['ios', 'android', 'web'].includes(String(b.platform)) ? String(b.platform) : '';
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.member_devices (org_id, family, member_id, name, platform, push_token) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
        ON CONFLICT (org_id, family) DO UPDATE SET push_token = EXCLUDED.push_token, platform = EXCLUDED.platform, name = EXCLUDED.name, last_seen = now()`,
      params: [ctx.orgId, fam, id, String(ctx.req.headers['x-client'] ?? '').slice(0, 80) || (platform === 'ios' ? 'iPhone' : platform === 'android' ? 'Android phone' : 'Phone'), platform, String(b.pushToken ?? '').slice(0, 300)] }]);
    return ok({ ok: true });
  }),
  route('POST', /^\/app\/crashes$/, async (ctx) => {
    const list = Array.isArray(body(ctx).reports) ? (body(ctx).reports as Record<string, unknown>[]).slice(0, 20) : [];
    const recent = await one<{ n: number }>(ctx.db, API(ctx), `SELECT count(*)::int AS n FROM app.app_crashes WHERE at > now() - interval '1 hour'`);
    if ((recent?.n ?? 0) > 2000 || !list.length) return ok({ ok: true, kept: 0 }, 202);
    const st: Statement[] = list.map((r) => ({ sql: `INSERT INTO app.app_crashes (org_id, version, platform, message, detail) VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
      params: [ctx.orgId, String(r.appVersion ?? r.version ?? '').slice(0, 40), String(r.platform ?? '').slice(0, 20), String(r.message ?? '').slice(0, 500), JSON.stringify({ stack: String(r.stack ?? '').slice(0, 4000), screen: String(r.screen ?? '').slice(0, 80), at: String(r.at ?? '').slice(0, 40) })] }));
    await ctx.db.run(API(ctx), st);
    return ok({ ok: true, kept: list.length }, 202);
  }),

  /* family, community */
  route('GET', /^\/app\/family$/, async (ctx) => ok(familyView((await inner<{ family: Family }>(ctx, 'GET', '/member/family')).family, todayCT()))),
  route('POST', /^\/app\/family$/, once(async (ctx) => {
    const b = body(ctx); const name = String(b.name ?? '').trim().replace(/\s+/g, ' '); const relation = String(b.relation ?? ''); const by = b.birthYear === null || b.birthYear === undefined ? null : Number(b.birthYear);
    const fields: Record<string, string> = {};
    if (name.split(' ').length < 2 || name.length > 120) fields.name = 'Enter the first and last name.';
    if (!(SUPPORTED as readonly string[]).includes(relation)) fields.relation = 'Choose a relation.';
    if (by !== null && (!Number.isInteger(by) || by < 1900 || by > Number(todayCT().slice(0, 4)))) fields.birthYear = 'Enter a real year of birth.';
    if (Object.keys(fields).length) throw new HttpError(422, Object.values(fields)[0], fields);
    const f = structuredClone((await inner<{ family: Family }>(ctx, 'GET', '/member/family')).family); const root = f.rootId;
    const parts = name.split(' '); const sex = ['Father', 'Son', 'Brother'].includes(relation) ? 'm' : ['Mother', 'Daughter', 'Sister'].includes(relation) ? 'f' : (f.people.find((p) => p.id === root)?.sex === 'm' ? 'f' : 'm');
    const id = `app-${randomUUID().slice(0, 8)}`; f.people.push({ id, first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1], sex, ...(by ? { born: String(by) } : {}) } as Person);
    const nid = () => `u-${randomUUID().slice(0, 8)}`;
    const mine = () => { let u = f.unions.find((x) => x.a === root || x.b === root); if (!u) { u = { id: nid(), a: root, children: [] }; f.unions.push(u); } return u; };
    const parents = () => { let u = f.unions.find((x) => x.children.includes(root)); if (!u) { u = { id: nid(), a: id, children: [root] }; f.unions.push(u); return { u, fresh: true }; } return { u, fresh: false }; };
    if (relation === 'Spouse') { const u = f.unions.find((x) => (x.a === root && !x.b) || (x.b === root && !x.a)); if (u) u.b = id; else f.unions.push({ id: nid(), a: root, b: id, children: [] }); }
    else if (relation === 'Son' || relation === 'Daughter') mine().children.push(id);
    else if (relation === 'Father' || relation === 'Mother') { const { u, fresh } = parents(); if (!fresh) { if (!u.b) u.b = id; else throw new HttpError(409, 'Both parents are already in your tree.', { relation: 'Both parents are already in your tree.' }); } }
    else { let u = f.unions.find((x) => x.children.includes(root)); if (!u) { const ph = `ph-${randomUUID().slice(0, 8)}`; f.people.push({ id: ph, first: 'Parent', last: '', sex: 'm', placeholder: true } as Person); u = { id: nid(), a: ph, children: [root] }; f.unions.push(u); } u.children.push(id); }
    const saved = await inner<{ family: Family }>(ctx, 'PUT', '/member/family', { family: f });
    return ok(familyView(saved.family, todayCT()), 201);
  })),
  route('GET', /^\/app\/community$/, async (ctx) => ok(await communityOf(ctx, ctx.req.query.get('q') ?? ''))),
  route('POST', /^\/app\/groups\/([a-z0-9-]{2,40})\/join$/, once(async (ctx, mm) => {
    const gs = await inner<{ groups: { id: string; action: string | null }[] }>(ctx, 'GET', '/member/groups');
    const g = gs.groups.find((x) => x.id === mm[1]); if (!g) throw new HttpError(404, 'No such group.');
    if (g.action !== 'join' && g.action !== 'request') throw new HttpError(409, g.action === 'leave' ? 'You are already in this group.' : 'This group is kept by the office.');
    await inner(ctx, 'POST', `/member/groups/${g.id}/${g.action}`);
    return ok(await communityOf(ctx, ''));
  })),

  /* check-o-matic */
  route('GET', /^\/app\/check-o-matic$/, async (ctx) => ok(await checkOMaticOf(ctx))),
  route('PATCH', /^\/app\/check-o-matic$/, async (ctx) => {
    const cur = await checkOMaticOf(ctx); const b = body(ctx); const next: { masjidId?: string; amountCents?: number } = {};
    if (b.amountCents !== undefined) { const a = Number(b.amountCents); if (!Number.isInteger(a) || a < cur.minCents) throw new HttpError(422, `The minimum is ${(cur.minCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} per month.`, { amount: 'Below the monthly minimum.' }); next.amountCents = a; }
    if (b.masjidId !== undefined) { const c = await one(ctx.db, API(ctx), 'SELECT 1 AS x FROM app.centers WHERE code = $1 AND active', [String(b.masjidId)]); if (!c) throw new HttpError(422, 'Pick a masjid from the list.', { masjid: 'Pick a masjid from the list.' }); next.masjidId = String(b.masjidId); }
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET prefs = coalesce(prefs, '{}'::jsonb) || jsonb_build_object('checkomatic', coalesce(prefs->'checkomatic', '{}'::jsonb) || $2::jsonb) WHERE id = $1`, params: [ctx.memberId, JSON.stringify(next)] }]);
    return ok(await checkOMaticOf(ctx));
  }),
  route('POST', /^\/app\/check-o-matic\/pay-now$/, once(async (ctx) => {
    const cur = await checkOMaticOf(ctx); const s = await donationSettings(ctx);
    const fund = s.checkomatic.funds[0] ?? s.funds.find((f) => f.active && !f.zakat)?.id ?? '';
    const co = await giftCheckout(ctx, { fund, center: cur.masjidLabel, amountCents: cur.amountCents, monthly: !cur.active });
    return ok({ ...cur, checkoutUrl: co.url }, 201);
  })),

  /* join */
  route('GET', /^\/app\/join\/options$/, async (ctx) => {
    const [ms, form, cfg] = await Promise.all([settingsOf(ctx), parse(ctx, 'join-form', JoinFormSchema, defaultJoinForm), configOf(ctx)]);
    return ok({
      form, year: ms.year, minMemberAge: ms.minMemberAge, serviceArea: ms.serviceArea,
      plans: ms.plans.filter((p) => p.visible).map(({ visible: _v, termPrices: _t, bundle: _b, renewal: _r, allowLevelChange: _a, ...p }) => p),
      commitments: ms.commitments, pledge: ms.pledge, consents: ms.consents,
      identity: { nameMustMatchId: ms.identity.nameMustMatchId, nameNote: ms.identity.nameNote, consentRequired: ms.identity.consentRequired, consentText: ms.identity.consentText, consentVersion: ms.identity.consentVersion },
      payerRelationships: ms.payerRelationships, eligibility: [], methods: appMethods(cfg), flags: ms.flags,
      approvalNote: ms.rules.approval.by ? `New memberships are approved by the ${ms.rules.approval.by}${ms.rules.approval.requireFullPayment ? ' once the dues are paid' : ''}.` : '',
    });
  }),
  route('POST', /^\/app\/residency$/, async (ctx) => {
    const { p } = await placeOf(ctx, String(body(ctx).address ?? ''));
    const ms = await settingsOf(ctx);
    return ok({ zone: p.zone_name ?? '', center: p.center_name ?? '', nearBorder: false, alternatives: (p.nearest ?? []).map((n) => n.name), estimate: true, inServiceArea: !!p.center && (!p.place || ms.serviceArea.states.includes(p.place.state)) });
  }),
  route('POST', /^\/app\/join\/applications$/, once(async (ctx) => {
    const d = body(ctx) as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
    const about = (d.about ?? {}) as Record<string, string>; const ms = await settingsOf(ctx);
    const addr = splitAddress(String(about.address ?? '')); if (!addr) throw new HttpError(422, 'Write the address as street, city, state and ZIP – like 14210 Cypress Creek Pkwy, Houston, TX 77070.', { address: 'Write the address as street, city, state and ZIP.' });
    const { p } = await placeOf(ctx, String(about.address));
    const plan = ms.plans.find((x) => x.id === d.planId);
    const [sf, ...sl] = String(d.spouseName ?? '').trim().split(/\s+/);
    const application = {
      joinToken: String(d.joinToken ?? ''),
      account: { email: String(d.email ?? '') },
      about: { firstName: about.firstName, middleName: about.middleName ?? '', lastName: about.lastName, preferredName: about.preferredName ?? '', dob: about.dob, phone: about.phone, street: addr.street, unit: about.unit ?? '', city: addr.city, state: addr.state, zip: addr.zip, centerId: p.center ?? '', zoneId: p.zone ?? '', borderRequestCenterId: '' },
      plan: { memberClass: plan?.memberClass ?? 'natural', planId: String(d.planId ?? ''), years: Number(d.years ?? 1), ...(plan?.category === 'household' ? { spouse: { firstName: sf ?? '', lastName: sl.join(' '), email: String(d.spouseEmail ?? '') } } : {}) },
      pledge: { commitments: Array.isArray(d.commitments) ? d.commitments : [], pledgeAccepted: d.pledged === true, signature: String(d.signature ?? ''), emailConsent: d.consentEmail === true, smsConsent: d.consentSms === true, identityConsent: d.identityConsent === true },
      payment: { payer: d.payer === 'relative' ? 'relative' : 'self', payerRelationship: String(d.payerRelation ?? ''), payerName: String(d.payerName ?? '') },
      pledgeVersion: ms.pledge.version, emailConsentVersion: d.consentEmail ? ms.consents.email.version : '', smsConsentVersion: d.consentSms ? ms.consents.sms.version : '', identityConsentVersion: d.identityConsent ? ms.identity.consentVersion : '',
      custom: d.custom ?? {}, checkout: { method: payMethodOf(d.method) },
    };
    let r: { applicationId: string; memberId: string; amountCents: number; payment: { status: string; paymentIds?: string[]; checkout: unknown } };
    try { r = await inner(ctx, 'POST', '/public/membership/applications', application); }
    catch (e) {   // the website's field names → the app's
      if (e instanceof HttpError && e.detail && typeof e.detail === 'object') { const map: Record<string, string> = { 'about.street': 'address', 'about.city': 'address', 'about.state': 'address', 'about.zip': 'address', 'about.centerId': 'address', 'plan.spouse.firstName': 'spouseName', 'plan.spouse.lastName': 'spouseName', 'plan.spouse.email': 'spouseEmail', 'pledge.signature': 'signature', 'pledge.pledgeAccepted': 'pledged', 'account.verified': 'email' };
        const f: Record<string, string> = {}; for (const [k, v] of Object.entries(e.detail as Record<string, string>)) f[map[k] ?? k.split('.').pop()!] ??= String(v); throw new HttpError(e.status, e.message, f); }
      throw e;
    }
    const co = r.payment.checkout && r.payment.paymentIds?.length ? await inner<{ url: string }>(ctx, 'POST', '/public/checkout', { kind: 'dues', paymentIds: r.payment.paymentIds }) : null;
    // the email was proven with the code: the new (pending) member is signed in on this phone
    const tokens = await issue(ctx, { userId: await userFor(ctx, String(d.email ?? '').trim().toLowerCase()), memberId: r.memberId });
    return ok({ applicationId: r.applicationId, status: 'submitted', amountCents: r.amountCents, receipt: null, tokens, checkoutUrl: co?.url ?? null,
      nextSteps: [{ label: 'Application received', sub: r.applicationId, state: 'done' }, { label: co ? 'Pay on the secure card page' : 'Pay the office', sub: co ? 'It opens now.' : 'Your application waits for the payment.', state: 'wait' }, { label: `Approval by the ${ms.rules.approval.by || 'office'}`, sub: 'We email you when it is done.', state: 'later' }] }, 201);
  })),
];

async function profileOf(ctx: Ctx) {
  const m = await row(ctx); const ms = await settingsOf(ctx); const cfg = await configOf(ctx);
  const checked = await one<{ at: string }>(ctx.db, API(ctx), `SELECT checked_at::date::text AS at FROM app.id_checks WHERE member_id = $1 AND status = 'verified' ORDER BY checked_at DESC LIMIT 1`, [m.id]).catch(() => null);
  const pending = await one(ctx.db, API(ctx), `SELECT 1 AS x FROM app.center_changes WHERE member_id = $1 AND status = 'pending'`, [m.id]);
  const edit = cfg.members.selfService.editProfile;
  return {
    fields: [
      { key: 'name', label: 'Legal name', value: `${m.first_name} ${m.last_name}`, editable: false, kind: 'text', note: 'Changed by the office – it must match your photo ID.' },
      { key: 'preferred', label: 'Preferred name', value: m.preferred_name ?? '', editable: edit, kind: 'text', note: null },
      { key: 'email', label: 'Email', value: m.email, editable: false, kind: 'email', note: 'Changed by the office (it is how you sign in).' },
      { key: 'phone', label: 'Mobile phone', value: m.phone ?? '', editable: edit, kind: 'phone', note: null },
      { key: 'street', label: 'Street address', value: m.street ?? '', editable: edit, kind: 'address', note: null },
      { key: 'city', label: 'City', value: m.city ?? '', editable: edit, kind: 'text', note: null },
      { key: 'zip', label: 'ZIP code', value: m.zip ?? '', editable: edit, kind: 'text', note: 'A new ZIP code can move you to another masjid.' },
    ],
    residency: { zone: (await one<{ name: string }>(ctx.db, API(ctx), 'SELECT name FROM app.zones WHERE code = $1', [m.zone]))?.name ?? m.zone, center: m.center, source: 'Your home ZIP code', nearBorder: false, borderRule: null, changeNote: pending ? 'Your request to change masjid is with the office.' : null },
    id: { verified: m.id_check === 'verified', verifiedOn: checked?.at ?? null, pending: m.id_check === 'pending', required: ms.rules.approval.requireIdCheck, accepted: ['Driver’s license', 'State ID card', 'Passport'],
      retentionNote: `The photo is kept privately and deleted ${cfg.security.idDocuments.keepDays ? `after ${Math.min(30, cfg.security.idDocuments.keepDays)} days` : 'after review'}.`, reviewNote: 'The office checks that the name matches your record – usually within a few days.' },
  };
}
async function prefsOf(ctx: Ctx) {
  const m = await row(ctx); const ms = await settingsOf(ctx); const si = await signInSettings(ctx.db, ctx.orgId);
  const p = await inner<{ prefs: { email: boolean; sms: boolean; optOut: string[] } }>(ctx, 'GET', '/member/preferences');
  const push = ((m.prefs ?? {}) as { push?: { membership: boolean; masjid: boolean; events: boolean } }).push ?? { membership: true, masjid: true, events: true };
  const devices = (await rows(ctx.db, API(ctx), `SELECT family::text AS id, name, last_seen::text FROM app.member_devices WHERE member_id = $1 ORDER BY last_seen DESC`, [m.id])) as { id: string; name: string; last_seen: string }[];
  return {
    email: { newsletter: p.prefs.email && !p.prefs.optOut.includes('newsletter'), reminders: p.prefs.email && !p.prefs.optOut.includes('events') },
    sms: { enabled: p.prefs.sms, allowed: ms.flags.sms && si.methods.phoneCode, consentText: ms.consents.sms.text },
    push, directoryListed: ((m.prefs ?? {}) as { directoryListed?: boolean }).directoryListed === true,
    devices: devices.map((d) => ({ id: d.id, name: d.name || 'Phone', lastSeen: new Date(d.last_seen).toISOString(), current: d.id === ctx.session?.app_family })),
  };
}
