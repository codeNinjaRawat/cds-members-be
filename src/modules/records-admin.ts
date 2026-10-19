/**
 * C4g Meetings and minutes, member benefit uses – what the admin's Minutes and Benefits screens keep.
 *   GET  /admin/meetings                     every meeting the admin may see (masjid roles: their masjid's council and the
 *                                            organization-wide bodies' published minutes)
 *   PUT  /admin/meetings/:id {meeting}       save one meeting (MeetingSchema: quorum, votes, approval date); new ids are
 *                                            numbered by the server (MTG-<year>-<n>) – center.content, masjid roles their own only
 *   GET  /member/minutes                     approved minutes members may read (audience members or public)
 *   GET  /admin/benefits/uses · POST /admin/benefits/uses {offerId, memberId, via?}   the use log (benefits.manage)
 */
import { one, rows } from '../db/sql.js';
import { HttpError, audit, document, need, needMember, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { can, roleOf } from '@/lib/community/access';
import { MeetingSchema, meetingTitle, type Meeting } from '@/lib/community/minutes';
import { BenefitsSchema, mockBenefits } from '@/lib/community/benefits';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const masjidOnly = (ctx: Ctx) => !!roleOf(ctx.access, ctx.me)?.centerScoped;
const mineOrOrg = (ctx: Ctx, m: Meeting) => !masjidOnly(ctx) || (m.body === 'council' ? (ctx.me?.centers ?? []).includes(m.center) : m.status !== 'draft');

async function allMeetings(ctx: Ctx): Promise<Meeting[]> {
  return ((await rows(ctx.db, API(ctx), `SELECT spec FROM app.meetings WHERE spec <> '{}'::jsonb ORDER BY held_on DESC, id DESC`)) as { spec: Meeting }[]).map((r) => r.spec);
}

export const RECORD_ROUTES: Route[] = [
  route('GET', /^\/admin\/meetings$/, async (ctx) => {
    need(ctx, 'members.view');
    return { status: 200, body: { meetings: (await allMeetings(ctx)).filter((m) => mineOrOrg(ctx, m)) } };
  }),
  route('PUT', /^\/admin\/meetings\/([A-Za-z0-9-]{3,40})$/, async (ctx, mm) => {
    need(ctx, 'center.content');
    const p = MeetingSchema.safeParse((body(ctx).meeting ?? body(ctx)));
    if (!p.success) throw new HttpError(422, p.error.issues[0].message, p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    let m = p.data;
    if (masjidOnly(ctx) && (m.body !== 'council' || !(ctx.me?.centers ?? []).includes(m.center))) throw new HttpError(403, `You keep the minutes of ${ctx.me?.centers[0] ?? 'your masjid'} only.`);
    const known = await one<{ id: string; spec: Meeting }>(ctx.db, API(ctx), 'SELECT id, spec FROM app.meetings WHERE id = $1', [mm[1]]);
    if (!known) {   // a new meeting: the server's number
      const year = m.date.slice(0, 4);
      const n = (await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, $2, 1)::text AS n`, [ctx.orgId, `meeting-${year}`]))!.n;
      m = { ...m, id: `MTG-${year}-${n.padStart(3, '0')}` };
    } else if (masjidOnly(ctx) && !mineOrOrg(ctx, known.spec)) throw new HttpError(403, 'Not your masjid’s meeting.');
    if (known?.spec.status === 'published' && m.status === 'draft') throw new HttpError(409, 'Published minutes are not taken back to a draft – add a correction instead.');
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.meetings (org_id, id, body, center_id, title, held_on, quorum, attendees, notes, decisions, status, audience, approved_on, spec, updated_by, updated_at)
        VALUES ($1::uuid, $2, $3, (SELECT id FROM app.centers WHERE name = $4), $5, $6::date, NULL, $7::int, $8, $9::jsonb, $10, $11, NULLIF($12, '')::date, $13::jsonb, $14, now())
        ON CONFLICT (org_id, id) DO UPDATE SET body = EXCLUDED.body, center_id = EXCLUDED.center_id, title = EXCLUDED.title, held_on = EXCLUDED.held_on, attendees = EXCLUDED.attendees, notes = EXCLUDED.notes,
          decisions = EXCLUDED.decisions, status = EXCLUDED.status, audience = EXCLUDED.audience, approved_on = EXCLUDED.approved_on, spec = EXCLUDED.spec, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      params: [ctx.orgId, m.id, m.body, m.center, meetingTitle(m), m.date, m.present, m.notes, JSON.stringify(m.decisions), m.status, m.audience === 'leaders' ? 'leaders' : 'members', m.approvedOn, JSON.stringify(m), ctx.me!.name] }]);
    await audit(ctx, 'minutes', known ? 'Meeting changed' : 'Meeting recorded', `${meetingTitle(m)} ${m.date} (${m.status})`, m.id);
    return { status: known ? 200 : 201, body: { meeting: m } };
  }),
  route('GET', /^\/member\/minutes$/, async (ctx) => {
    needMember(ctx);
    const list = (await allMeetings(ctx)).filter((m) => m.status !== 'draft' && m.audience !== 'leaders');
    return { status: 200, body: { meetings: list.map((m) => ({ ...m, attendees: [], notes: m.notes })) } };
  }),

  route('GET', /^\/admin\/benefits\/uses$/, async (ctx) => {
    need(ctx, 'benefits.manage');
    const list = await rows(ctx.db, API(ctx), `SELECT id, at::text AS at, offer_id AS "offerId", member_id AS "memberId", center, via FROM app.benefit_redemptions ORDER BY at DESC LIMIT 5000`);
    return { status: 200, body: { uses: list } };
  }),
  route('POST', /^\/admin\/benefits\/uses$/, async (ctx) => {
    need(ctx, 'benefits.manage');
    const b = body(ctx); const offerId = String(b.offerId ?? ''); const memberId = String(b.memberId ?? '').toUpperCase(); const via = ['portal', 'partner', 'office'].includes(String(b.via)) ? String(b.via) : 'office';
    const doc = BenefitsSchema.safeParse(await document(ctx.db, ctx.orgId, 'benefits')); const offers = (doc.success ? doc.data : mockBenefits).offers;
    if (!offers.some((o) => o.id === offerId)) throw new HttpError(422, 'Pick one of the offers.');
    const m = await one<{ id: string; center: string; status: string }>(ctx.db, API(ctx), 'SELECT id, center, status FROM app.members WHERE id = $1 AND archived IS NULL', [memberId]);
    if (!m) throw new HttpError(404, `No member ${memberId}.`);
    if (!['active', 'life'].includes(m.status)) throw new HttpError(409, 'Benefits are for current members.');
    const id = `R-${(await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, 'redemption', 5001)::text AS n`, [ctx.orgId]))!.n}`;
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.benefit_redemptions (org_id, id, offer_id, member_id, center, via, by_name) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`, params: [ctx.orgId, id, offerId, m.id, m.center, via, ctx.me!.name] }]);
    await audit(ctx, 'benefits', 'Benefit used', `${offerId} · ${m.id}`, id);
    return { status: 201, body: { use: { id, at: new Date().toISOString(), offerId, memberId: m.id, center: m.center, via } } };
  }),
];
void can; void todayCT;
