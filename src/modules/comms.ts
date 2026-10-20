/**
 * B4f Groups and communication. Rules: web/src/lib/community/groups.ts (automatic groups, join policies, page access),
 * campaigns.ts (audience, preferences, text-message parts, quiet hours, checks, the final text) and communication.ts
 * (sender, footer, templates, merge fields). Groups and the sending settings are documents; people, messages and
 * deliveries are rows. Everything that goes out is queued in platform.outbox (the provider worker sends it – B5).
 *
 * Groups (members.view to see; groups.manage to change)
 *   GET  /admin/groups                         every group with its size, rule warnings and where it is used
 *   GET  /admin/groups/:id/members              who is in it (masjid scope)
 *   POST /admin/groups/:id/members {add?, remove?}   manual groups
 *   GET  /admin/groups/requests · POST /admin/groups/:id/requests/:memberId {decision: approve | decline}
 *   POST /admin/groups/refresh                  recompute automatic groups now (the nightly job does it too)
 *   GET  /member/groups · POST /member/groups/:id/(join|leave|request) · POST /member/groups/:id/message (leaders)
 * Preferences
 *   GET/PUT /member/preferences {email, sms, optOut[]} · GET /public/unsubscribe/:token · POST /public/unsubscribe {token, topic?}
 * Bulk messages (comms.send; masjid roles reach their masjid's members only)
 *   GET  /admin/messages[?full=1] · POST /admin/messages (draft) · PUT /admin/messages/:id
 *   POST /admin/messages/:id/preview            recipients, who is skipped and why, problems, the exact text for one person
 *   POST /admin/messages/:id/send               now, or scheduled when sendAt is in the future · POST /admin/messages/:id/cancel
 *   POST /admin/messages/run-jobs               scheduled sends + automatic groups (the job runner calls runCommsJobs)
 */
