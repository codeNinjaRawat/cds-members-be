/**
 * B4a Help desk + Team tasks on the 0012 tables. The rules are the admin's own (web/src/lib/community/work.ts): the API
 * loads rows into the same Ticket / Task shapes, runs the same pure functions (reply, note, assign, merge, ticketClocks,
 * routeOwner, canSeeTicket, completeTask, projectFromTemplate…) and writes back only what changed. Times inside the rules
 * are the organization's local wall-clock ('YYYY-MM-DDTHH:mm:ss'); the database keeps timestamptz.
 *
 * Help desk (members.view to see, scope by masjid; restricted tickets only for the people involved and senior roles)
 *   GET  /admin/helpdesk/tickets?view=&category=&q=     list with both clocks · GET /admin/helpdesk/stats
 *   GET  /admin/helpdesk/tickets/:id                     ticket + thread + links
 *   POST /admin/helpdesk/tickets                         phone / walk-in / email / staff (routed by category and masjid)
 *   PATCH /admin/helpdesk/tickets/:id                    status, owner, priority, category, masjid, tags, watchers, restricted
 *   POST /admin/helpdesk/tickets/:id/replies {text, status?}  → the requester gets it (outbox) · /notes {text} (@mentions)
 *   POST /admin/helpdesk/tickets/:id/requester {text}   what the requester said by phone / at the desk
 *   GET  /admin/helpdesk/tickets?view=any&full=1        every visible ticket with its thread (the admin's own screens)
 *   POST /admin/helpdesk/tickets/:id/merge {into} · POST /admin/helpdesk/bulk {ids, assignee?|status?|priority?}
 *   POST /admin/helpdesk/tickets/:id/task {owner, due}   ticket → team task (linked both ways)
 *   POST /public/helpdesk/tickets · POST /member/helpdesk/tickets · GET /member/helpdesk/tickets · POST /member/helpdesk/tickets/:id/reply
 *   POST /admin/helpdesk/run-jobs                        auto-close + escalation (the job runner calls the same function)
 * Team tasks (every admin; what they see follows canSeeTask / canSeeProject)
 *   GET /admin/tasks · POST /admin/tasks · PATCH /admin/tasks/:id · POST /admin/tasks/:id/done | reopen | comments · DELETE /admin/tasks/:id
 *   GET /admin/tasks/projects · POST /admin/tasks/projects · POST /admin/tasks/projects/from-template · PATCH /admin/tasks/projects/:id
 */
