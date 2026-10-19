/**
 * C5 The member portal's own pages: family tree and the member directory.
 *   GET  /member/family · PUT /member/family {family}   the member's tree (heritage names stay private to the member).
 *        Links to other members' records are kept only where the server made them – a member cannot link someone by typing
 *        an ID (that would show another person's status).
 *   GET  /admin/members/:id/family                     the membership layer only (no heritage), members.view + scope
 *   GET  /member/directory · PUT /member/directory {listed}   members who chose to be listed; what shows comes from
 *        Admin › Settings › Configuration (directoryCard). GET /public/directory when the directory is public (no contacts).
 *   GET  /admin/queues/state · PUT /admin/queues/state/:caseId {decision?|null, assignee?}   the work queues' decisions and
 *        who took which case, shared by the whole office (members.view; the member changes themselves use their own routes)
 */
import { z } from 'zod';
import { one, rows } from '../db/sql.js';
import { HttpError, audit, document, need, needMember, route, type Ctx, type Route } from '../http/core.js';
import { inScope } from '@/lib/community/access';
import { OrgConfigSchema, mockOrgConfig } from '@/lib/community/org-config';
import { directoryCard, type DirectoryPerson } from '@/lib/community/member-records';
import type { Family } from '@/lib/family/family';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const Y = z.string().regex(/^\d{4}(-\d{2}-\d{2})?$/);
const PersonIn = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), first: z.string().trim().max(60), last: z.string().trim().max(60), sex: z.enum(['m', 'f']),
  born: Y.optional(), died: Y.optional(), place: z.string().max(100).optional(), heritage: z.boolean().optional(), invited: z.string().max(30).optional(), placeholder: z.boolean().optional(),
  member: z.object({ memberId: z.string(), status: z.enum(['active', 'life', 'expired', 'pending']), canVote: z.boolean(), accepted: z.boolean() }).optional(),
});
const FamilyIn = z.object({ rootId: z.string(), people: z.array(PersonIn).min(1).max(300), unions: z.array(z.object({ id: z.string().max(40), a: z.string(), b: z.string().optional(), children: z.array(z.string()).max(30) })).max(200) })
  .superRefine((f, ctx) => {
    const ids = new Set(f.people.map((p) => p.id));
    if (ids.size !== f.people.length) ctx.addIssue({ code: 'custom', path: ['people'], message: 'Two people have the same id.' });
    if (!ids.has(f.rootId)) ctx.addIssue({ code: 'custom', path: ['rootId'], message: 'The tree needs you in it.' });
    f.unions.forEach((u, i) => { if (![u.a, u.b, ...u.children].filter(Boolean).every((x) => ids.has(x!))) ctx.addIssue({ code: 'custom', path: ['unions', i], message: 'A family link points to someone not in the tree.' }); });
  });

async function me(ctx: Ctx) {
  const id = needMember(ctx);
  const m = await one<{ id: string; first_name: string; last_name: string; gender: string; dob: string | null; status: string }>(ctx.db, API(ctx), 'SELECT id, first_name, last_name, gender, dob::text, status FROM app.members WHERE id = $1 AND archived IS NULL', [id]);
  if (!m) throw new HttpError(404, 'Your record is not available.');
  return m;
}
const starter = (m: Awaited<ReturnType<typeof me>>): Family => ({ rootId: 'me', unions: [], people: [{ id: 'me', first: m.first_name, last: m.last_name, sex: m.gender === 'female' ? 'f' : 'm', born: m.dob ?? undefined, member: { memberId: m.id, status: (['active', 'life', 'expired', 'pending'].includes(m.status) ? m.status : 'pending') as 'active', canVote: false, accepted: true } }] });
async function saved(ctx: Ctx, memberId: string): Promise<Family | null> { return (await one<{ family: Family }>(ctx.db, API(ctx), 'SELECT family FROM app.member_families WHERE member_id = $1', [memberId]))?.family ?? null; }
async function config(ctx: Ctx) { const p = OrgConfigSchema.safeParse(await document(ctx.db, ctx.orgId, 'org-config')); return p.success ? p.data : mockOrgConfig; }
async function people(ctx: Ctx): Promise<DirectoryPerson[]> {
  const list = (await rows(ctx.db, API(ctx), `SELECT first_name, last_name, center, phone, email, extra, coalesce((prefs->>'directoryListed')::boolean, false) AS listed FROM app.members WHERE archived IS NULL AND status IN ('active', 'life') ORDER BY last_name, first_name`)) as { first_name: string; last_name: string; center: string; phone: string; email: string; extra: Record<string, unknown> | null; listed: boolean }[];
  return list.map((r) => ({ name: `${r.first_name} ${r.last_name}`, center: r.center, phone: r.phone, email: r.email, listed: r.listed, values: (r.extra ?? {}) as DirectoryPerson['values'] }));
}

const Decision = z.object({ state: z.enum(['done', 'ready', 'needs-info']), outcome: z.string().max(200), note: z.string().max(1000).optional(), by: z.string().max(80), at: z.string().max(40) });