import { z } from 'zod';
import { one, rows, type Statement } from '../db/sql.js';
import { HttpError, PLATFORM, audit, document, need, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { saveDocument } from './projections.js';
import { MEMBER_SQL, toMember, type MemberRow } from './member-shape.js';
import { localNow } from './helpdesk.js';
import { signLink } from '../auth/crypto.js';
import { can, inScope, roleOf } from '@/lib/community/access';
import * as G from '@/lib/community/groups';
import * as C from '@/lib/community/campaigns';
import { CommunicationSchema, mockCommunication, type CommunicationDoc, type MacroKey } from '@/lib/community/communication';
import { MembershipSettingsSchema, mockMembershipSettings } from '@/lib/content/membership';
import { ageOn, eligibility, lastPayment, renewalOf, statusOf, type Member } from '@/lib/members/members';
import { siteOf } from './join-drafts.js';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
const has = (ctx: Ctx, p: Parameters<typeof need>[1]) => !!ctx.me && can(ctx.access, ctx.me, p, todayCT());
const scoped = (ctx: Ctx) => { const r = roleOf(ctx.access, ctx.me); return !!(r?.centerScoped || r?.zoneScoped || r?.areaScoped); };
const nowMin = () => localNow().slice(0, 16);

async function groupsDoc(ctx: Ctx): Promise<G.GroupsDoc> { const p = G.GroupsSchema.safeParse(await document(ctx.db, ctx.orgId, 'groups')); return p.success ? p.data : G.mockGroups; }
async function commDoc(ctx: Ctx): Promise<CommunicationDoc> { const p = CommunicationSchema.safeParse(await document(ctx.db, ctx.orgId, 'communication')); return p.success ? p.data : mockCommunication; }
async function saveGroups(ctx: Ctx, doc: G.GroupsDoc, note: string) { const p = G.GroupsSchema.safeParse(doc); if (!p.success) throw new HttpError(422, p.error.issues[0].message, issues(p.error)); await saveDocument(ctx.db, ctx.orgId, 'groups', p.data, ctx.me?.name ?? `Member ${ctx.memberId}`, note); }

/* ---------------- people as the rules see them ---------------- */
type Person = C.Recipient & { member: Member };
async function people(ctx: Ctx, where = '', params: unknown[] = []): Promise<Person[]> {
  const [raw, zones, ms, consent] = await Promise.all([
    rows(ctx.db, API(ctx), `${MEMBER_SQL} ${where}`, params) as Promise<MemberRow[]>,
    rows(ctx.db, API(ctx), 'SELECT code, name FROM app.zones') as Promise<{ code: string; name: string }[]>,
    document(ctx.db, ctx.orgId, 'membership-settings').then((d) => { const p = MembershipSettingsSchema.safeParse(d); return p.success ? p.data : mockMembershipSettings; }),
    rows(ctx.db, API(ctx), `SELECT DISTINCT ON (member_id) member_id, given FROM app.consents WHERE kind = 'sms' AND member_id IS NOT NULL ORDER BY member_id, at DESC`) as Promise<{ member_id: string; given: boolean }[]>,
  ]);
  const zn = new Map(zones.map((z) => [z.code, z.name])); const sms = new Map(consent.map((c) => [c.member_id, c.given])); const today = todayCT(); const year = Number(today.slice(0, 4));
  return raw.map(toMember).map((m) => {
    const prefs: C.Prefs = { email: true, sms: false, optOut: [], ...(m.prefs ?? {}) }; prefs.sms = sms.get(m.id) === true && (m.prefs ? !!m.prefs.sms : true);   // texts only with a consent on file
    const facts: G.Facts = { id: m.id, zone: zn.get(m.zone) ?? m.zone, center: m.center, plan: ms.plans.find((p) => p.id === m.plan)?.name ?? m.plan, status: m.archived ? 'archived' : statusOf(m),
      voting: eligibility(m, year, ms.plans, ms.rules).eligible ? 'yes' : 'no', payment: lastPayment(m)?.method ?? 'none', age: m.dob ? ageOn(m.dob, today) : 0, joinedYear: m.joined,
      renewal: m.archived ? 'archived' : renewalOf(m, today, ms.plans, ms.lifecycle).status };
    return { id: m.id, name: `${m.first} ${m.last}`, email: m.email, phone: m.phone, archived: !!m.archived, prefs, facts, member: m };
  });
}
const visible = (ctx: Ctx, p: Person) => !scoped(ctx) || inScope(ctx.access, ctx.me, p.member.zone, p.member.center, p.member.zip);

/** Automatic groups → app.group_members (how = 'rule'), so events and pages can check access in SQL. */
export async function refreshAutomatic(ctx: Ctx) {
  const doc = await groupsDoc(ctx); const all = await people(ctx, 'WHERE m.archived IS NULL');
  const stmts: Statement[] = [];
  for (const g of doc.groups.filter((x) => x.kind === 'automatic')) {
    const ids = G.membersOf(g, all.map((p) => p.facts)).map((f) => f.id);
    stmts.push({ sql: `DELETE FROM app.group_members WHERE group_id = $1 AND how = 'rule' AND member_id <> ALL(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, params: [g.id, JSON.stringify(ids)] },
      { sql: `INSERT INTO app.group_members (org_id, group_id, member_id, how, status) SELECT $1::uuid, $2, x, 'rule', 'in' FROM jsonb_array_elements_text($3::jsonb) x WHERE EXISTS (SELECT 1 FROM app.groups g WHERE g.id = $2) ON CONFLICT DO NOTHING`, params: [ctx.orgId, g.id, JSON.stringify(ids)] });
  }
  if (stmts.length) await ctx.db.run(API(ctx), stmts);
  return { groups: stmts.length / 2 };
}

/* ---------------- unsubscribe links ---------------- */
export const unsubscribeToken = (orgId: string, address: string) => { const a = Buffer.from(address.toLowerCase()).toString('base64url'); return `${a}.${signLink(`${orgId}|${a}`)}`; };
function readToken(orgId: string, token: string) { const [a, sig] = token.split('.'); if (!a || !sig || signLink(`${orgId}|${a}`) !== sig) throw new HttpError(404, 'This link does not work.'); return Buffer.from(a, 'base64url').toString('utf8'); }
const siteBase = siteOf;
async function orgValues(ctx: Ctx) {
  const o = await one<{ name: string; short_name: string }>(ctx.db, PLATFORM, 'SELECT name, short_name FROM platform.organizations WHERE id = $1', [ctx.orgId]);
  return { 'Org.Name': o?.name ?? ctx.slug, 'Org.ShortName': o?.short_name || ctx.slug.toUpperCase() } as Partial<Record<MacroKey, string>>;
}
async function valuesFor(ctx: Ctx, p: Person, channel: 'email' | 'sms', org: Partial<Record<MacroKey, string>>, site: string): Promise<Partial<Record<MacroKey, string>>> {
  const addr = channel === 'email' ? p.email ?? '' : p.phone ?? '';
  return { ...org, 'Member.FirstName': p.member.first, 'Member.LastName': p.member.last, 'Member.Id': p.id, 'Member.Center': p.member.center, 'Member.Zone': p.facts.zone, 'Member.Plan': p.facts.plan,
    'Link.Renew': `${site}/membership/renew`, 'Link.Profile': `${site}/portal`, 'Link.Unsubscribe': `${site}/email-preferences?t=${unsubscribeToken(ctx.orgId, addr)}` };
}

/* ---------------- bulk messages ---------------- */
type MsgRow = { id: string; status: string; spec: C.Campaign; recipients: number; skipped: Record<string, number>; created_by: string; sent_at: string | null; group_id: string };
async function loadMsg(ctx: Ctx, id: string) {
  const r = await one<MsgRow>(ctx.db, API(ctx), `SELECT id::text, status, spec, recipients, skipped, created_by, sent_at::text, group_id FROM app.messages WHERE id = $1::uuid AND kind = 'bulk'`, [id]);
  if (!r) throw new HttpError(404, 'No such message.'); return r;
}
async function audienceOf(ctx: Ctx, c: C.Campaign) {
  const [doc, all] = await Promise.all([groupsDoc(ctx), people(ctx)]);
  const reach = all.filter((p) => visible(ctx, p));
  return { ...C.resolveAudience(c, reach, doc), outOfScope: all.length - reach.length };
}
/** Queue one message to its recipients: a delivery row per person (sent or skipped) and the outbox mail / text. */
async function deliver(ctx: Ctx, msgId: string, c: C.Campaign, by: string) {
  const comm = await commDoc(ctx); const a = await audienceOf(ctx, c); const org = await orgValues(ctx); const site = await siteBase(ctx);
  const out: Statement[] = []; const deliveries: { member_id: string; address: string; status: string }[] = [];
  for (const p of a.to as Person[]) {
    const addr = c.channel === 'email' ? p.email!.trim().toLowerCase() : p.phone!.replace(/\D/g, '').slice(-10);
    const t = C.finalText(c, comm, await valuesFor(ctx, p, c.channel, org, site));
    out.push({ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind, ref) VALUES ($1, $2, $3, $4, $5, 'bulk', $6)`, params: [ctx.orgId, c.channel, addr, t.subject, t.body, `msg:${msgId}`] });
    deliveries.push({ member_id: p.id, address: addr, status: 'queued' });
  }
  await ctx.db.run(API(ctx), [
    { sql: `INSERT INTO app.deliveries (org_id, message_id, member_id, address, status) SELECT $1::uuid, $2::uuid, d.member_id, d.address, d.status FROM jsonb_to_recordset($3::jsonb) AS d(member_id text, address text, status text)`, params: [ctx.orgId, msgId, JSON.stringify(deliveries)] },
    { sql: `UPDATE app.messages SET status = 'sent', sent_at = now(), recipients = $2::int, skipped = $3::jsonb, approved_by = $4, spec = $5::jsonb WHERE id = $1::uuid`, params: [msgId, a.to.length, JSON.stringify(a.skipped), by, JSON.stringify({ ...c, status: 'sent', sentTo: a.to.length })] }]);
  for (let i = 0; i < out.length; i += 200) await ctx.db.run(PLATFORM, out.slice(i, i + 200));
  return { sent: a.to.length, skipped: a.skipped };
}
const Draft = z.object({ name: z.string(), channel: z.enum(['email', 'sms']), topic: z.string(), subject: z.string().default(''), body: z.string(), audience: z.object({ everyone: z.boolean().default(false), groupIds: z.array(z.string()).default([]), excludeGroupIds: z.array(z.string()).default([]) }), sendAt: z.string().nullable().default(null) });
function toCampaign(ctx: Ctx, raw: unknown, id: string): C.Campaign {
  const d = Draft.safeParse(raw); if (!d.success) throw new HttpError(400, 'Check the message.', issues(d.error));
  const p = C.CampaignSchema.safeParse({ ...d.data, id, status: 'draft', createdBy: ctx.me?.name ?? '', updatedAt: new Date().toISOString() });
  if (!p.success) throw new HttpError(422, p.error.issues[0].message, issues(p.error));
  if (p.data.audience.everyone && scoped(ctx)) throw new HttpError(403, 'Masjid roles send to groups – “everyone” is for the organization.');
  return p.data;
}

export const COMMS_ROUTES: Route[] = [
  /* ---------------- groups ---------------- */
  route('GET', /^\/admin\/groups$/, async (ctx) => {
    need(ctx, 'members.view');
    const [doc, all, ev] = await Promise.all([groupsDoc(ctx), people(ctx), document(ctx.db, ctx.orgId, 'events')]);
    const reach = all.filter((p) => visible(ctx, p)).map((p) => p.facts);
    const choices: G.RuleChoices = { zone: Array.from(new Set(all.map((p) => p.facts.zone))), center: ((await rows(ctx.db, API(ctx), 'SELECT name FROM app.centers WHERE active')) as { name: string }[]).map((c) => c.name), plan: Array.from(new Set(all.map((p) => p.facts.plan))) };
    const asked = (await rows(ctx.db, API(ctx), `SELECT group_id, count(*)::int AS n FROM app.group_members WHERE status = 'asked' GROUP BY 1`)) as { group_id: string; n: number }[];
    return { status: 200, body: { enabled: doc.enabled, groups: doc.groups.map((g) => ({ ...g, memberIds: undefined, size: G.membersOf(g, reach).length, ruleIssues: G.ruleIssues(g, choices), usedBy: G.groupUsage(g.id, { events: ev as never }), requests: asked.find((a) => a.group_id === g.id)?.n ?? 0 })) } };
  }),
  route('GET', /^\/admin\/groups\/([a-z0-9-]{2,40})\/members$/, async (ctx, mm) => {
    need(ctx, 'members.view');
    const doc = await groupsDoc(ctx); const g = doc.groups.find((x) => x.id === mm[1]); if (!g) throw new HttpError(404, 'No such group.');
    const list = (await people(ctx)).filter((p) => visible(ctx, p) && G.inGroup(g, p.facts));
    return { status: 200, body: { group: { id: g.id, name: g.name, kind: g.kind }, count: list.length, members: list.slice(0, 2000).map((p) => ({ id: p.id, name: p.name, center: p.facts.center, zone: p.facts.zone, status: p.facts.status })) } };
  }),
  route('POST', /^\/admin\/groups\/([a-z0-9-]{2,40})\/members$/, async (ctx, mm) => {
    need(ctx, 'groups.manage');
    const doc = await groupsDoc(ctx); const g = doc.groups.find((x) => x.id === mm[1]); if (!g) throw new HttpError(404, 'No such group.');
    const b = body(ctx); const add = (Array.isArray(b.add) ? b.add : []).map((x) => String(x).toUpperCase()); const remove = new Set((Array.isArray(b.remove) ? b.remove : []).map((x) => String(x).toUpperCase()));
    let next: G.Group;
    if (g.kind === 'manual') {
      const known = new Set(((await rows(ctx.db, API(ctx), 'SELECT id FROM app.members WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb))) AND archived IS NULL', [JSON.stringify(add)])) as { id: string }[]).map((r) => r.id));
      const unknown = add.filter((x) => !known.has(x)); if (unknown.length) throw new HttpError(422, `Not members: ${unknown.slice(0, 5).join(', ')}.`);
      next = { ...g, memberIds: Array.from(new Set([...g.memberIds, ...add])).filter((x) => !remove.has(x)) };
    } else {
      // automatic: "always in" / "never in" exceptions
      next = { ...g, include: Array.from(new Set([...g.include.filter((x) => !remove.has(x)), ...add])), exclude: Array.from(new Set([...g.exclude.filter((x) => !add.includes(x)), ...remove])) };
    }
    await saveGroups(ctx, { ...doc, groups: doc.groups.map((x) => (x.id === g.id ? next : x)) }, `${g.name}: +${add.length} −${remove.size}`);
    await ctx.db.run(API(ctx), [{ sql: `DELETE FROM app.group_members WHERE group_id = $1 AND status = 'asked' AND member_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, params: [g.id, JSON.stringify(add)] }]);
    if (g.kind === 'automatic') await refreshAutomatic(ctx);
    await audit(ctx, 'members', 'Group changed', `${g.name}: added ${add.join(', ') || '–'}; removed ${Array.from(remove).join(', ') || '–'}`, g.id);
    return { status: 200, body: { id: g.id, size: g.kind === 'manual' ? next.memberIds.length : undefined } };
  }),
  route('GET', /^\/admin\/groups\/requests$/, async (ctx) => {
    need(ctx, 'groups.manage');
    const list = await rows(ctx.db, API(ctx), `SELECT gm.group_id AS "groupId", g.name AS "group", gm.member_id AS "memberId", m.first_name || ' ' || m.last_name AS name, m.center, gm.added_at::text AS "askedAt" FROM app.group_members gm JOIN app.groups g ON g.org_id = gm.org_id AND g.id = gm.group_id JOIN app.members m ON m.org_id = gm.org_id AND m.id = gm.member_id WHERE gm.status = 'asked' ORDER BY gm.added_at`);
    return { status: 200, body: { requests: list } };
  }),
  route('POST', /^\/admin\/groups\/([a-z0-9-]{2,40})\/requests\/([A-Za-z0-9-]+)$/, async (ctx, mm) => {
    need(ctx, 'groups.manage');
    const doc = await groupsDoc(ctx); const g = doc.groups.find((x) => x.id === mm[1]); if (!g) throw new HttpError(404, 'No such group.');
    const id = mm[2].toUpperCase(); const r = await one(ctx.db, API(ctx), `SELECT 1 AS x FROM app.group_members WHERE group_id = $1 AND member_id = $2 AND status = 'asked'`, [g.id, id]); if (!r) throw new HttpError(404, 'No request from this member.');
    const decision = String(body(ctx).decision ?? ''); if (!['approve', 'decline'].includes(decision)) throw new HttpError(400, 'Decide approve or decline.');
    if (decision === 'approve') await saveGroups(ctx, { ...doc, groups: doc.groups.map((x) => (x.id === g.id ? { ...x, memberIds: Array.from(new Set([...x.memberIds, id])) } : x)) }, `${g.name}: request from ${id} approved`);
    await ctx.db.run(API(ctx), [{ sql: `DELETE FROM app.group_members WHERE group_id = $1 AND member_id = $2 AND status = 'asked'`, params: [g.id, id] }]);
    if (decision === 'approve') await ctx.db.run(API(ctx), [{ sql: `UPDATE app.group_members SET how = 'joined' WHERE group_id = $1 AND member_id = $2`, params: [g.id, id] }]);
    await audit(ctx, 'members', `Group request ${decision}d`, `${g.name}: ${id}`, g.id);
    return { status: 200, body: { id: g.id, member: id, decision } };
  }),
  route('POST', /^\/admin\/groups\/refresh$/, async (ctx) => { need(ctx, 'groups.manage'); return { status: 200, body: await refreshAutomatic(ctx) }; }),
  route('GET', /^\/member\/groups$/, async (ctx) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const [doc, me] = await Promise.all([groupsDoc(ctx), people(ctx, 'WHERE m.id = $1', [ctx.memberId])]);
    const asked = new Set(((await rows(ctx.db, API(ctx), `SELECT group_id FROM app.group_members WHERE member_id = $1 AND status = 'asked'`, [ctx.memberId])) as { group_id: string }[]).map((r) => r.group_id));
    return { status: 200, body: { groups: G.profileGroups(doc, me[0].facts).map((g) => ({ ...g, requested: asked.has(g.id), action: G.memberAction(doc.groups.find((x) => x.id === g.id)!, g.isIn, asked.has(g.id)) })) } };
  }),
  route('POST', /^\/member\/groups\/([a-z0-9-]{2,40})\/(join|leave|request)$/, async (ctx, mm) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const doc = await groupsDoc(ctx); const g = doc.groups.find((x) => x.id === mm[1]); if (!g) throw new HttpError(404, 'No such group.');
    const me = (await people(ctx, 'WHERE m.id = $1', [ctx.memberId]))[0];
    const asked = !!(await one(ctx.db, API(ctx), `SELECT 1 AS x FROM app.group_members WHERE group_id = $1 AND member_id = $2 AND status = 'asked'`, [g.id, me.id]));
    const allowed = G.memberAction(g, G.inGroup(g, me.facts), asked);
    if (allowed !== mm[2]) throw new HttpError(409, allowed ? `You can ${allowed} this group.` : 'This group is kept by the office.');
    if (mm[2] === 'request') {
      await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.group_members (org_id, group_id, member_id, how, status, added_by) VALUES ($1::uuid, $2, $3, 'asked', 'asked', $4) ON CONFLICT DO NOTHING`, params: [ctx.orgId, g.id, me.id, me.name] }]);
      const leaders = ctx.access.admins.filter((a) => g.leaders.map((l) => l.toLowerCase()).includes(a.email.toLowerCase()));
      if (leaders.length) await ctx.db.run(API(ctx), leaders.map((a) => ({ sql: `INSERT INTO app.notices (org_id, admin_id, kind, title, link) VALUES ($1::uuid, $2, 'approval', $3, '/members/groups')`, params: [ctx.orgId, a.id, `${me.name} asks to join ${g.name}`] })));
    } else {
      const ids = mm[2] === 'join' ? Array.from(new Set([...g.memberIds, me.id])) : g.memberIds.filter((x) => x !== me.id);
      await saveGroups(ctx, { ...doc, groups: doc.groups.map((x) => (x.id === g.id ? { ...x, memberIds: ids } : x)) }, `${me.id} ${mm[2] === 'join' ? 'joined' : 'left'} ${g.name}`);
      if (mm[2] === 'join') await ctx.db.run(API(ctx), [{ sql: `UPDATE app.group_members SET how = 'joined' WHERE group_id = $1 AND member_id = $2`, params: [g.id, me.id] }]);
    }
    return { status: 200, body: { group: g.id, done: mm[2] } };
  }),
  route('POST', /^\/member\/groups\/([a-z0-9-]{2,40})\/message$/, async (ctx, mm) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const [doc, comm] = await Promise.all([groupsDoc(ctx), commDoc(ctx)]); const g = doc.groups.find((x) => x.id === mm[1]); if (!g) throw new HttpError(404, 'No such group.');
    const me = (await people(ctx, 'WHERE m.id = $1', [ctx.memberId]))[0];
    if (!comm.groupEmailsByLeaders || !g.leadersCanEmail || !g.leaders.some((l) => l.toLowerCase() === (me.email ?? '').toLowerCase())) throw new HttpError(403, 'Only the group’s leaders may email it.');
    const b = body(ctx); const id = crypto.randomUUID();
    const c = C.CampaignSchema.safeParse({ id: `leader-${id.slice(0, 8)}`, name: `${g.name} – from ${me.name}`, channel: 'email', topic: 'announcement', subject: String(b.subject ?? ''), body: String(b.body ?? ''), audience: { everyone: false, groupIds: [g.id], excludeGroupIds: [] }, sendAt: null, createdBy: me.name });
    if (!c.success) throw new HttpError(422, c.error.issues[0].message, issues(c.error));
    const problems = C.checkCampaign(c.data, comm, nowMin()); if (problems.length) throw new HttpError(422, problems[0].message, problems);
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.messages (org_id, id, kind, channel, subject, body, audience, status, created_by, name, topic, spec, group_id) VALUES ($1::uuid, $2::uuid, 'bulk', 'email', $3, $4, $5::jsonb, 'sending', $6, $7, 'announcement', $8::jsonb, $9)`,
      params: [ctx.orgId, id, c.data.subject, c.data.body, JSON.stringify(c.data.audience), me.name, c.data.name, JSON.stringify(c.data), g.id] }]);
    const res = await deliver(ctx, id, c.data, `Group leader ${me.id}`);
    await audit(ctx, 'comms', 'Group leader message', `${g.name}: ${res.sent} people`, id);
    return { status: 201, body: res };
  }),

  /* ---------------- preferences ---------------- */
  route('GET', /^\/member\/preferences$/, async (ctx) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const me = (await people(ctx, 'WHERE m.id = $1', [ctx.memberId]))[0];
    return { status: 200, body: { prefs: me.prefs, topics: Object.entries(C.TOPICS).map(([id, t]) => ({ id, label: t.label, optional: t.optional, on: !me.prefs.optOut.includes(id as C.Topic) })) } };
  }),
  route('PUT', /^\/member\/preferences$/, async (ctx) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const P = z.object({ email: z.boolean(), sms: z.boolean(), optOut: z.array(z.enum(C.TOPIC_KEYS as [C.Topic, ...C.Topic[]])).max(10) });
    const p = P.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the choices.', issues(p.error));
    const prefs = { ...p.data, optOut: p.data.optOut.filter((t) => C.TOPICS[t].optional) };   // official notices cannot be switched off
    const m = await one<{ email: string; phone: string }>(ctx.db, API(ctx), 'SELECT email, phone FROM app.members WHERE id = $1', [ctx.memberId]);
    const was = await one<{ given: boolean }>(ctx.db, API(ctx), `SELECT given FROM app.consents WHERE member_id = $1 AND kind = 'sms' ORDER BY at DESC LIMIT 1`, [ctx.memberId]);
    const st: Statement[] = [{ sql: `UPDATE app.members SET prefs = coalesce(prefs, '{}'::jsonb) || $2::jsonb WHERE id = $1`, params: [ctx.memberId, JSON.stringify(prefs)] }];
    if ((was?.given ?? false) !== prefs.sms) st.push({ sql: `INSERT INTO app.consents (org_id, member_id, email, kind, version, given) VALUES ($1::uuid, $2, $3, 'sms', 'portal', $4::boolean)`, params: [ctx.orgId, ctx.memberId, m!.email, prefs.sms] });
    if (m!.email) st.push({ sql: `INSERT INTO app.contact_prefs (org_id, address, channel, member_id, topics, unsubscribed) VALUES ($1::uuid, $2, 'email', $3, $4::text[], $5::boolean) ON CONFLICT (org_id, channel, address) DO UPDATE SET topics = EXCLUDED.topics, unsubscribed = EXCLUDED.unsubscribed, member_id = EXCLUDED.member_id, updated_at = now()`,
      params: [ctx.orgId, m!.email, ctx.memberId, `{${(C.TOPIC_KEYS as string[]).filter((t) => !prefs.optOut.includes(t as C.Topic)).join(',')}}`, !prefs.email] });
    await ctx.db.run(API(ctx), st);
    return { status: 200, body: { prefs } };
  }),
  route('GET', /^\/public\/unsubscribe\/([A-Za-z0-9_-]+\.[0-9a-f]{32})$/, async (ctx, mm) => {
    const address = readToken(ctx.orgId, mm[1]);
    return { status: 200, body: { address: address.replace(/^(.).*(@.*)$/, '$1•••$2'), topics: Object.entries(C.TOPICS).filter(([, t]) => t.optional).map(([id, t]) => ({ id, label: t.label })) } };
  }),
  route('POST', /^\/public\/unsubscribe$/, async (ctx) => {
    const b = body(ctx); const address = readToken(ctx.orgId, String(b.token ?? ''));
    const topic = b.topic ? String(b.topic) as C.Topic : null; if (topic && !C.TOPICS[topic]?.optional) throw new HttpError(400, 'That kind of message cannot be switched off.');
    const m = await one<{ id: string; prefs: C.Prefs | null }>(ctx.db, API(ctx), 'SELECT id, prefs FROM app.members WHERE lower(email) = lower($1) AND archived IS NULL LIMIT 1', [address]);
    const st: Statement[] = [{ sql: `INSERT INTO app.contact_prefs (org_id, address, channel, member_id, topics, unsubscribed) VALUES ($1::uuid, $2, 'email', NULLIF($3, ''), '{}', $4::boolean)
      ON CONFLICT (org_id, channel, address) DO UPDATE SET unsubscribed = app.contact_prefs.unsubscribed OR $4::boolean, topics = CASE WHEN $5 = '' THEN app.contact_prefs.topics ELSE array_remove(app.contact_prefs.topics, $5) END, updated_at = now()`, params: [ctx.orgId, address, m?.id ?? '', !topic, topic ?? ''] }];
    if (m) { const p: C.Prefs = { email: true, sms: false, optOut: [], ...(m.prefs ?? {}) }; const next = topic ? { ...p, optOut: Array.from(new Set([...p.optOut, topic])) } : { ...p, optOut: (C.TOPIC_KEYS as C.Topic[]).filter((t) => C.TOPICS[t].optional) }; st.push({ sql: 'UPDATE app.members SET prefs = $2::jsonb WHERE id = $1', params: [m.id, JSON.stringify(next)] }); }
    await ctx.db.run(API(ctx), st);
    return { status: 200, body: { done: true, text: topic ? `You will not get ${C.TOPICS[topic].label.toLowerCase()} any more.` : 'You will only get official notices (dues, elections, receipts).' } };
  }),

  /* ---------------- bulk messages ---------------- */
  route('GET', /^\/admin\/messages$/, async (ctx) => {
    need(ctx, 'comms.send');
    const list = await rows(ctx.db, API(ctx), `SELECT id::text, name, channel, topic, subject, status, recipients, skipped, created_by AS "createdBy", scheduled_for::text AS "scheduledFor", sent_at::text AS "sentAt", group_id AS "groupId",
      (SELECT count(*)::int FROM app.deliveries d WHERE d.org_id = m.org_id AND d.message_id = m.id AND d.status IN ('bounced', 'failed')) AS failed, spec FROM app.messages m WHERE kind = 'bulk' ORDER BY created_at DESC LIMIT 200`) as Record<string, unknown>[];
    // ?full=1: each message as the admin's composer edits it (the server's id, status and counts win over the stored draft)
    const full = ctx.req.query.get('full') === '1';
    return { status: 200, body: { messages: list.map(({ spec, ...m }) => (full ? { ...m, campaign: { ...(spec as object), id: m.id, status: m.status === 'sending' ? 'sent' : m.status, sentTo: m.recipients ?? 0 } } : m)) } };
  }),
  /* the Communication dashboard: what went out and what happened to it (opens come from the email provider's webhooks) */
  route('GET', /^\/admin\/messages\/stats$/, async (ctx) => {
    need(ctx, 'comms.send');
    const list = await rows(ctx.db, API(ctx), `SELECT m.id::text, m.sent_at::date::text AS "on", coalesce(NULLIF(m.name, ''), NULLIF(m.subject, ''), m.kind) AS what, m.kind, m.channel,
        count(d.*) FILTER (WHERE d.status <> 'skipped')::int AS "to",
        count(d.*) FILTER (WHERE d.status IN ('delivered', 'opened', 'clicked'))::int AS delivered,
        count(d.*) FILTER (WHERE d.status IN ('opened', 'clicked'))::int AS opened,
        count(d.*) FILTER (WHERE d.status IN ('bounced', 'failed', 'complained'))::int AS failed
      FROM app.messages m LEFT JOIN app.deliveries d ON d.org_id = m.org_id AND d.message_id = m.id
      WHERE m.sent_at IS NOT NULL AND m.sent_at > now() - interval '400 days' AND m.kind NOT IN ('receipt', 'ticket-reply')
      GROUP BY m.org_id, m.id ORDER BY m.sent_at DESC LIMIT 300`) as { kind: string }[];
    return { status: 200, body: { sends: list.map((x) => ({ ...x, kind: x.kind === 'bulk' ? 'Sent by staff' : 'Automatic' })) } };
  }),
  route('POST', /^\/admin\/messages$/, async (ctx) => {
    need(ctx, 'comms.send');
    const id = crypto.randomUUID(); const c = toCampaign(ctx, body(ctx), `msg-${id.slice(0, 8)}`);
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.messages (org_id, id, kind, channel, subject, body, audience, status, created_by, name, topic, spec) VALUES ($1::uuid, $2::uuid, 'bulk', $3, $4, $5, $6::jsonb, 'draft', $7, $8, $9, $10::jsonb)`,
      params: [ctx.orgId, id, c.channel, c.subject, c.body, JSON.stringify(c.audience), ctx.me!.name, c.name, c.topic, JSON.stringify(c)] }]);
    return { status: 201, body: { id, message: c } };
  }),
  route('PUT', /^\/admin\/messages\/([0-9a-f-]{36})$/, async (ctx, mm) => {
    need(ctx, 'comms.send'); const r = await loadMsg(ctx, mm[1]); if (r.status !== 'draft') throw new HttpError(409, 'Only a draft can change.');
    const c = toCampaign(ctx, body(ctx), r.spec.id);
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.messages SET channel = $2, subject = $3, body = $4, audience = $5::jsonb, name = $6, topic = $7, spec = $8::jsonb WHERE id = $1::uuid`, params: [mm[1], c.channel, c.subject, c.body, JSON.stringify(c.audience), c.name, c.topic, JSON.stringify(c)] }]);
    return { status: 200, body: { id: mm[1], message: c } };
  }),
  route('POST', /^\/admin\/messages\/([0-9a-f-]{36})\/(preview|send|cancel)$/, async (ctx, mm) => {
    need(ctx, 'comms.send'); const r = await loadMsg(ctx, mm[1]); const c = r.spec; const comm = await commDoc(ctx);
    if (mm[2] === 'cancel') {
      if (r.status !== 'scheduled') throw new HttpError(409, 'Only a scheduled message can be cancelled.');
      await ctx.db.run(API(ctx), [{ sql: `UPDATE app.messages SET status = 'cancelled' WHERE id = $1::uuid`, params: [mm[1]] }]);
      await audit(ctx, 'comms', 'Message cancelled', c.name, mm[1]); return { status: 200, body: { id: mm[1], status: 'cancelled' } };
    }
    const problems = C.checkCampaign(c, comm, nowMin());
    if (c.channel === 'email' && /ZIP 00000/.test(comm.sender.footer)) problems.push({ field: 'body', message: 'Add your postal address to the email footer (Communication › Sending) – bulk email must show it.' });
    if (mm[2] === 'preview') {
      const a = await audienceOf(ctx, c); const first = a.to[0] as Person | undefined;
      const sample = first ? C.finalText(c, comm, await valuesFor(ctx, first, c.channel, await orgValues(ctx), await siteBase(ctx))) : null;
      return { status: 200, body: { recipients: a.to.length, skipped: Object.entries(a.skipped).filter(([, v]) => v).map(([k, v]) => ({ reason: C.SKIP_LABEL[k as C.SkipReason], count: v })), missingGroups: a.missingGroups, problems, sample, sms: c.channel === 'sms' ? C.smsSegments(c.body + C.STOP_TEXT) : null } };
    }
    if (r.status !== 'draft') throw new HttpError(409, `This message is ${r.status}.`);
    if (problems.length) throw new HttpError(422, problems[0].message, problems);
    if (c.sendAt && c.sendAt > nowMin()) {
      await ctx.db.run(API(ctx), [{ sql: `UPDATE app.messages SET status = 'scheduled', scheduled_for = ($2::timestamp AT TIME ZONE app.org_tz()), approved_by = $3, spec = $4::jsonb WHERE id = $1::uuid`, params: [mm[1], c.sendAt, ctx.me!.name, JSON.stringify({ ...c, status: 'scheduled' })] }]);
      await audit(ctx, 'comms', 'Message scheduled', `${c.name} for ${c.sendAt}`, mm[1]);
      return { status: 200, body: { id: mm[1], status: 'scheduled', sendAt: c.sendAt } };
    }
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.messages SET status = 'sending' WHERE id = $1::uuid AND status = 'draft'`, params: [mm[1]] }]);
    const res = await deliver(ctx, mm[1], c, ctx.me!.name);
    await audit(ctx, 'comms', 'Message sent', `${c.name}: ${res.sent} ${c.channel === 'sms' ? 'texts' : 'emails'}`, mm[1]);
    return { status: 200, body: { id: mm[1], status: 'sent', ...res } };
  }),
  route('POST', /^\/admin\/messages\/run-jobs$/, async (ctx) => { need(ctx, 'settings.manage'); return { status: 200, body: await runCommsJobs(ctx) }; }),
];

/** Every few minutes: scheduled messages whose time has come; nightly: automatic groups. */
export async function runCommsJobs(ctx: Ctx, opts: { groups?: boolean } = { groups: true }) {
  const due = (await rows(ctx.db, API(ctx), `SELECT id::text, spec, approved_by FROM app.messages WHERE kind = 'bulk' AND status = 'scheduled' AND scheduled_for <= now()`)) as { id: string; spec: C.Campaign; approved_by: string }[];
  let sent = 0;
  for (const m of due) {
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.messages SET status = 'sending' WHERE id = $1::uuid AND status = 'scheduled'`, params: [m.id] }]);
    sent += (await deliver(ctx, m.id, { ...m.spec, sendAt: null }, m.approved_by)).sent;
  }
  const groups = opts.groups ? await refreshAutomatic(ctx) : { groups: 0 };
  return { messages: due.length, sent, groups: groups.groups };
}