import { z } from 'zod';
import { one, rows, type Statement } from '../db/sql.js';
import { HttpError, PLATFORM, audit, document, need, needMember, orgTz, route, todayCT, type Ctx, type Res, type Route } from '../http/core.js';
import { inScope, roleOf } from '@/lib/community/access';
import * as W from '@/lib/community/work';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
export function localNow(tz = orgTz()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date());
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '00';
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}`;
}
const L = (col: string) => `CASE WHEN ${col} IS NULL THEN '' ELSE to_char(${col} AT TIME ZONE app.org_tz(), 'YYYY-MM-DD"T"HH24:MI:SS') END`;
const TS = (n: number) => `(NULLIF($${n}, '')::timestamp AT TIME ZONE app.org_tz())`;

async function settings(ctx: Ctx): Promise<W.WorkSettings> { const p = W.WorkSettingsSchema.safeParse(await document(ctx.db, ctx.orgId, 'work-settings')); return p.success ? p.data : W.mockWorkSettings; }
async function centerMap(ctx: Ctx) {
  const list = await rows(ctx.db, API(ctx), `SELECT c.id, c.name, z.code AS zone FROM app.centers c JOIN app.zones z ON z.org_id = c.org_id AND z.id = c.zone_id`) as { id: string; name: string; zone: string }[];
  return { byId: new Map(list.map((c) => [c.id, c])), byName: new Map(list.map((c) => [c.name, c])) };
}
function viewer(ctx: Ctx, centers: Awaited<ReturnType<typeof centerMap>>): W.Viewer {
  const role = roleOf(ctx.access, ctx.me);
  return { id: ctx.me!.id, roleId: role?.id ?? '', name: ctx.me!.name, orgWide: !(role?.centerScoped || role?.zoneScoped || role?.areaScoped),
    inScope: (center: string) => inScope(ctx.access, ctx.me, centers.byName.get(center)?.zone ?? '', center) };
}
const actor = (ctx: Ctx): W.Actor => ({ id: ctx.me!.id, name: ctx.me!.name });
const admins = (ctx: Ctx) => ctx.access.admins.filter((a) => a.status === 'active').map((a) => ({ id: a.id, name: a.name, roleId: a.roleId, centers: a.centers, status: a.status, more: a.more?.map((m) => ({ roleId: m.roleId, centers: m.centers })) }));

/* ---------------- tickets: load / save ---------------- */
const TICKET_SQL = `SELECT t.id, t.subject, t.category_id, t.channel, t.requester_name, t.requester_email, t.requester_phone, coalesce(t.member_id, '') AS member_id, t.center_id, coalesce(t.assignee, '') AS assignee,
  t.watchers, t.tags, t.priority, t.status, t.restricted, ${L('t.created_at')} AS created_at, t.created_by, ${L('t.first_response_at')} AS first_response_at, ${L('t.solved_at')} AS solved_at, ${L('t.closed_at')} AS closed_at,
  coalesce(t.merged_into, '') AS merged_into, t.csat_score, t.csat_comment,
  coalesce((SELECT json_agg(json_build_object('id', 'db' || e.id, 'at', ${L('e.at')}, 'by', e.by, 'kind', e.kind, 'text', e.text, 'status', e.status, 'to', e.to_admin, 'mentions', e.mentions) ORDER BY e.at, e.id) FROM app.hd_events e WHERE e.org_id = t.org_id AND e.ticket_id = t.id), '[]') AS events,
  coalesce((SELECT json_agg(json_build_object('kind', l.kind, 'id', l.ref_id, 'label', l.label)) FROM app.hd_links l WHERE l.org_id = t.org_id AND l.ticket_id = t.id), '[]') AS links
  FROM app.hd_tickets t`;
type TRow = Record<string, any>;
function toTicket(r: TRow, centers: Awaited<ReturnType<typeof centerMap>>): W.Ticket {
  return { id: r.id, subject: r.subject, categoryId: r.category_id, channel: r.channel, requester: { name: r.requester_name, email: r.requester_email, phone: r.requester_phone, memberId: r.member_id },
    center: r.center_id ? centers.byId.get(r.center_id)?.name ?? '' : '', assignee: r.assignee, watchers: r.watchers ?? [], tags: r.tags ?? [], priority: r.priority, status: r.status, restricted: r.restricted,
    createdAt: r.created_at, createdBy: r.created_by, firstResponseAt: r.first_response_at, solvedAt: r.solved_at, closedAt: r.closed_at, mergedInto: r.merged_into, links: r.links ?? [],
    csat: r.csat_score ? { score: r.csat_score, comment: r.csat_comment, at: '' } : null,
    events: (r.events ?? []).map((e: any) => ({ ...e, status: e.status ?? undefined, to: e.to ?? undefined, mentions: e.mentions ?? [] })) };
}
async function loadTicket(ctx: Ctx, id: string, centers: Awaited<ReturnType<typeof centerMap>>, s: W.WorkSettings): Promise<W.Ticket> {
  const r = await one<TRow>(ctx.db, API(ctx), `${TICKET_SQL} WHERE t.id = $1`, [id]);
  if (!r) throw new HttpError(404, `No ticket ${id}.`);
  const t = toTicket(r, centers);
  if (!W.canSeeTicket(t, viewer(ctx, centers), s.helpdesk)) throw new HttpError(404, `No ticket ${id}.`);   // never confirm a restricted ticket exists
  return t;
}
function saveSql(ctx: Ctx, t: W.Ticket, centers: Awaited<ReturnType<typeof centerMap>>, insert = false): Statement[] {
  const centerId = t.center ? centers.byName.get(t.center)?.id ?? '' : '';
  const p = [ctx.orgId, t.id, t.subject, t.categoryId, t.channel, t.requester.name, t.requester.email, t.requester.phone, t.requester.memberId, centerId, t.assignee, `{${t.watchers.map((w) => `"${w}"`).join(',')}}`, `{${t.tags.map((w) => `"${w.replace(/"/g, '')}"`).join(',')}}`,
    t.priority, t.status, t.restricted, t.createdAt, t.createdBy, t.firstResponseAt, t.solvedAt, t.closedAt, t.mergedInto, t.csat?.score ?? '', t.csat?.comment ?? ''];
  const main: Statement = insert
    ? { sql: `INSERT INTO app.hd_tickets (org_id, id, subject, category_id, channel, requester_name, requester_email, requester_phone, member_id, center_id, assignee, watchers, tags, priority, status, restricted, created_at, created_by, first_response_at, solved_at, closed_at, merged_into, csat_score, csat_comment)
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), NULLIF($10, '')::uuid, NULLIF($11, ''), $12::text[], $13::text[], $14, $15, $16::boolean, ${TS(17)}, $18, ${TS(19)}, ${TS(20)}, ${TS(21)}, NULLIF($22, ''), NULLIF($23, ''), $24)`, params: p }
    : { sql: `UPDATE app.hd_tickets SET subject = $3, category_id = $4, channel = $5, requester_name = $6, requester_email = $7, requester_phone = $8, member_id = NULLIF($9, ''), center_id = NULLIF($10, '')::uuid, assignee = NULLIF($11, ''),
        watchers = $12::text[], tags = $13::text[], priority = $14, status = $15, restricted = $16::boolean, first_response_at = ${TS(19)}, solved_at = ${TS(20)}, closed_at = ${TS(21)}, merged_into = NULLIF($22, ''), csat_score = NULLIF($23, ''), csat_comment = $24
        WHERE id = $2 AND org_id = $1::uuid AND ($17::text, $18::text) IS NOT NULL`, params: p };
  const fresh = t.events.filter((e) => !e.id.startsWith('db'));
  return [main, ...fresh.map((e) => ({ sql: `INSERT INTO app.hd_events (org_id, ticket_id, at, by, kind, text, status, to_admin, mentions) VALUES ($1::uuid, $2, ${TS(3)}, $4, $5, $6, NULLIF($7, ''), NULLIF($8, ''), $9::text[])`,
    params: [ctx.orgId, t.id, e.at, e.by, e.kind, e.text ?? '', e.status ?? '', e.to ?? '', `{${(e.mentions ?? []).map((m) => `"${m}"`).join(',')}}`] })),
    { sql: `DELETE FROM app.hd_links WHERE ticket_id = $1`, params: [t.id] },
    ...t.links.map((l) => ({ sql: `INSERT INTO app.hd_links (org_id, ticket_id, kind, ref_id, label) VALUES ($1::uuid, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, params: [ctx.orgId, t.id, l.kind, l.id, l.label] }))];
}
const outboxReply = (ctx: Ctx, t: W.Ticket, text: string): Statement[] => t.requester.email
  ? [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, 'ticket-reply')`, params: [ctx.orgId, t.requester.email, `Re: ${t.subject} [${t.id}]`, text] }] : [];
async function noticeMentions(ctx: Ctx, t: W.Ticket, ids: string[]) {
  if (!ids.length) return;
  await ctx.db.run(API(ctx), ids.map((a) => ({ sql: `INSERT INTO app.notices (org_id, admin_id, kind, title, link) VALUES ($1::uuid, $2, 'mention', $3, $4)`, params: [ctx.orgId, a, `${ctx.me!.name} mentioned you on ${t.id}: ${t.subject}`, `/queues/tickets?ticket=${t.id}`] })));
}
async function persist(ctx: Ctx, t: W.Ticket, centers: Awaited<ReturnType<typeof centerMap>>, extra: Statement[] = []) {
  const st = saveSql(ctx, t, centers);
  await ctx.db.run(API(ctx), [...st, ...extra.filter((x) => !x.sql.includes('platform.'))]);
  const plat = extra.filter((x) => x.sql.includes('platform.')); if (plat.length) await ctx.db.run(PLATFORM, plat);
}
async function nextId(ctx: Ctx) { return `T-${(await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, 'hd-ticket', 1041)::text AS n`, [ctx.orgId]))!.n}`; }

const NewTicket = z.object({ subject: z.string().trim().min(4).max(140), detail: z.string().trim().min(3).max(5000), categoryId: z.string(), channel: z.enum(['phone', 'walk-in', 'email', 'staff']).default('phone'),
  name: z.string().trim().min(2).max(120), email: z.union([z.literal(''), z.string().email()]).default(''), phone: z.string().max(30).default(''), memberId: z.string().max(40).default(''),
  center: z.string().max(80).default(''), priority: z.enum(W.PRIORITY_KEYS).optional(), assignee: z.string().optional() });