export const MEMBER_EXTRA_ROUTES: Route[] = [
  route('GET', /^\/admin\/queues\/state$/, async (ctx) => {
    need(ctx, 'members.view');
    const list = (await rows(ctx.db, API(ctx), 'SELECT case_id, decision, assignee FROM app.queue_state')) as { case_id: string; decision: unknown; assignee: string }[];
    return { status: 200, body: { decisions: Object.fromEntries(list.filter((r) => r.decision).map((r) => [r.case_id, r.decision])), assignee: Object.fromEntries(list.filter((r) => r.assignee).map((r) => [r.case_id, r.assignee])) } };
  }),
  route('PUT', /^\/admin\/queues\/state\/([a-z]+-[A-Za-z0-9:._-]{2,80})$/, async (ctx, mm) => {
    need(ctx, 'members.view');
    const b = (ctx.req.body ?? {}) as { decision?: unknown; assignee?: unknown };
    const d = b.decision === null ? null : b.decision === undefined ? undefined : Decision.safeParse(b.decision);
    if (d && !d.success) throw new HttpError(422, 'Check the decision.');
    const assignee = typeof b.assignee === 'string' ? b.assignee : undefined;
    if (assignee && !ctx.access.admins.some((a) => a.id === assignee && a.status === 'active')) throw new HttpError(400, 'Assign to an active admin.');
    const dec = d === null ? null : d ? { ...d.data, by: ctx.me!.name } : undefined;   // the server knows who decided
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.queue_state (org_id, case_id, decision, assignee, updated_by) VALUES ($1::uuid, $2, NULLIF($3, '')::jsonb, $4, $5)
        ON CONFLICT (org_id, case_id) DO UPDATE SET decision = CASE WHEN $6::boolean THEN EXCLUDED.decision ELSE app.queue_state.decision END,
          assignee = CASE WHEN $7::boolean THEN EXCLUDED.assignee ELSE app.queue_state.assignee END, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      params: [ctx.orgId, mm[1], dec ? JSON.stringify(dec) : '', assignee ?? '', ctx.me!.name, dec !== undefined, assignee !== undefined] }]);
    if (dec) await audit(ctx, 'members', `Queue: ${dec.outcome}`, dec.note ?? '', mm[1]);
    return { status: 200, body: { caseId: mm[1], decision: dec ?? null, assignee: assignee ?? null } };
  }),

  route('GET', /^\/member\/family$/, async (ctx) => {
    const m = await me(ctx);
    return { status: 200, body: { family: (await saved(ctx, m.id)) ?? starter(m) } };
  }),
  route('PUT', /^\/member\/family$/, async (ctx) => {
    const m = await me(ctx);
    const raw = ((ctx.req.body ?? {}) as { family?: unknown }).family;
    const p = FamilyIn.safeParse(raw); if (!p.success) throw new HttpError(422, p.error.issues[0].message, p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const before = (await saved(ctx, m.id)) ?? starter(m);
    const knownLinks = new Map(before.people.filter((x) => x.member).map((x) => [x.id, x.member!]));
    const family: Family = { ...p.data, people: p.data.people.map((x) => {
      const keep = knownLinks.get(x.id);   // only links the server made before; never a typed-in member ID
      const { member: _drop, ...rest } = x;
      return x.id === p.data.rootId ? { ...rest, member: starter(m).people[0].member } : keep ? { ...rest, member: keep } : rest;
    }) };
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.member_families (org_id, member_id, family) VALUES ($1::uuid, $2, $3::jsonb) ON CONFLICT (org_id, member_id) DO UPDATE SET family = EXCLUDED.family, updated_at = now()`, params: [ctx.orgId, m.id, JSON.stringify(family)] }]);
    return { status: 200, body: { family } };
  }),
  route('GET', /^\/admin\/members\/([A-Za-z0-9-]+)\/family$/, async (ctx, mm) => {
    need(ctx, 'members.view');
    const m = await one<{ id: string; zone: string; center: string; zip: string }>(ctx.db, API(ctx), 'SELECT id, zone, center, zip FROM app.members WHERE id = $1', [mm[1].toUpperCase()]);
    if (!m) throw new HttpError(404, `No member ${mm[1]}.`);
    if (!inScope(ctx.access, ctx.me, m.zone, m.center, m.zip)) throw new HttpError(403, 'This member is outside your masjid or zone.');
    const f = await saved(ctx, m.id);
    const people = (f?.people ?? []).filter((x) => !x.heritage && !x.placeholder).map((x) => ({ id: x.id, first: x.first, last: x.last, sex: x.sex, born: x.born?.slice(0, 4), member: x.member }));
    const ids = new Set(people.map((x) => x.id));
    return { status: 200, body: { family: f ? { rootId: f.rootId, people, unions: f.unions.filter((u) => ids.has(u.a) || (u.b && ids.has(u.b))).map((u) => ({ ...u, children: u.children.filter((c) => ids.has(c)) })) } : null } };
  }),

  route('GET', /^\/(member|public)\/directory$/, async (ctx, mm) => {
    if (mm[1] === 'member') needMember(ctx);
    const cfg = await config(ctx);
    if (!cfg.members.directory.enabled) throw new HttpError(404, 'There is no member directory.');
    const viewer = mm[1] === 'member' ? 'member' : 'public';
    const cards = (await people(ctx)).map((p) => directoryCard(cfg, p, viewer)).filter(Boolean);
    const mine = mm[1] === 'member' ? (await one<{ listed: boolean }>(ctx.db, API(ctx), `SELECT coalesce((prefs->>'directoryListed')::boolean, false) AS listed FROM app.members WHERE id = $1`, [ctx.memberId]))?.listed ?? false : undefined;
    return { status: 200, body: { people: cards, listed: mine, optIn: cfg.members.directory.optIn } };
  }),
  route('PUT', /^\/member\/directory$/, async (ctx) => {
    const id = needMember(ctx); const listed = ((ctx.req.body ?? {}) as { listed?: unknown }).listed === true;
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET prefs = coalesce(prefs, '{}'::jsonb) || jsonb_build_object('directoryListed', $2::boolean) WHERE id = $1`, params: [id, listed] }]);
    await audit(ctx, 'members', listed ? 'Listed in the directory' : 'Left the directory', '', id);
    return { status: 200, body: { listed } };
  }),
];
