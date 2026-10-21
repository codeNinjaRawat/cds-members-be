/**
 * B4b Events. The admin writes events in the `events` document (web/src/lib/community/events.ts); a publish projects them into
 * app.events + app.event_ticket_types (modules/projections.ts). Registrations are rows: app.event_register() takes seats under
 * a lock on the event, so the last seat goes to one person only; a cancellation moves the waitlist up (app.event_promote()).
 * The rules are the website's own (registrationState, typeAvailable, priceFor, refundFor, canSee, publicEvent, toIcs).
 *
 * Website and portal
 *   GET  /public/events                           what the viewer may see, with live seat counts; codes never leave the server
 *   GET  /public/events/:id · GET /public/events/:id/ics
 *   POST /public/events/:id/registrations         {typeId, guests | guestNames, code?, discount?, name, email, phone?} (member session optional)
 *   GET  /public/events/registrations/:token · POST /public/events/registrations/:token/cancel   the link in the confirmation email
 *   GET  /member/events/registrations · POST /member/events/registrations/:id/cancel
 * Admin (events.manage; check-in with events.checkin; masjid roles see their masjid's events)
 *   GET  /admin/events · PUT /admin/events/:id (one event; masjid roles send for approval) · DELETE /admin/events/:id
 *   POST /admin/events/:id/approval {decision: approve | changes, note} · POST /admin/events/:id/cancel {reason}
 *   GET  /admin/events/:id/registrations[?format=csv] · POST /admin/events/:id/registrations (office / door)
 *   POST /admin/registrations/:id/check-in {guestIds?, undo?} · /paid {method} · /cancel {refund?}
 *   POST /admin/events/run-jobs                     reminders (the job runner calls runEventJobs)
 */