/** A request from the website form or the member portal. */
async function fromWebsite(ctx: Ctx, from: 'public' | 'member', anonymous = false): Promise<Res> {
    const s = await settings(ctx); const b = body(ctx);
    if (typeof b.website === 'string' && b.website) return { status: 202, body: { reference: 'T-0000' } };   // honeypot
    if (!s.helpdesk.enabled || !s.helpdesk.websiteForms) throw new HttpError(422, 'Online requests are switched off – please call the office.');
    let who = { name: String(b.name ?? ''), email: String(b.email ?? ''), phone: String(b.phone ?? ''), memberId: '' }; let center = String(b.center ?? '');
    if (from === 'member') {
      const id = needMember(ctx);
      const m = await one<{ first_name: string; last_name: string; email: string; phone: string; center: string }>(ctx.db, API(ctx), 'SELECT first_name, last_name, email, phone, center FROM app.members WHERE id = $1', [id]);
      who = { name: `${m!.first_name} ${m!.last_name}`, email: m!.email, phone: m!.phone, memberId: id }; center = m!.center;
    }
    if (anonymous) who = { name: 'Anonymous', email: '', phone: '', memberId: '' };   // no way to answer – the office only reads it
    const schema = anonymous ? W.PublicTicketSchema.extend({ email: z.literal('') }) : W.PublicTicketSchema;
    const p = schema.safeParse({ ...b, ...who, center }); if (!p.success) throw new HttpError(422, 'Some answers need a look.', issues(p.error));
    const cat = s.helpdesk.categories.find((c) => c.id === p.data.categoryId && c.onWebsite && !c.archived); if (!cat) throw new HttpError(422, 'Pick one of the listed topics.');
    const recent = await one<{ n: number }>(ctx.db, API(ctx), `SELECT count(*)::int AS n FROM app.hd_tickets WHERE requester_email = $1 AND created_at > now() - interval '1 hour'`, [p.data.email]);
    if ((recent?.n ?? 0) >= (anonymous ? 30 : 5)) throw new HttpError(429, 'You sent several requests in the last hour – we will answer those first.');
    const centers = await centerMap(ctx);
    const t = W.newTicket({ id: await nextId(ctx), subject: p.data.subject, detail: p.data.detail, categoryId: cat.id, channel: from === 'member' ? 'portal' : 'website', requester: { name: p.data.name, email: p.data.email, phone: p.data.phone, memberId: who.memberId }, center: centers.byName.has(p.data.center) ? p.data.center : '', createdBy: { id: '', name: 'Website' }, at: localNow() }, s.helpdesk, admins(ctx) as never);
    await ctx.db.run(API(ctx), saveSql(ctx, t, centers, true));
    if (s.helpdesk.acknowledgement && t.requester.email) await ctx.db.run(PLATFORM, outboxReply(ctx, t, W.fillReply(s.helpdesk.acknowledgement, t, { agent: '', organization: ctx.slug.toUpperCase() })));
    return { status: 201, body: { reference: t.id } };
}

export const HELPDESK_ROUTES: Route[] = [
  route('GET', /^\/admin\/helpdesk\/tickets$/, async (ctx) => {
    need(ctx, 'members.view');
    const [s, centers] = await Promise.all([settings(ctx), centerMap(ctx)]); const v = viewer(ctx, centers); const now = localNow();
    const q = ctx.req.query; const view = q.get('view') ?? 'all'; const cat = q.get('category') ?? ''; const text = (q.get('q') ?? '').toLowerCase();
    const list = ((await rows(ctx.db, API(ctx), `${TICKET_SQL} ORDER BY t.created_at DESC LIMIT 2000`)) as TRow[]).map((r) => toTicket(r, centers)).filter((t) => W.canSeeTicket(t, v, s.helpdesk))
      .filter((t) => (!cat || t.categoryId === cat) && (!text || `${t.id} ${t.subject} ${t.requester.name} ${t.requester.email}`.toLowerCase().includes(text)))
      .filter((t) => view === 'any' ? true : view === 'solved' ? !W.isOpenTicket(t) : view === 'mine' ? W.isOpenTicket(t) && t.assignee === v.id : view === 'unassigned' ? W.isOpenTicket(t) && !t.assignee
        : view === 'late' ? W.isOpenTicket(t) && ['late'].includes(W.activeClock(t, s.helpdesk, now).state) : view === 'waiting' ? W.isOpenTicket(t) && ['waiting', 'hold'].includes(t.status) : W.isOpenTicket(t));
    const full = q.get('full') === '1';   // the admin's screens: every ticket with its thread (they filter and sort themselves)
    const out = list.map((t) => ({ ...t, events: full ? t.events : undefined, clocks: W.ticketClocks(t, s.helpdesk, now) })).sort((a, b) => a.clocks.solve.minutesLeft - b.clocks.solve.minutesLeft);
    return { status: 200, body: { count: out.length, tickets: out } };
  }),
  route('GET', /^\/admin\/helpdesk\/stats$/, async (ctx) => {
    need(ctx, 'members.view');
    const [s, centers] = await Promise.all([settings(ctx), centerMap(ctx)]); const v = viewer(ctx, centers);
    const list = ((await rows(ctx.db, API(ctx), `${TICKET_SQL}`)) as TRow[]).map((r) => toTicket(r, centers)).filter((t) => W.canSeeTicket(t, v, s.helpdesk));
    return { status: 200, body: W.helpdeskStats(list, s.helpdesk, localNow()) };
  }),
  route('GET', /^\/admin\/helpdesk\/tickets\/(T-\d+)$/, async (ctx, mm) => {
    need(ctx, 'members.view');
    const [s, centers] = await Promise.all([settings(ctx), centerMap(ctx)]);
    const t = await loadTicket(ctx, mm[1], centers, s);
    return { status: 200, body: { ticket: t, clocks: W.ticketClocks(t, s.helpdesk, localNow()) } };
  }),
  route('POST', /^\/admin\/helpdesk\/tickets$/, async (ctx) => {
    need(ctx, 'members.view');
    const p = NewTicket.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the ticket.', issues(p.error));
    const [s, centers] = await Promise.all([settings(ctx), centerMap(ctx)]); const b = p.data;
    if (!s.helpdesk.categories.some((c) => c.id === b.categoryId && !c.archived)) throw new HttpError(400, 'Pick a category that is in use.');
    if (b.center && !centers.byName.has(b.center)) throw new HttpError(400, `“${b.center}” is not a masjid.`);
    const role = roleOf(ctx.access, ctx.me);
    if (role?.centerScoped && b.center !== ctx.me!.centers[0]) throw new HttpError(403, `You may create tickets for ${ctx.me!.centers[0]} only.`);
    if (b.assignee && !ctx.access.admins.some((a) => a.id === b.assignee && a.status === 'active')) throw new HttpError(400, 'The owner must be an active admin.');
    const t = W.newTicket({ id: await nextId(ctx), subject: b.subject, detail: b.detail, categoryId: b.categoryId, channel: b.channel, requester: { name: b.name, email: b.email, phone: b.phone, memberId: b.memberId.toUpperCase() }, center: b.center, priority: b.priority, assignee: b.assignee, createdBy: actor(ctx), at: localNow() }, s.helpdesk, admins(ctx) as never);
    await ctx.db.run(API(ctx), saveSql(ctx, t, centers, true));
    await audit(ctx, 'members', 'Ticket created', `${t.id}: ${t.subject}`, t.id);
    return { status: 201, body: { ticket: t } };
  }),
  route('PATCH', /^\/admin\/helpdesk\/tickets\/(T-\d+)$/, async (ctx, mm) => {
    need(ctx, 'members.view');
    const [s, centers] = await Promise.all([settings(ctx), centerMap(ctx)]); let t = await loadTicket(ctx, mm[1], centers, s);
    const P = z.object({ status: z.enum(['new', 'open', 'waiting', 'hold', 'solved', 'closed']).optional(), assignee: z.string().optional(), priority: z.enum(W.PRIORITY_KEYS).optional(), categoryId: z.string().optional(),
      center: z.string().optional(), tags: z.array(z.string().max(30)).max(20).optional(), watchers: z.array(z.string()).max(30).optional(), restricted: z.boolean().optional(), csat: z.object({ score: z.enum(['good', 'bad']), comment: z.string().max(500).default('') }).optional() }).strict();
    const p = P.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the changes.', issues(p.error));
    const b = p.data; const now = localNow(); const me = actor(ctx);
    if (t.mergedInto) throw new HttpError(409, `This ticket was merged into ${t.mergedInto}.`);
    if (b.assignee !== undefined) { if (b.assignee && !ctx.access.admins.some((a) => a.id === b.assignee && a.status === 'active')) throw new HttpError(400, 'The owner must be an active admin.'); t = W.assign(t, b.assignee, ctx.access.admins.find((a) => a.id === b.assignee)?.name ?? '', me, now); }
    if (b.status) t = W.setStatus(t, b.status, me, now);
    if (b.priority && b.priority !== t.priority) t = { ...t, priority: b.priority, events: [...t.events, { id: W.eventId(), at: now, by: me.name, kind: 'priority', text: `Priority: ${W.PRIORITY_LABEL[b.priority]}` }] };
    if (b.categoryId && b.categoryId !== t.categoryId) { const c = s.helpdesk.categories.find((x) => x.id === b.categoryId); if (!c) throw new HttpError(400, 'Unknown category.'); t = { ...t, categoryId: c.id, restricted: t.restricted || c.restricted, events: [...t.events, { id: W.eventId(), at: now, by: me.name, kind: 'category', text: `Category: ${c.label}` }] }; }
    if (b.center !== undefined) { if (b.center && !centers.byName.has(b.center)) throw new HttpError(400, `“${b.center}” is not a masjid.`); if (roleOf(ctx.access, ctx.me)?.centerScoped) throw new HttpError(403, 'Masjid roles cannot move tickets to another masjid.'); t = { ...t, center: b.center }; }
    if (b.tags) t = { ...t, tags: Array.from(new Set(b.tags.map((x) => x.toLowerCase().replace(/[^a-z0-9-]+/g, '-')))) };
    if (b.watchers) t = { ...t, watchers: b.watchers.filter((w) => ctx.access.admins.some((a) => a.id === w)) };
    if (b.restricted !== undefined && b.restricted !== t.restricted) t = { ...t, restricted: b.restricted, events: [...t.events, { id: W.eventId(), at: now, by: me.name, kind: 'status', text: b.restricted ? 'Marked restricted.' : 'No longer restricted.' }] };
    if (b.csat) t = { ...t, csat: { ...b.csat, at: now }, events: [...t.events, { id: W.eventId(), at: now, by: t.requester.name || 'Requester', kind: 'csat', text: `Rated ${b.csat.score === 'good' ? 'Good' : 'Not good'}` }] };
    await persist(ctx, t, centers);
    await audit(ctx, 'members', 'Ticket changed', Object.keys(b).join(', '), t.id);
    return { status: 200, body: { ticket: await loadTicket(ctx, t.id, centers, s) } };
  }),
  route('POST', /^\/admin\/helpdesk\/tickets\/(T-\d+)\/(replies|notes)$/, async (ctx, mm) => {
    need(ctx, 'members.view');
    const [s, centers] = await Promise.all([settings(ctx), centerMap(ctx)]); let t = await loadTicket(ctx, mm[1], centers, s);
    const text = String(body(ctx).text ?? '').trim(); if (!text || text.length > 5000) throw new HttpError(400, 'Write the message (up to 5,000 characters).');
    if (W.unfilledFields(text).length) throw new HttpError(400, `Fill these before sending: ${W.unfilledFields(text).map((x) => `{{${x}}}`).join(', ')}`);
    if (t.mergedInto) throw new HttpError(409, `This ticket was merged into ${t.mergedInto}.`);
    if (mm[2] === 'replies') {
      if (!t.requester.email && !t.requester.phone && t.channel !== 'portal') throw new HttpError(400, 'No email or phone on this ticket – call them and add a note instead.');
      const st = body(ctx).status ? String(body(ctx).status) as W.TicketStatus : undefined;
      if (st && !['waiting', 'solved', 'open', 'hold'].includes(st)) throw new HttpError(400, 'Status after sending: open, waiting, hold or solved.');
      t = W.reply(t, text, actor(ctx), localNow(), st);
      await persist(ctx, t, centers, outboxReply(ctx, t, text));
    } else {
      const before = new Set(t.watchers); t = W.note(t, text, actor(ctx), localNow(), admins(ctx));
      await persist(ctx, t, centers); await noticeMentions(ctx, t, t.watchers.filter((w) => !before.has(w)));
    }
    return { status: 201, body: { ticket: await loadTicket(ctx, t.id, centers, s) } };
  }),
  route('POST', /^\/admin\/helpdesk\/tickets\/(T-\d+)\/requester$/, async (ctx, mm) => {   // the requester answered by phone or at the desk
    need(ctx, 'members.view');
    const [s, centers] = await Promise.all([settings(ctx), centerMap(ctx)]); const t = await loadTicket(ctx, mm[1], centers, s);
    const text = String(body(ctx).text ?? '').trim(); if (!text || text.length > 5000) throw new HttpError(400, 'Write what they said.');
    if (t.mergedInto) throw new HttpError(409, `This ticket was merged into ${t.mergedInto}.`);
    await persist(ctx, W.requesterReply(t, text, localNow()), centers);
    return { status: 201, body: { ticket: await loadTicket(ctx, t.id, centers, s) } };
  }),
  route('POST', /^\/admin\/helpdesk\/tickets\/(T-\d+)\/merge$/, async (ctx, mm) => {
    need(ctx, 'members.view');
    const [s, centers] = await Promise.all([settings(ctx), centerMap(ctx)]);
    const dup = await loadTicket(ctx, mm[1], centers, s); const main = await loadTicket(ctx, String(body(ctx).into ?? ''), centers, s);
    if (!W.isOpenTicket(main)) throw new HttpError(409, 'Merge into an open ticket.');
    const [m, d] = W.merge(main, dup, actor(ctx), localNow());
    await persist(ctx, m, centers); await persist(ctx, d, centers);
    await audit(ctx, 'members', 'Tickets merged', `${d.id} → ${m.id}`, m.id);
    return { status: 200, body: { into: m.id } };
  }),
  route('POST', /^\/admin\/helpdesk\/bulk$/, async (ctx) => {
    need(ctx, 'members.view');
    const P = z.object({ ids: z.array(z.string().regex(/^T-\d+$/)).min(1).max(200), assignee: z.string().optional(), status: z.enum(['open', 'waiting', 'hold', 'solved']).optional(), priority: z.enum(W.PRIORITY_KEYS).optional() });
    const p = P.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the bulk change.', issues(p.error));
    const [s, centers] = await Promise.all([settings(ctx), centerMap(ctx)]); const now = localNow(); const me = actor(ctx); let n = 0;
    if (p.data.assignee && !ctx.access.admins.some((a) => a.id === p.data.assignee && a.status === 'active')) throw new HttpError(400, 'The owner must be an active admin.');
    for (const id of p.data.ids) {
      let t = await loadTicket(ctx, id, centers, s).catch(() => null); if (!t || t.mergedInto) continue;
      if (p.data.assignee !== undefined) t = W.assign(t, p.data.assignee, ctx.access.admins.find((a) => a.id === p.data.assignee)?.name ?? '', me, now);
      if (p.data.status) t = W.setStatus(t, p.data.status, me, now);
      if (p.data.priority) t = { ...t, priority: p.data.priority, events: [...t.events, { id: W.eventId(), at: now, by: me.name, kind: 'priority', text: `Priority: ${W.PRIORITY_LABEL[p.data.priority]}` }] };
      await persist(ctx, t, centers); n++;
    }
    await audit(ctx, 'members', 'Tickets changed in bulk', `${n} tickets`, '');
    return { status: 200, body: { changed: n } };
  }),
  route('POST', /^\/admin\/helpdesk\/tickets\/(T-\d+)\/task$/, async (ctx, mm) => {
    need(ctx, 'members.view');
    const [s, centers] = await Promise.all([settings(ctx), centerMap(ctx)]); const t = await loadTicket(ctx, mm[1], centers, s);
    const owner = String(body(ctx).owner ?? ctx.me!.id); const due = String(body(ctx).due ?? todayCT());
    if (!ctx.access.admins.some((a) => a.id === owner && a.status === 'active')) throw new HttpError(400, 'The task owner must be an active admin.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new HttpError(400, 'Use a due date.');
    const task = W.taskFromTicket(t, { owner, due, by: actor(ctx), at: localNow() });
    await ctx.db.run(API(ctx), [taskInsert(ctx, task)]);
    const t2 = { ...t, links: [...t.links, { kind: 'task' as const, id: task.id, label: task.title }], events: [...t.events, { id: W.eventId(), at: localNow(), by: ctx.me!.name, kind: 'link' as const, text: `Team task created for ${ctx.access.admins.find((a) => a.id === owner)?.name}.` }] };
    await persist(ctx, t2, centers);
    return { status: 201, body: { task } };
  }),
  route('POST', /^\/admin\/helpdesk\/run-jobs$/, async (ctx) => { need(ctx, 'settings.manage'); return { status: 200, body: await runHelpdeskJobs(ctx) }; }),

  /* ---------------- website and portal ---------------- */
  route('POST', /^\/(public|member)\/helpdesk\/tickets$/, (ctx, mm) => fromWebsite(ctx, mm[1] as 'public' | 'member')),
  /* the simple website forms (kind / title / detail; feedback and complaints may be anonymous) – also the v0 alias */
  route('POST', /^\/public\/tickets$/, async (ctx) => {
    const b = body(ctx); const s = await settings(ctx);
    const want: Record<string, string[]> = { complaint: ['complaint', 'facilities', 'other'], feedback: ['feedback', 'other'], request: ['request', 'question', 'membership', 'other'] };
    const open = s.helpdesk.categories.filter((c) => c.onWebsite && !c.archived && !c.restricted);
    const cat = (want[String(b.kind)] ?? want.feedback).map((id) => open.find((c) => c.id === id)).find(Boolean) ?? open[0];
    ctx.req.body = { ...b, subject: b.subject ?? b.title, categoryId: cat?.id ?? '', email: b.anonymous === true ? '' : b.email ?? '' };
    const r = await fromWebsite(ctx, 'public', b.anonymous === true && (b.kind === 'feedback' || b.kind === 'complaint'));
    const ref = (r.body as { reference: string }).reference;
    return r.status === 202 ? { status: 200, body: { ok: true } } : { status: 201, body: { id: ref, reference: ref, message: 'Thank you – the office has it.' } };
  }),
  route('GET', /^\/member\/helpdesk\/tickets$/, async (ctx) => {
    const id = needMember(ctx); const centers = await centerMap(ctx);
    const list = ((await rows(ctx.db, API(ctx), `${TICKET_SQL} WHERE t.member_id = $1 ORDER BY t.created_at DESC`, [id])) as TRow[]).map((r) => W.memberView(toTicket(r, centers)));
    return { status: 200, body: { tickets: list } };
  }),
  route('POST', /^\/member\/helpdesk\/tickets\/(T-\d+)\/reply$/, async (ctx, mm) => {
    const id = needMember(ctx); const centers = await centerMap(ctx);
    const r = await one<TRow>(ctx.db, API(ctx), `${TICKET_SQL} WHERE t.id = $1 AND t.member_id = $2`, [mm[1], id]); if (!r) throw new HttpError(404, 'No such request.');
    const text = String(body(ctx).text ?? '').trim(); if (text.length < 2 || text.length > 5000) throw new HttpError(400, 'Write your answer.');
    const t = W.requesterReply(toTicket(r, centers), text, localNow());
    if (t.status === 'closed') throw new HttpError(409, 'This request is closed – please send a new one.');
    await persist(ctx, t, centers);
    return { status: 201, body: W.memberView(t) };
  }),
];

/** Nightly / every few minutes: close solved tickets after N days, escalate late tickets once. */
export async function runHelpdeskJobs(ctx: Ctx) {
  const [s, centers] = await Promise.all([settings(ctx), centerMap(ctx)]); const now = localNow();
  const closed = (await one<{ n: number }>(ctx.db, API(ctx), 'SELECT app.hd_auto_close($1::int) AS n', [s.helpdesk.autoCloseDays]))!.n;
  const open = ((await rows(ctx.db, API(ctx), `${TICKET_SQL} WHERE t.status NOT IN ('solved', 'closed') AND t.escalated_at IS NULL`)) as TRow[]).map((r) => toTicket(r, centers));
  let escalated = 0;
  for (const t of open) {
    const c = W.ticketClocks(t, s.helpdesk, now); if (c.first.state !== 'late' && c.solve.state !== 'late') continue;
    const cat = s.helpdesk.categories.find((x) => x.id === t.categoryId);
    const to = ctx.access.admins.filter((a) => a.status === 'active' && (a.id === t.assignee || (!!cat?.escalateTo && (a.roleId === cat.escalateTo || a.more?.some((m) => m.roleId === cat.escalateTo)))));
    await ctx.db.run(API(ctx), [
      { sql: `UPDATE app.hd_tickets SET escalated_at = now() WHERE id = $1`, params: [t.id] },
      { sql: `INSERT INTO app.hd_events (org_id, ticket_id, by, kind, text) VALUES ($1::uuid, $2, 'System', 'escalated', $3)`, params: [ctx.orgId, t.id, `Late – told ${to.map((a) => a.name).join(', ') || 'nobody (no owner)'}.`] },
      ...to.map((a) => ({ sql: `INSERT INTO app.notices (org_id, admin_id, kind, title, link) VALUES ($1::uuid, $2, 'escalation', $3, $4)`, params: [ctx.orgId, a.id, `Late: ${t.id} ${t.subject}`, `/queues/tickets?ticket=${t.id}`] })),
    ]);
    escalated++;
  }
  return { closed, escalated };
}

/* ---------------- team tasks ---------------- */
const TASK_SQL = `SELECT t.id, coalesce(t.project_id, '') AS "projectId", coalesce(t.parent_id, '') AS "parentId", t.title, t.notes, t.owner, t.helpers, t.status, t.priority, coalesce(t.start_on::text, '') AS start, coalesce(t.due::text, '') AS due,
  t.labels, t.checklist, CASE WHEN t.repeat_every IS NULL THEN NULL ELSE json_build_object('every', t.repeat_every, 'interval', t.repeat_interval) END AS repeat, t.links,
  coalesce((SELECT json_agg(json_build_object('at', ${L('c.at')}, 'by', c.by, 'text', c.text) ORDER BY c.at) FROM app.task_comments c WHERE c.org_id = t.org_id AND c.task_id = t.id), '[]') AS comments,
  ${L('t.created_at')} AS "createdAt", t.created_by AS "createdBy", ${L('t.done_at')} AS "doneAt", t.sort AS "order" FROM app.tasks t`;
const PROJECT_SQL = `SELECT p.id, p.name, p.color, p.owner, coalesce(c.name, '') AS center, p.visibility, p.members, coalesce(p.due::text, '') AS due, coalesce(p.anchor::text, '') AS anchor, p.template_id AS "templateId", p.archived, ${L('p.created_at')} AS "createdAt", p.description
  FROM app.task_projects p LEFT JOIN app.centers c ON c.org_id = p.org_id AND c.id = p.center_id`;
function taskInsert(ctx: Ctx, t: W.Task): Statement {
  return { sql: `INSERT INTO app.tasks (org_id, id, project_id, parent_id, title, notes, owner, helpers, status, priority, start_on, due, labels, checklist, repeat_every, repeat_interval, links, sort, created_by, done_at)
    VALUES ($1::uuid, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, $7, $8::text[], $9, $10, NULLIF($11, '')::date, NULLIF($12, '')::date, $13::text[], $14::jsonb, NULLIF($15, ''), NULLIF($16, '')::smallint, $17::jsonb, $18::int, $19, ${TS(20)})
    ON CONFLICT (org_id, id) DO UPDATE SET project_id = EXCLUDED.project_id, title = EXCLUDED.title, notes = EXCLUDED.notes, owner = EXCLUDED.owner, helpers = EXCLUDED.helpers, status = EXCLUDED.status, priority = EXCLUDED.priority,
      start_on = EXCLUDED.start_on, due = EXCLUDED.due, labels = EXCLUDED.labels, checklist = EXCLUDED.checklist, repeat_every = EXCLUDED.repeat_every, repeat_interval = EXCLUDED.repeat_interval, links = EXCLUDED.links, sort = EXCLUDED.sort, done_at = EXCLUDED.done_at`,
    params: [ctx.orgId, t.id, t.projectId, t.parentId, t.title, t.notes, t.owner, `{${t.helpers.map((h) => `"${h}"`).join(',')}}`, t.status, t.priority, t.start, t.due, `{${t.labels.map((h) => `"${h}"`).join(',')}}`, JSON.stringify(t.checklist), t.repeat?.every ?? '', t.repeat ? String(t.repeat.interval) : '', JSON.stringify(t.links), t.order, t.createdBy, t.doneAt] };
}
async function taskWorld(ctx: Ctx) {
  const centers = await centerMap(ctx); const v = viewer(ctx, centers);
  const projects = (await rows(ctx.db, API(ctx), PROJECT_SQL)) as unknown as W.Project[];
  const tasks = (await rows(ctx.db, API(ctx), TASK_SQL)) as unknown as W.Task[];
  return { centers, v, projects, tasks, visibleProjects: projects.filter((p) => W.canSeeProject(p, v)), visibleTasks: tasks.filter((t) => W.canSeeTask(t, projects, v)) };
}
const TaskIn = z.object({ title: z.string().trim().min(2).max(200), projectId: z.string().default(''), parentId: z.string().default(''), owner: z.string().optional(), notes: z.string().max(4000).default(''), helpers: z.array(z.string()).max(20).default([]),
  status: z.enum(W.TASK_STATUS_KEYS).default('todo'), priority: z.enum(W.PRIORITY_KEYS).default('normal'), start: z.string().default(''), due: z.string().default(''), labels: z.array(z.string()).max(10).default([]),
  checklist: z.array(z.object({ id: z.string(), text: z.string().max(140), done: z.boolean() })).max(50).default([]), repeat: z.object({ every: z.enum(['week', 'month', 'year']), interval: z.number().int().min(1).max(12) }).nullable().default(null) });
const dateOk = (d: string) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);