import { z } from 'zod';
import { one, rows, type Statement } from '../db/sql.js';
import { HttpError, PLATFORM, audit, document, need, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { sha256hex, newToken } from '../auth/crypto.js';
import { saveDocument } from './projections.js';
import { localNow } from './helpdesk.js';
import { can, inScope, roleOf } from '@/lib/community/access';
import * as E from '@/lib/community/events';
import { approvalChecks } from '@/lib/community/event-ops';
import { touchPerson } from './contacts.js';
import { OrgConfigSchema, applyDiscount } from '@/lib/community/org-config';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
const nowMin = () => localNow().slice(0, 16);
const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function eventsDoc(ctx: Ctx): Promise<E.EventsDoc> { const p = E.EventsSchema.safeParse(await document(ctx.db, ctx.orgId, 'events')); return p.success ? p.data : E.mockEvents; }
type Count = { registered: number; waiting: number; typeCounts: Record<string, number> };
type Counts = Map<string, Count>;
async function counts(ctx: Ctx, eventId?: string): Promise<Counts> {
  const list = await rows(ctx.db, API(ctx), `SELECT event_id, type_id, status, sum(seats)::int AS seats FROM app.registrations WHERE status IN ('confirmed', 'pending-payment', 'waitlist') ${eventId ? 'AND event_id = $1' : ''} GROUP BY 1, 2, 3`, eventId ? [eventId] : []) as { event_id: string; type_id: string; status: string; seats: number }[];
  const out: Counts = new Map();
  for (const r of list) {
    const c = out.get(r.event_id) ?? { registered: 0, waiting: 0, typeCounts: {} }; out.set(r.event_id, c);
    if (r.status === 'waitlist') c.waiting += r.seats; else { c.registered += r.seats; c.typeCounts[r.type_id] = (c.typeCounts[r.type_id] ?? 0) + r.seats; }
  }
  return out;
}
const live = (e: E.EventItem, c: Counts): E.EventItem => ({ ...e, ...(c.get(e.id) ?? { registered: 0, waiting: 0, typeCounts: {} }) });
/** For the admin's dashboards: people checked in and money kept (paid minus refunds) per event. */
async function outcomes(ctx: Ctx): Promise<Map<string, { attended: number; revenueCents: number }>> {
  const list = (await rows(ctx.db, API(ctx), `SELECT r.event_id, coalesce(sum(r.paid_cents - r.refund_cents) FILTER (WHERE r.status IN ('confirmed', 'refunded', 'cancelled')), 0)::int AS revenue,
      (SELECT count(*)::int FROM app.registration_guests g JOIN app.registrations x ON x.org_id = g.org_id AND x.id = g.registration_id WHERE x.event_id = r.event_id AND g.checked_in_at IS NOT NULL) AS attended
    FROM app.registrations r GROUP BY r.event_id`)) as { event_id: string; revenue: number; attended: number }[];
  return new Map(list.map((r) => [r.event_id, { attended: r.attended, revenueCents: Math.max(0, r.revenue) }]));
}

/** Who is looking: a member session brings the plan and the groups that may open pages and events. */
async function viewerOf(ctx: Ctx): Promise<E.Viewer & { memberId?: string }> {
  if (!ctx.memberId) return { signedIn: false };
  const m = await one<{ plan: string }>(ctx.db, API(ctx), 'SELECT plan FROM app.members WHERE id = $1', [ctx.memberId]);
  const g = await rows(ctx.db, API(ctx), `SELECT gm.group_id FROM app.group_members gm WHERE gm.member_id = $1 AND gm.status = 'in'`, [ctx.memberId]) as { group_id: string }[];
  return { signedIn: true, planId: m?.plan ?? undefined, groupIds: g.map((x) => x.group_id), memberId: ctx.memberId };
}

/* ---------------- admin scope ---------------- */
async function zoneOf(ctx: Ctx, center: string) { return (await one<{ code: string }>(ctx.db, API(ctx), 'SELECT z.code FROM app.centers c JOIN app.zones z ON z.org_id = c.org_id AND z.id = c.zone_id WHERE c.name = $1', [center]))?.code ?? ''; }
const scoped = (ctx: Ctx) => { const r = roleOf(ctx.access, ctx.me); return !!(r?.centerScoped || r?.zoneScoped || r?.areaScoped); };
async function inMyScope(ctx: Ctx, e: E.EventItem) { return !scoped(ctx) || (!!e.location.center && inScope(ctx.access, ctx.me, await zoneOf(ctx, e.location.center), e.location.center)); }
function needAny(ctx: Ctx, ...ps: Parameters<typeof need>[1][]) {
  if (!ps.some((p) => ctx.me && can(ctx.access, ctx.me, p, todayCT()))) need(ctx, ps[0]);   // throws the usual 401 / 403
}
async function adminEvent(ctx: Ctx, id: string) {
  const doc = await eventsDoc(ctx); const e = doc.events.find((x) => x.id === id);
  if (!e || !(await inMyScope(ctx, e))) throw new HttpError(404, `No event “${id}”.`);
  return { doc, e };
}
async function publish(ctx: Ctx, doc: E.EventsDoc, note: string) {
  const p = E.EventsSchema.safeParse(doc); if (!p.success) throw new HttpError(400, 'The event has problems.', issues(p.error));
  return saveDocument(ctx.db, ctx.orgId, 'events', p.data, ctx.me?.name ?? 'System', note);
}

/* ---------------- registrations ---------------- */
type RegRow = { id: string; event_id: string; member_id: string | null; name: string; email: string; phone: string; status: string; waitlist_pos: number | null; total_cents: number; paid_cents: number; refund_cents: number; type_id: string; seats: number; source: string; created_at: string; guests: { id: string; name: string; checkedIn: boolean }[] };
const REG_SQL = `SELECT r.id, r.event_id, r.member_id, r.name, r.email::text AS email, r.phone, r.status, r.waitlist_pos, r.total_cents, r.paid_cents, r.refund_cents, r.type_id, r.seats, r.source, r.created_at::text AS created_at,
  coalesce((SELECT json_agg(json_build_object('id', g.id, 'name', g.name, 'checkedIn', g.checked_in_at IS NOT NULL) ORDER BY g.name) FROM app.registration_guests g WHERE g.org_id = r.org_id AND g.registration_id = r.id), '[]') AS guests
  FROM app.registrations r`;
const regView = (r: RegRow, e?: E.EventItem) => ({ id: r.id, eventId: r.event_id, event: e ? { title: e.title, start: e.start, end: e.end, place: e.location.name } : undefined, name: r.name, status: r.status, waitlistPosition: r.waitlist_pos, seats: r.seats, typeId: r.type_id, totalCents: r.total_cents, paidCents: r.paid_cents, refundCents: r.refund_cents, guests: r.guests.map((g) => g.name) });
const mail = (ctx: Ctx, to: string, subject: string, text: string, kind: string): Statement => ({ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, $5)`, params: [ctx.orgId, to, subject, text, kind] });
const dbError = (e: unknown) => { const m = String((e as Error)?.message ?? e); for (const k of ['event_full', 'type_full', 'event_missing', 'type_missing']) if (m.includes(k)) return k; return ''; };

void (null as unknown as Count);
const RegIn = z.object({ typeId: z.string().max(30), guests: z.number().int().min(0).max(20).optional(), guestNames: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  code: z.string().max(30).optional(), discount: z.string().max(20).optional(), name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().max(30).default(''), answers: z.record(z.string(), z.string().max(500)).default({}) });

/** One registration through every rule. `staff` (office / door) skips codes and member-only types, never capacity. */
async function register(ctx: Ctx, e: E.EventItem, raw: unknown, how: { source: 'website' | 'portal' | 'office' | 'door'; staff?: boolean; viewer: E.Viewer & { memberId?: string } }) {
  const p = RegIn.safeParse(raw); if (!p.success) throw new HttpError(422, 'Please check the form.', issues(p.error));
  const b = p.data; const now = nowMin();
  const guestNames = b.guestNames ?? Array.from({ length: b.guests ?? 0 }, (_, i) => `${b.name} – guest ${i + 1}`);
  const seats = E.seatsFor(guestNames.length);
  if (!how.staff) {
    if (e.visibility !== 'public' && !how.viewer.signedIn) throw new HttpError(403, 'This event is for members – sign in first.');
    if (!E.canSee(e, how.viewer)) throw new HttpError(403, 'This event is for a group you are not in.');
  }
  const st = E.registrationState(e, now, seats);
  if (!st.open && !(how.staff && st.reason === 'Registration is closed.' && now <= e.end)) throw new HttpError(409, st.reason ?? 'Registration is closed.');
  const t = e.registration.types.find((x) => x.id === b.typeId); if (!t) throw new HttpError(422, 'Choose a registration type.');
  if (guestNames.length > (e.registration.guests.allowed ? e.registration.guests.max : 0)) throw new HttpError(422, 'Too many guests for this event.');
  const a = E.typeAvailable(how.staff ? { ...t, availability: 'everyone' } : t, how.viewer, b.code, e, seats);
  if (!a.ok) throw new HttpError(a.reason?.includes('places') ? 409 : 403, a.reason ?? 'Not available.');
  const dup = await one<{ id: string }>(ctx.db, API(ctx), `SELECT id FROM app.registrations WHERE event_id = $1 AND email = $2 AND status IN ('confirmed', 'pending-payment', 'waitlist')`, [e.id, b.email]);
  if (dup) throw new HttpError(409, `${b.email} is already registered (${dup.id}).`);
  if (!how.staff) {
    const recent = await one<{ n: number }>(ctx.db, API(ctx), `SELECT count(*)::int AS n FROM app.registrations WHERE email = $1 AND created_at > now() - interval '1 hour'`, [b.email]);
    if ((recent?.n ?? 0) >= 10) throw new HttpError(429, 'Many registrations from this email in the last hour – please try again later.');
  }
  let total = E.priceFor(t, guestNames.length); let discountNote = '';
  if (b.discount) {
    const cfg = OrgConfigSchema.safeParse(await document(ctx.db, ctx.orgId, 'org-config'));
    if (!cfg.success) throw new HttpError(422, 'Discount codes are not used here.');
    const d = applyDiscount(cfg.data, b.discount, total, { kind: 'event' }, now.slice(0, 10)); if (!d.ok) throw new HttpError(422, d.message);
    total = d.cents; discountNote = d.message;
  }
  const id = `REG-${(await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, 'event-reg', 10001)::text AS n`, [ctx.orgId]))!.n}`;
  const token = newToken();
  let r: { status: string; waitlist_pos: number | null } | null;
  try {
    r = await one(ctx.db, API(ctx), `SELECT * FROM app.event_register($1, $2, $3, $4, $5, $6, $7, ARRAY(SELECT jsonb_array_elements_text($8::jsonb)), $9::int, $10, $11, $12, $13::jsonb)`,
      [id, e.id, t.id, how.viewer.memberId ?? '', b.name, b.email, b.phone, JSON.stringify(guestNames), total, b.discount ? b.discount.toUpperCase() : '', sha256hex(token), how.source, JSON.stringify({ ...b.answers, ...(discountNote ? { discount: discountNote } : {}) })]);
  } catch (err) {
    const k = dbError(err);
    if (k === 'event_full') throw new HttpError(409, 'This event just filled up.');
    if (k === 'type_full') throw new HttpError(409, 'No places left for this type.');
    if (k) throw new HttpError(404, 'This event is not open for registration.');
    throw err;
  }
  await touchPerson(ctx, { firstName: b.name.split(' ')[0] ?? b.name, lastName: b.name.split(' ').slice(1).join(' '), email: b.email, phone: b.phone, source: 'event', memberId: how.viewer.memberId || null });
  const status = r!.status === 'waitlist' ? 'waitlisted' : r!.status === 'pending-payment' ? 'pending-payment' : 'registered';
  const lines = status === 'waitlisted' ? `You are number ${r!.waitlist_pos} on the waitlist for ${e.title}. We will email you if a spot opens.`
    : status === 'pending-payment' ? `Your spot at ${e.title} is held. Amount due: ${money(total)}.`
    : `You are registered for ${e.title} (${E.fmtRange(e)}).`;
  await ctx.db.run(PLATFORM, [mail(ctx, b.email, `${status === 'waitlisted' ? 'Waitlist' : 'Registration'}: ${e.title} [${id}]`, `Assalamu alaikum ${b.name.split(' ')[0]},\n\n${lines}\n\nReference: ${id}\nManage or cancel: /events/registration/${token}`, 'event-registration')]);
  return { status, ref: id, totalCents: status === 'waitlisted' ? 0 : total, waitlistPosition: r!.waitlist_pos, manageToken: token, seats };
}

/** Cancel one registration: the event's rule decides the refund (staff may give a full refund); the waitlist moves up. */
async function cancel(ctx: Ctx, r: RegRow, e: E.EventItem | undefined, opts: { by: string; staff?: boolean; refund?: boolean; quiet?: boolean }) {
  if (!['confirmed', 'pending-payment', 'waitlist'].includes(r.status)) throw new HttpError(409, `This registration is already ${r.status}.`);
  let refundCents = 0;
  if (e && !opts.staff) {
    const f = E.refundFor(e, r.paid_cents, nowMin()); if (!f.allowed) throw new HttpError(409, f.text);
    refundCents = f.refundCents;
  } else if (opts.refund) refundCents = r.paid_cents;
  const status = refundCents > 0 ? 'refunded' : 'cancelled';
  const res = await ctx.db.run(API(ctx), [
    { sql: `UPDATE app.registrations SET status = $2, refund_cents = $3::int, cancelled_at = now(), cancelled_by = $4, waitlist_pos = NULL WHERE id = $1`, params: [r.id, status, refundCents, opts.by] },
    { sql: `SELECT p AS id FROM app.event_promote($1) p`, params: [r.event_id] }]);
  const promoted = (res[1] ?? []) as { id: string }[];
  const mails: Statement[] = [];
  if (!opts.quiet) mails.push(mail(ctx, r.email, `Cancelled: ${e?.title ?? r.event_id} [${r.id}]`, `Your registration ${r.id} is cancelled.${refundCents ? ` ${money(refundCents)} will be refunded to the way you paid.` : ''}`, 'event-cancelled'));
  if (promoted.length) {
    const ps = (await rows(ctx.db, API(ctx), `${REG_SQL} WHERE r.id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`, [JSON.stringify(promoted.map((x) => x.id))])) as RegRow[];
    for (const p of ps) mails.push(mail(ctx, p.email, `A spot opened: ${e?.title ?? p.event_id} [${p.id}]`, p.total_cents ? `A spot opened for you. Amount due: ${money(p.total_cents)}.` : 'A spot opened – you are now registered.', 'event-waitlist'));
  }
  if (mails.length) await ctx.db.run(PLATFORM, mails);
  return { status, refundCents, promoted: promoted.map((x) => x.id) };
}
async function regById(ctx: Ctx, id: string) { const r = await one<RegRow>(ctx.db, API(ctx), `${REG_SQL} WHERE r.id = $1`, [id]); if (!r) throw new HttpError(404, `No registration ${id}.`); return r; }

/* ---------------- routes ---------------- */
const EID = '([a-z0-9-]{2,80})';
/** A visitor's registrations (the member app, no account): matched by the email of the contact they left. */
export async function registrationsByEmail(ctx: Ctx, email: string) {
  const doc = await eventsDoc(ctx);
  const list = (await rows(ctx.db, API(ctx), `${REG_SQL} WHERE r.member_id IS NULL AND lower(r.email::text) = lower($1) ORDER BY r.created_at DESC`, [email])) as RegRow[];
  return list.map((r) => { const e = doc.events.find((x) => x.id === r.event_id); return { ...regView(r, e), cancel: e && ['confirmed', 'pending-payment', 'waitlist'].includes(r.status) ? E.refundFor(e, r.paid_cents, nowMin()) : null }; });
}
export const EVENT_ROUTES: Route[] = [
  route('GET', /^\/public\/events$/, async (ctx) => {
    const doc = await eventsDoc(ctx); if (!doc.enabled) return { status: 200, body: { enabled: false, showPast: false, events: [] } };
    const [v, c] = await Promise.all([viewerOf(ctx), counts(ctx)]); const today = nowMin();
    const list = doc.events.filter((e) => E.canSee(e, v) && (doc.showPast || e.end >= today)).map((e) => E.publicEvent(live(e, c))).sort((a, b) => a.start.localeCompare(b.start));
    return { status: 200, body: { enabled: true, showPast: doc.showPast, defaultReminderDays: doc.defaultReminderDays, approval: doc.approval, events: list } };
  }),
  route('GET', new RegExp(`^/public/events/${EID}(/ics)?$`), async (ctx, mm) => {
    const doc = await eventsDoc(ctx); const v = await viewerOf(ctx);
    const e = doc.enabled ? doc.events.find((x) => x.id === mm[1] && E.canSee(x, v)) : undefined; if (!e) throw new HttpError(404, 'Event not found.');
    if (mm[2]) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
      return { status: 200, body: E.toIcs(e, { name: ctx.slug.toUpperCase(), domain: `${ctx.slug}.org` }, stamp), headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${e.id}.ics"` } };
    }
    const x = live(e, await counts(ctx, e.id)); const now = nowMin();
    return { status: 200, body: { event: E.publicEvent(x), state: E.registrationState(x, now), spotsLeft: Number.isFinite(E.spotsLeft(x)) ? E.spotsLeft(x) : null,
      types: x.registration.types.filter((t) => t.enabled).map((t) => ({ id: t.id, name: t.name, priceCents: t.priceCents, guestPriceCents: t.guestPriceCents, needsCode: t.availability === 'code', ...E.typeAvailable({ ...t, code: undefined }, v, t.availability === 'code' ? 'x' : undefined, x) })) } };
  }),
  route('POST', new RegExp(`^/public/events/${EID}/registrations$`), async (ctx, mm) => {
    const b = body(ctx); if (typeof b.website === 'string' && b.website) return { status: 202, body: { status: 'registered', ref: 'REG-0' } };   // honeypot
    const doc = await eventsDoc(ctx); const e = doc.enabled ? doc.events.find((x) => x.id === mm[1] && x.status !== 'draft') : undefined; if (!e) throw new HttpError(404, 'Event not found.');
    const v = await viewerOf(ctx); const ev = live(e, await counts(ctx, e.id));
    let input = b;
    if (v.memberId) { const m = await one<{ first_name: string; last_name: string; email: string; phone: string }>(ctx.db, API(ctx), 'SELECT first_name, last_name, email, phone FROM app.members WHERE id = $1', [v.memberId]); input = { ...b, name: `${m!.first_name} ${m!.last_name}`, email: m!.email || b.email, phone: m!.phone || b.phone || '' }; }
    // the code is checked here, against the server copy (the website never has it)
    const t = e.registration.types.find((x) => x.id === b.typeId);
    if (t?.availability === 'code' && String(b.code ?? '').trim().toUpperCase() !== String(t.code ?? '').toUpperCase()) throw new HttpError(403, 'Enter the registration code you were given.');
    return { status: 201, body: await register(ctx, ev, input, { source: v.memberId ? 'portal' : 'website', viewer: v }) };
  }),
  route('GET', /^\/public\/events\/registrations\/([A-Za-z0-9_-]{30,60})$/, async (ctx, mm) => {
    const r = await one<RegRow>(ctx.db, API(ctx), `${REG_SQL} WHERE r.manage_hash = $1`, [sha256hex(mm[1])]); if (!r) throw new HttpError(404, 'This link does not work any more.');
    const e = (await eventsDoc(ctx)).events.find((x) => x.id === r.event_id);
    return { status: 200, body: { registration: regView(r, e), cancel: e ? E.refundFor(e, r.paid_cents, nowMin()) : { allowed: false, refundCents: 0, text: '' } } };
  }),
  route('POST', /^\/public\/events\/registrations\/([A-Za-z0-9_-]{30,60})\/cancel$/, async (ctx, mm) => {
    const r = await one<RegRow>(ctx.db, API(ctx), `${REG_SQL} WHERE r.manage_hash = $1`, [sha256hex(mm[1])]); if (!r) throw new HttpError(404, 'This link does not work any more.');
    const e = (await eventsDoc(ctx)).events.find((x) => x.id === r.event_id);
    return { status: 200, body: await cancel(ctx, r, e, { by: r.name }) };
  }),
  route('GET', /^\/member\/events\/registrations$/, async (ctx) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const doc = await eventsDoc(ctx);
    const list = (await rows(ctx.db, API(ctx), `${REG_SQL} WHERE r.member_id = $1 ORDER BY r.created_at DESC`, [ctx.memberId])) as RegRow[];
    return { status: 200, body: { registrations: list.map((r) => { const e = doc.events.find((x) => x.id === r.event_id); return { ...regView(r, e), cancel: e && ['confirmed', 'pending-payment', 'waitlist'].includes(r.status) ? E.refundFor(e, r.paid_cents, nowMin()) : null }; }) } };
  }),
  route('POST', /^\/member\/events\/registrations\/(REG-\d+)\/cancel$/, async (ctx, mm) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const r = await regById(ctx, mm[1]); if (r.member_id !== ctx.memberId) throw new HttpError(404, `No registration ${mm[1]}.`);
    return { status: 200, body: await cancel(ctx, r, (await eventsDoc(ctx)).events.find((x) => x.id === r.event_id), { by: r.name }) };
  }),

  /* ---------------- admin ---------------- */
  route('GET', /^\/admin\/events$/, async (ctx) => {
    needAny(ctx, 'events.manage', 'events.checkin');
    const doc = await eventsDoc(ctx); const c = await counts(ctx); const today = todayCT();
    const mine: E.EventItem[] = []; for (const e of doc.events) if (await inMyScope(ctx, e)) mine.push(live(e, c));
    const q = ctx.req.query;
    const out = await outcomes(ctx);
    const list = mine.filter((e) => (!q.get('status') || e.status === q.get('status') || (q.get('status') === 'pending' && e.approval.state === 'pending')) && (!q.get('when') || (q.get('when') === 'past' ? e.end.slice(0, 10) < today : e.end.slice(0, 10) >= today)))
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((e) => ({ ...e, ...(out.get(e.id) ?? { attended: 0, revenueCents: 0 }), approvalChecks: e.approval.state === 'pending' ? approvalChecks(e, doc, today) : undefined }));
    return { status: 200, body: { count: list.length, approval: doc.approval, events: list } };
  }),
  route('PUT', new RegExp(`^/admin/events/${EID}$`), async (ctx, mm) => {
    need(ctx, 'events.manage');
    const p = E.EventSchema.safeParse({ ...body(ctx), id: mm[1] }); if (!p.success) throw new HttpError(400, 'The event has problems.', issues(p.error));
    let e = p.data; const doc = await eventsDoc(ctx); const old = doc.events.find((x) => x.id === e.id);
    if (old && !(await inMyScope(ctx, old))) throw new HttpError(404, `No event “${e.id}”.`);
    if (scoped(ctx)) {
      const home = ctx.me!.centers[0] ?? '';
      if (!e.location.center || !(await inMyScope(ctx, e))) throw new HttpError(403, `Your events belong to ${home || 'your masjid'} – set it as the event's masjid.`);
      // F9: masjid roles send events for approval; an approved event that is changed goes back for approval
      if (doc.approval.required && e.status === 'published' && !(old && old.status === 'published' && JSON.stringify({ ...old, approval: null }) === JSON.stringify({ ...e, approval: null })))
        e = { ...e, status: 'draft', approval: { state: 'pending', requestedBy: ctx.me!.name, by: '', on: todayCT(), note: '' } };
    }
    if (old) {
      const c = (await counts(ctx, e.id)).get(e.id);
      if (c && e.registration.capacity && e.registration.capacity < c.registered) throw new HttpError(409, `${c.registered} seats are already taken – the capacity cannot go below that.`);
      const gone = old.registration.types.filter((t) => !e.registration.types.some((x) => x.id === t.id) && (c?.typeCounts[t.id] ?? 0) > 0);
      if (gone.length) throw new HttpError(409, `People are registered as “${gone.map((t) => t.name).join('”, “')}” – turn the type off instead of removing it.`);
      if (old.status === 'cancelled' && e.status !== 'cancelled') throw new HttpError(409, 'A cancelled event stays cancelled – make a new one.');
      if (e.status === 'cancelled' && old.status !== 'cancelled') throw new HttpError(400, 'Use “Cancel event” so registrations are cancelled and people are told.');
    }
    const next = { ...doc, events: old ? doc.events.map((x) => (x.id === e.id ? e : x)) : [...doc.events, e] };
    const v = await publish(ctx, next, `${old ? 'Changed' : 'Added'} ${e.title}`);
    await audit(ctx, 'events', old ? 'Event changed' : 'Event added', `${e.title}${e.approval.state === 'pending' ? ' (sent for approval)' : ''}`, e.id);
    return { status: old ? 200 : 201, body: { event: e, version: v, sentForApproval: e.approval.state === 'pending' } };
  }),
  route('DELETE', new RegExp(`^/admin/events/${EID}$`), async (ctx, mm) => {
    need(ctx, 'events.manage'); const { doc, e } = await adminEvent(ctx, mm[1]);
    const n = await one<{ n: number }>(ctx.db, API(ctx), 'SELECT count(*)::int AS n FROM app.registrations WHERE event_id = $1', [e.id]);
    if (n!.n) throw new HttpError(409, `${n!.n} registrations – cancel the event instead, so people are told.`);
    await publish(ctx, { ...doc, events: doc.events.filter((x) => x.id !== e.id) }, `Removed ${e.title}`);
    await audit(ctx, 'events', 'Event removed', e.title, e.id);
    return { status: 200, body: { deleted: e.id } };
  }),
  route('POST', new RegExp(`^/admin/events/${EID}/approval$`), async (ctx, mm) => {
    need(ctx, 'events.manage'); if (scoped(ctx)) throw new HttpError(403, 'Masjid roles send events for approval; someone organization-wide approves them.');
    const { doc, e } = await adminEvent(ctx, mm[1]); if (e.approval.state !== 'pending') throw new HttpError(409, 'This event is not waiting for approval.');
    const b = body(ctx); const decision = String(b.decision ?? ''); const note = String(b.note ?? '').slice(0, 300);
    if (!['approve', 'changes'].includes(decision)) throw new HttpError(400, 'Decide approve or changes.');
    if (decision === 'changes' && note.length < 3) throw new HttpError(400, 'Say what should change.');
    const ne: E.EventItem = decision === 'approve' ? { ...e, status: 'published', approval: { ...e.approval, state: 'approved', by: ctx.me!.name, on: todayCT(), note } } : { ...e, approval: { ...e.approval, state: 'changes', by: ctx.me!.name, on: todayCT(), note } };
    await publish(ctx, { ...doc, events: doc.events.map((x) => (x.id === e.id ? ne : x)) }, `${decision === 'approve' ? 'Approved' : 'Changes asked for'}: ${e.title}`);
    const requester = ctx.access.admins.find((a) => a.name === e.approval.requestedBy);
    if (requester) await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.notices (org_id, admin_id, kind, title, link) VALUES ($1::uuid, $2, 'approval', $3, $4)`, params: [ctx.orgId, requester.id, `${decision === 'approve' ? 'Approved' : 'Changes asked'}: ${e.title}${note ? ` – ${note}` : ''}`, `/events?event=${e.id}`] }]);
    await audit(ctx, 'events', decision === 'approve' ? 'Event approved' : 'Event changes asked', note || e.title, e.id);
    return { status: 200, body: { event: ne } };
  }),
  route('POST', new RegExp(`^/admin/events/${EID}/cancel$`), async (ctx, mm) => {
    need(ctx, 'events.manage'); const { doc, e } = await adminEvent(ctx, mm[1]);
    if (e.status === 'cancelled') throw new HttpError(409, 'Already cancelled.');
    const reason = String(body(ctx).reason ?? '').trim().slice(0, 300); if (reason.length < 3) throw new HttpError(400, 'Give the reason people will read.');
    await publish(ctx, { ...doc, events: doc.events.map((x) => (x.id === e.id ? { ...x, status: 'cancelled' as const } : x)) }, `Cancelled ${e.title}`);
    const regs = (await rows(ctx.db, API(ctx), `${REG_SQL} WHERE r.event_id = $1 AND r.status IN ('confirmed', 'pending-payment', 'waitlist')`, [e.id])) as RegRow[];
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.registrations SET status = CASE WHEN paid_cents > 0 THEN 'refunded' ELSE 'cancelled' END, refund_cents = paid_cents, cancelled_at = now(), cancelled_by = $2, waitlist_pos = NULL WHERE event_id = $1 AND status IN ('confirmed', 'pending-payment', 'waitlist')`, params: [e.id, ctx.me!.name] }]);
    if (regs.length) await ctx.db.run(PLATFORM, regs.map((r) => mail(ctx, r.email, `Cancelled: ${e.title}`, `Assalamu alaikum ${r.name.split(' ')[0]},\n\nWe are sorry – ${e.title} (${E.fmtRange(e)}) is cancelled. ${reason}${r.paid_cents ? `\n\n${money(r.paid_cents)} will be refunded to the way you paid.` : ''}`, 'event-cancelled')));
    await audit(ctx, 'events', 'Event cancelled', `${e.title}: ${reason} (${regs.length} told)`, e.id);
    return { status: 200, body: { cancelled: e.id, told: regs.length, refundsCents: regs.reduce((s, r) => s + r.paid_cents, 0) } };
  }),
  route('GET', new RegExp(`^/admin/events/${EID}/registrations$`), async (ctx, mm) => {
    needAny(ctx, 'events.manage', 'events.checkin'); const { e } = await adminEvent(ctx, mm[1]);
    const list = (await rows(ctx.db, API(ctx), `${REG_SQL} WHERE r.event_id = $1 ORDER BY CASE r.status WHEN 'confirmed' THEN 0 WHEN 'pending-payment' THEN 1 WHEN 'waitlist' THEN 2 ELSE 3 END, r.waitlist_pos NULLS FIRST, lower(r.name)`, [e.id])) as RegRow[];
    const checkinOnly = !can(ctx.access, ctx.me, 'events.manage', todayCT());
    const q = (ctx.req.query.get('q') ?? '').toLowerCase();
    const shown = list.filter((r) => !q || `${r.id} ${r.name} ${r.email} ${r.guests.map((g) => g.name).join(' ')}`.toLowerCase().includes(q))
      .map((r) => checkinOnly ? { id: r.id, name: r.name, status: r.status, seats: r.seats, typeId: r.type_id, guests: r.guests, dueCents: r.total_cents - r.paid_cents } : { ...r, dueCents: Math.max(0, r.total_cents - r.paid_cents) });
    if (ctx.req.query.get('format') === 'csv') {
      if (checkinOnly) throw new HttpError(403, 'Check-in volunteers see the door list only.');
      const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = [['Reference', 'Name', 'Email', 'Phone', 'Status', 'Type', 'Seats', 'Guests', 'Total', 'Paid', 'Checked in', 'Registered'].join(','),
        ...list.map((r) => [r.id, r.name, r.email, r.phone, r.status, r.type_id, r.seats, r.guests.slice(1).map((g) => g.name).join('; '), (r.total_cents / 100).toFixed(2), (r.paid_cents / 100).toFixed(2), r.guests.filter((g) => g.checkedIn).length, r.created_at.slice(0, 16)].map(cell).join(','))].join('\r\n');
      return { status: 200, body: csv, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${e.id}-registrations.csv"` } };
    }
    const c = (await counts(ctx, e.id)).get(e.id) ?? { registered: 0, waiting: 0, typeCounts: {} };
    const checkedIn = list.reduce((s, r) => s + r.guests.filter((g) => g.checkedIn).length, 0);
    return { status: 200, body: { event: { id: e.id, title: e.title, start: e.start, capacity: e.registration.capacity }, totals: { ...c, checkedIn }, registrations: shown } };
  }),
  route('POST', new RegExp(`^/admin/events/${EID}/registrations$`), async (ctx, mm) => {
    needAny(ctx, 'events.manage', 'events.checkin'); const { e } = await adminEvent(ctx, mm[1]);
    if (e.status !== 'published') throw new HttpError(409, 'Only published events take registrations.');
    const out = await register(ctx, live(e, await counts(ctx, e.id)), body(ctx), { source: String(body(ctx).source) === 'door' ? 'door' : 'office', staff: true, viewer: { signedIn: true } });
    await audit(ctx, 'events', 'Registered by staff', `${out.ref} for ${e.title}`, out.ref);
    return { status: 201, body: out };
  }),
  route('POST', /^\/admin\/registrations\/(REG-\d+)\/(check-in|paid|cancel)$/, async (ctx, mm) => {
    const r = await regById(ctx, mm[1]); const { e } = await adminEvent(ctx, r.event_id); const b = body(ctx);
    if (mm[2] === 'check-in') {
      needAny(ctx, 'events.checkin', 'events.manage');
      if (r.status !== 'confirmed') throw new HttpError(409, r.status === 'pending-payment' ? `Not paid yet – ${money(r.total_cents - r.paid_cents)} due.` : `This registration is ${r.status}.`);
      const day = todayCT(); const manage = can(ctx.access, ctx.me, 'events.manage', day);
      if (!manage && (day < e.start.slice(0, 10) || day > e.end.slice(0, 10))) throw new HttpError(409, 'Check-in opens on the day of the event.');
      const ids = Array.isArray(b.guestIds) && b.guestIds.length ? (b.guestIds as string[]) : r.guests.map((g) => g.id);
      if (ids.some((id) => !r.guests.some((g) => g.id === id))) throw new HttpError(400, 'Unknown guest on this registration.');
      await ctx.db.run(API(ctx), [{ sql: `UPDATE app.registration_guests SET checked_in_at = ${b.undo ? 'NULL' : 'coalesce(checked_in_at, now())'}, checked_in_by = $3 WHERE registration_id = $1 AND id::text = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, params: [r.id, JSON.stringify(ids), b.undo ? '' : ctx.me!.name] }]);
      const now = await regById(ctx, r.id);
      return { status: 200, body: { id: r.id, checkedIn: now.guests.filter((g) => g.checkedIn).length, of: now.guests.length } };
    }
    need(ctx, 'events.manage');
    if (mm[2] === 'paid') {
      if (r.status !== 'pending-payment') throw new HttpError(409, `Nothing is due (${r.status}).`);
      const method = String(b.method ?? ''); if (!['cash', 'check', 'card-reader', 'waived'].includes(method)) throw new HttpError(400, 'How was it paid: cash, check, card-reader or waived?');
      await ctx.db.run(API(ctx), [{ sql: `UPDATE app.registrations SET status = 'confirmed', paid_cents = CASE WHEN $2 = 'waived' THEN 0 ELSE total_cents END, paid_method = $2 WHERE id = $1`, params: [r.id, method] }]);
      await audit(ctx, 'events', 'Registration paid', `${r.id} ${method} ${money(r.total_cents)}`, r.id);
      return { status: 200, body: { id: r.id, status: 'confirmed' } };
    }
    const out = await cancel(ctx, r, e, { by: ctx.me!.name, staff: true, refund: !!b.refund });
    await audit(ctx, 'events', 'Registration cancelled', `${r.id}${out.refundCents ? ` refund ${money(out.refundCents)}` : ''}`, r.id);
    return { status: 200, body: out };
  }),
  route('POST', /^\/admin\/events\/run-jobs$/, async (ctx) => { need(ctx, 'settings.manage'); return { status: 200, body: await runEventJobs(ctx) }; }),
];

/** Daily: "Event reminder" emails N days before (each registration once per N). */
export async function runEventJobs(ctx: Ctx, today = todayCT()) {
  const doc = await eventsDoc(ctx); let reminders = 0;
  const day = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  for (const e of doc.events.filter((x) => x.status === 'published' && x.registration.enabled)) {
    for (const n of e.reminders) {
      if (day(e.start.slice(0, 10), n) !== today) continue;
      const due = (await rows(ctx.db, API(ctx), `${REG_SQL} WHERE r.event_id = $1 AND r.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM app.event_reminders x WHERE x.registration_id = r.id AND x.days_before = $2::smallint)`, [e.id, n])) as RegRow[];
      if (!due.length) continue;
      await ctx.db.run(API(ctx), due.map((r) => ({ sql: 'INSERT INTO app.event_reminders (org_id, registration_id, days_before) VALUES ($1::uuid, $2, $3::smallint) ON CONFLICT DO NOTHING', params: [ctx.orgId, r.id, n] })));
      await ctx.db.run(PLATFORM, due.map((r) => mail(ctx, r.email, `Reminder: ${e.title} ${n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`}`, `Assalamu alaikum ${r.name.split(' ')[0]},\n\n${e.title} – ${E.fmtRange(e)} at ${e.location.name}${e.location.address ? `, ${e.location.address}` : ''}.\nReference: ${r.id} (${r.seats} ${r.seats === 1 ? 'seat' : 'seats'}).`, 'event-reminder')));
      reminders += due.length;
    }
  }
  return { reminders };
}