export const TASK_ROUTES: Route[] = [
  route('GET', /^\/admin\/tasks$/, async (ctx) => {
    if (!ctx.me) need(ctx, 'members.view');
    const w = await taskWorld(ctx); const q = ctx.req.query; const today = todayCT();
    const list = w.visibleTasks.filter((t) => (!q.get('project') || t.projectId === q.get('project')) && (!q.get('owner') || t.owner === (q.get('owner') === 'me' ? ctx.me!.id : q.get('owner'))) && (!q.get('status') || t.status === q.get('status')));
    return { status: 200, body: { count: list.length, tasks: list.map((t) => ({ ...t, bucket: W.bucketOf(t, today) })) } };
  }),
  route('GET', /^\/admin\/tasks\/projects$/, async (ctx) => {
    if (!ctx.me) need(ctx, 'members.view');
    const w = await taskWorld(ctx); const today = todayCT();
    return { status: 200, body: { projects: w.visibleProjects.map((p) => ({ ...p, progress: W.projectProgress(p, w.tasks, today) })), workload: W.workload(w.visibleTasks, today) } };
  }),
  route('POST', /^\/admin\/tasks$/, async (ctx) => {
    if (!ctx.me) need(ctx, 'members.view');
    const p = TaskIn.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the task.', issues(p.error));
    const b = p.data; if (!dateOk(b.due) || !dateOk(b.start)) throw new HttpError(400, 'Use dates like 2026-11-01.');
    const w = await taskWorld(ctx);
    if (b.projectId && !w.visibleProjects.some((x) => x.id === b.projectId)) throw new HttpError(404, 'No such project.');
    if (b.parentId && !w.visibleTasks.some((x) => x.id === b.parentId)) throw new HttpError(404, 'No such parent task.');
    const owner = b.owner ?? ctx.me!.id; if (!ctx.access.admins.some((a) => a.id === owner && a.status === 'active')) throw new HttpError(400, 'The owner must be an active admin.');
    const want = String(body(ctx).id ?? '');   // the admin's screen may name the new task (so it keeps its place); otherwise a new id
    const id = /^task-[a-z0-9-]{3,40}$/.test(want) && !w.tasks.some((x) => x.id === want) ? want : W.newId('task');
    const t: W.Task = { id, projectId: b.projectId, parentId: b.parentId, title: b.title, notes: b.notes, owner, helpers: b.helpers, status: b.status === 'done' ? 'todo' : b.status, priority: b.priority, start: b.start, due: b.due, labels: b.labels, checklist: b.checklist, repeat: b.repeat, links: [], comments: [], createdAt: localNow(), createdBy: ctx.me!.name, doneAt: '', order: 0 };
    const stmts = [taskInsert(ctx, t)];
    if (b.projectId) stmts.push({ sql: `UPDATE app.task_projects SET members = (SELECT array_agg(DISTINCT m) FROM unnest(members || ARRAY[$2]) m) WHERE id = $1`, params: [b.projectId, owner] });
    await ctx.db.run(API(ctx), stmts);
    return { status: 201, body: { task: t } };
  }),
  route('PATCH', /^\/admin\/tasks\/([a-z0-9-]+)$/, async (ctx, mm) => {
    if (!ctx.me) need(ctx, 'members.view');
    const w = await taskWorld(ctx); const cur = w.visibleTasks.find((t) => t.id === mm[1]); if (!cur) throw new HttpError(404, 'No such task.');
    const p = TaskIn.partial().extend({ order: z.number().int().min(0).max(1_000_000).optional() }).strict().safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the changes.', issues(p.error));
    const b = p.data; if ((b.due && !dateOk(b.due)) || (b.start && !dateOk(b.start))) throw new HttpError(400, 'Use dates like 2026-11-01.');
    if (b.owner && !ctx.access.admins.some((a) => a.id === b.owner && a.status === 'active')) throw new HttpError(400, 'The owner must be an active admin.');
    if (b.status === 'done') throw new HttpError(400, 'Use /done to finish a task (a repeating one makes the next).');
    const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)), doneAt: b.status && cur.status === 'done' ? '' : cur.doneAt } as W.Task;
    await ctx.db.run(API(ctx), [taskInsert(ctx, next), ...(b.owner && b.owner !== cur.owner ? [{ sql: `INSERT INTO app.task_comments (org_id, task_id, by, text) VALUES ($1::uuid, $2, $3, $4)`, params: [ctx.orgId, cur.id, ctx.me!.name, `Owner: ${ctx.access.admins.find((a) => a.id === b.owner)?.name}.`] }] : [])]);
    return { status: 200, body: { task: next } };
  }),
  route('POST', /^\/admin\/tasks\/([a-z0-9-]+)\/(done|reopen)$/, async (ctx, mm) => {
    if (!ctx.me) need(ctx, 'members.view');
    const w = await taskWorld(ctx); if (!w.visibleTasks.some((t) => t.id === mm[1])) throw new HttpError(404, 'No such task.');
    const list = mm[2] === 'done' ? W.completeTask(w.tasks, mm[1], actor(ctx), localNow()) : W.reopenTask(w.tasks, mm[1]);
    const changed = list.filter((t) => { const o = w.tasks.find((x) => x.id === t.id); return !o || o.status !== t.status; });
    await ctx.db.run(API(ctx), [...changed.map((t) => taskInsert(ctx, t)), ...(mm[2] === 'done' ? [{ sql: `INSERT INTO app.task_comments (org_id, task_id, by, text) VALUES ($1::uuid, $2, $3, 'Marked done.')`, params: [ctx.orgId, mm[1], ctx.me!.name] }] : [])]);
    const created = changed.find((t) => !w.tasks.some((x) => x.id === t.id));
    // a task made from a ticket leaves a note on the ticket when it is done
    const linked = w.tasks.find((t) => t.id === mm[1])?.links.find((l) => l.kind === 'ticket');
    if (mm[2] === 'done' && linked) await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.hd_events (org_id, ticket_id, by, kind, text) SELECT $1::uuid, $2, $3, 'note', $4 WHERE EXISTS (SELECT 1 FROM app.hd_tickets WHERE id = $2)`, params: [ctx.orgId, linked.id, ctx.me!.name, `Team task done: ${w.tasks.find((t) => t.id === mm[1])?.title}`] }]);
    return { status: 200, body: { status: mm[2] === 'done' ? 'done' : 'todo', next: created ?? null } };
  }),
  route('POST', /^\/admin\/tasks\/([a-z0-9-]+)\/comments$/, async (ctx, mm) => {
    if (!ctx.me) need(ctx, 'members.view');
    const w = await taskWorld(ctx); const t = w.visibleTasks.find((x) => x.id === mm[1]); if (!t) throw new HttpError(404, 'No such task.');
    const text = String(body(ctx).text ?? '').trim(); if (!text || text.length > 4000) throw new HttpError(400, 'Write the comment.');
    const mentions = W.mentionsIn(text, admins(ctx)).filter((m) => m !== t.owner && !t.helpers.includes(m));
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.task_comments (org_id, task_id, by, text) VALUES ($1::uuid, $2, $3, $4)`, params: [ctx.orgId, t.id, ctx.me!.name, text] },
      ...(mentions.length ? [{ sql: `UPDATE app.tasks SET helpers = helpers || $2::text[] WHERE id = $1`, params: [t.id, `{${mentions.map((m) => `"${m}"`).join(',')}}`] }] : []),
      ...mentions.map((a) => ({ sql: `INSERT INTO app.notices (org_id, admin_id, kind, title, link) VALUES ($1::uuid, $2, 'mention', $3, $4)`, params: [ctx.orgId, a, `${ctx.me!.name} mentioned you: ${t.title}`, `/tasks?task=${t.id}`] }))]);
    return { status: 201, body: { helpersAdded: mentions } };
  }),
  route('DELETE', /^\/admin\/tasks\/([a-z0-9-]+)$/, async (ctx, mm) => {
    if (!ctx.me) need(ctx, 'members.view');
    const w = await taskWorld(ctx); const t = w.visibleTasks.find((x) => x.id === mm[1]); if (!t) throw new HttpError(404, 'No such task.');
    if (t.createdBy !== ctx.me!.name && t.owner !== ctx.me!.id && !ctx.access.roles.find((r) => r.id === roleOf(ctx.access, ctx.me)?.id)?.permissions.includes('admins.manage')) throw new HttpError(403, 'Only the person who made it, its owner or an admin manager may delete a task.');
    await ctx.db.run(API(ctx), [{ sql: 'DELETE FROM app.tasks WHERE id = $1', params: [t.id] }]);
    await audit(ctx, 'members', 'Task deleted', t.title, t.id);
    return { status: 200, body: { deleted: t.id } };
  }),
  route('POST', /^\/admin\/tasks\/projects(\/from-template)?$/, async (ctx, mm) => {
    if (!ctx.me) need(ctx, 'members.view');
    const b = body(ctx); const centers = await centerMap(ctx); const center = String(b.center ?? '');
    if (center && !centers.byName.has(center)) throw new HttpError(400, `“${center}” is not a masjid.`);
    const role = roleOf(ctx.access, ctx.me); if (role?.centerScoped && center !== ctx.me!.centers[0]) throw new HttpError(403, `Your projects belong to ${ctx.me!.centers[0]}.`);
    const visibility = (['members', 'masjid', 'organization'].includes(String(b.visibility)) ? String(b.visibility) : center ? 'masjid' : 'organization') as W.Project['visibility'];
    if (visibility === 'masjid' && !center) throw new HttpError(400, 'A masjid-wide project needs its masjid.');
    let project: W.Project; let tasks: W.Task[] = [];
    if (mm[1]) {
      const s = await settings(ctx); const tpl = s.tasks.templates.find((x) => x.id === b.templateId); if (!tpl) throw new HttpError(400, 'Pick a template.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.anchor ?? ''))) throw new HttpError(400, `Give the ${tpl.anchorLabel.toLowerCase()} as a date.`);
      ({ project, tasks } = W.projectFromTemplate(tpl, { name: String(b.name ?? '').trim() || tpl.name, anchor: String(b.anchor), owner: ctx.me!.id, center, by: actor(ctx), at: localNow(), visibility }, admins(ctx) as never));
    } else {
      const name = String(b.name ?? '').trim(); if (name.length < 2 || name.length > 120) throw new HttpError(400, 'Give the project a name.');
      const want = String(b.id ?? ''); const known = (await rows(ctx.db, API(ctx), 'SELECT id FROM app.task_projects WHERE id = $1', [want])).length > 0;
      project = { id: /^prj-[a-z0-9-]{3,40}$/.test(want) && !known ? want : W.newId('prj'), name, color: (['green', 'blue', 'amber', 'red', 'violet', 'gray'].includes(String(b.color)) ? b.color : 'green') as W.Project['color'], owner: ctx.me!.id, center, visibility, members: [ctx.me!.id], due: dateOk(String(b.due ?? '')) ? String(b.due ?? '') : '', anchor: '', templateId: '', archived: false, createdAt: localNow(), description: String(b.description ?? '').slice(0, 300) };
    }
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.task_projects (org_id, id, name, color, owner, center_id, visibility, members, due, anchor, template_id, description) VALUES ($1::uuid, $2, $3, $4, $5, NULLIF($6, '')::uuid, $7, $8::text[], NULLIF($9, '')::date, NULLIF($10, '')::date, $11, $12)`,
      params: [ctx.orgId, project.id, project.name, project.color, project.owner, centers.byName.get(center)?.id ?? '', project.visibility, `{${project.members.map((m) => `"${m}"`).join(',')}}`, project.due, project.anchor, project.templateId, project.description] }, ...tasks.map((t) => taskInsert(ctx, t))]);
    await audit(ctx, 'members', mm[1] ? 'Project created from a template' : 'Project created', project.name, project.id);
    return { status: 201, body: { project, tasks: tasks.length } };
  }),
  route('PATCH', /^\/admin\/tasks\/projects\/([a-z0-9-]+)$/, async (ctx, mm) => {
    if (!ctx.me) need(ctx, 'members.view');
    const w = await taskWorld(ctx); const p = w.visibleProjects.find((x) => x.id === mm[1]); if (!p) throw new HttpError(404, 'No such project.');
    if (p.owner !== ctx.me!.id && !(roleOf(ctx.access, ctx.me)?.permissions.includes('admins.manage'))) throw new HttpError(403, 'Only the project owner changes the project.');
    const b = body(ctx);
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.task_projects SET name = coalesce(NULLIF($2, ''), name), archived = coalesce(NULLIF($3, '')::boolean, archived), due = CASE WHEN $4 = '-' THEN due ELSE NULLIF($4, '')::date END WHERE id = $1`,
      params: [p.id, String(b.name ?? '').slice(0, 120), b.archived === undefined ? '' : String(!!b.archived), b.due === undefined ? '-' : String(b.due)] }]);
    return { status: 200, body: { ok: true } };
  }),
];
