/**
 * B2 Members – writes and work queues on the 0005 tables (reads of the list and one record stay in server.ts for now).
 *   POST   /admin/members                       new member (members.edit); placed by ZIP; duplicate check (409 unless force)
 *   PATCH  /admin/members/:id                   profile (members.edit; contact fields also need members.contact)
 *   POST   /admin/members/:id/center            move to a masjid by hand {center, reason} – locked 5 years unless admins.manage
 *   POST   /admin/members/:id/notes             {text}
 *   POST   /admin/members/:id/payments          dues paid at a desk {year, amountCents, method, paidOn, ref, payer} (payments.record)
 *   POST   /admin/members/:id/id-check          {status verified|rejected, docType, reason} (members.edit)
 *   POST   /admin/members/:id/archive | restore {reason} (members.archive)
 *   POST   /admin/members/:id/activity          {action, detail} – a step taken outside the record (outreach, call…) for its audit trail
 *   GET    /admin/queues/counts                 applications, photo IDs, center changes, duplicates, payments to fix
 *   GET    /admin/queues/:queue                 the rows of one queue (in the admin's scope)
 *   POST   /admin/duplicates/scan               find look-alike records (findDuplicates) → open pairs
 *   POST   /admin/duplicates/decide             {a, b, decision: not-duplicate | merged} – merged archives b
 *   POST   /admin/center-changes/:id/decide     {decision: approve | decline, note}
 *   POST   /admin/members/import/check          {csv, preset?, mapping?} → the plan (nothing written)
 *   POST   /admin/members/import                {csv, preset?, mapping?, withDuplicates?} → rows created (members.archive)
 *   GET    /member/me · PATCH /member/me · POST /member/center-change   the member's own record (member session)
 * Every change writes the audit log. Scope: masjid / zone / area roles only touch members inside their scope.
 */
import { z } from 'zod';
import { one, rows, type Statement } from '../db/sql.js';
import { HttpError, audit, document, need, needMember, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { can, inScope, roleOf } from '@/lib/community/access';
import { findDuplicates, planImport, type Person } from '@/lib/community/member-records';
import { OrgConfigSchema, mockOrgConfig } from '@/lib/community/org-config';
import { MembershipSettingsSchema, mockMembershipSettings } from '@/lib/content/membership';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const ZIP = z.string().regex(/^\d{5}(-\d{4})?$/, 'A ZIP code has 5 digits.');
const PHONE = z.string().regex(/^\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}$/, 'Use a 10-digit US phone.');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD).');
const fmtPhone = (p: string) => { const d = p.replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : ''; };
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

type Row = { id: string; first_name: string; last_name: string; email: string; phone: string; dob: string | null; zip: string; zone: string; center: string; center_override: unknown; archived: unknown; plan: string; spouse_id: string | null; status: string; approved_on: string | null };
async function load(ctx: Ctx, id: string, perm: Parameters<typeof need>[1] = 'members.view'): Promise<Row> {
  need(ctx, perm);
  const r = await one<Row>(ctx.db, API(ctx), 'SELECT id, first_name, last_name, email, phone, dob::text, zip, zone, center, center_override, archived, plan, spouse_id, status, approved_on::text FROM app.members WHERE id = $1', [id.toUpperCase()]);
  if (!r) throw new HttpError(404, `No member ${id}.`);
  if (!inScope(ctx.access, ctx.me, r.zone, r.center, r.zip)) throw new HttpError(403, 'This member is outside your masjid or zone.');
  return r;
}
const people = async (ctx: Ctx): Promise<Person[]> => (await rows(ctx.db, API(ctx), `SELECT id, first_name AS first, last_name AS last, email, phone, coalesce(dob::text, '') AS dob, coalesce(spouse_id, '') AS "spouseId" FROM app.members WHERE archived IS NULL`)) as unknown as Person[];
async function plans(ctx: Ctx) { const p = MembershipSettingsSchema.safeParse(await document(ctx.db, ctx.orgId, 'membership-settings')); return (p.success ? p.data : mockMembershipSettings).plans; }

/* ---------------- create / edit ---------------- */
const NewMember = z.object({
  first: z.string().trim().min(1).max(60), middle: z.string().trim().max(60).default(''), last: z.string().trim().min(1).max(60),
  email: z.string().trim().toLowerCase().email().max(254), phone: z.union([z.literal(''), PHONE]).default(''), dob: z.union([z.literal(''), DATE]).default(''),
  gender: z.enum(['', 'male', 'female']).default(''), street: z.string().max(120).default(''), city: z.string().max(60).default(''), state: z.string().max(2).default('TX'),
  zip: ZIP, plan: z.string().min(1).max(40), commitment: z.enum(['programs', 'contribution', 'volunteer']).default('programs'),
  approved: z.boolean().default(false), force: z.boolean().default(false), extra: z.record(z.string(), z.unknown()).default({}),
});
const Patch = NewMember.omit({ approved: true, force: true }).partial().extend({ preferred: z.string().max(60).optional(), standing: z.enum(['good', 'resigned', 'expelled']).optional() });
const CONTACT = ['email', 'phone', 'dob', 'street', 'city', 'state', 'zip'];

export const MEMBER_ROUTES: Route[] = [
  route('POST', /^\/admin\/members$/, async (ctx) => {
    need(ctx, 'members.edit');
    const p = NewMember.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the new member’s details.', issues(p.error));
    const m = p.data;
    if (!(await plans(ctx)).some((x) => x.id === m.plan)) throw new HttpError(400, `There is no plan “${m.plan}”.`);
    if (!m.force) { const dup = findDuplicates({ first: m.first, last: m.last, email: m.email, phone: m.phone, dob: m.dob }, await people(ctx)); if (dup.some((d) => d.level === 'likely')) throw new HttpError(409, 'This person may already be on file.', dup); }
    const today = todayCT();
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = (await one<{ id: string }>(ctx.db, API(ctx), `SELECT app.next_member_id($1::uuid, $2) AS id`, [ctx.orgId, ctx.slug.slice(0, 3).toUpperCase()]))!.id;
      const r = await rows(ctx.db, API(ctx), `INSERT INTO app.members (org_id, id, first_name, middle_name, last_name, email, phone, dob, gender, street, city, state, zip, plan, joined_year, applied_on, approved_on, commitment, source, extra, record)
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, NULLIF($8, '')::date, $9, $10, $11, $12, $13, $14, $15::int, $16::date, NULLIF($17, '')::date, $18, 'admin', $19::jsonb, $20::jsonb) ON CONFLICT DO NOTHING RETURNING id, center, zone, member_no`,
        [ctx.orgId, id, m.first, m.middle, m.last, m.email, m.phone ? fmtPhone(m.phone) : '', m.dob, m.gender, m.street, m.city, m.state, m.zip.slice(0, 5), m.plan, Number(today.slice(0, 4)), today, m.approved ? today : '', m.commitment, m.extra,
          { audit: [{ at: new Date().toISOString(), by: ctx.me!.name, action: 'Created', detail: 'Added by staff' }] }]);
      if (r.length) {
        const placed = r[0] as { center: string; zone: string };
        if (!inScope(ctx.access, ctx.me, placed.zone, placed.center, m.zip)) { await ctx.db.run(API(ctx), [{ sql: 'DELETE FROM app.members WHERE id = $1', params: [id] }]); throw new HttpError(403, `ZIP ${m.zip} belongs to ${placed.center || 'another area'} – outside your masjid or zone.`); }
        await ctx.db.run(API(ctx), [{ sql: 'SELECT app.refresh_status($1::uuid, $2)', params: [ctx.orgId, id] }]);
        await audit(ctx, 'members', 'Member created', `${m.first} ${m.last}`, id);
        return { status: 201, body: { id, ...r[0] } };
      }
    }
    throw new HttpError(409, 'Could not give a member number – try again.');
  }),

  route('PATCH', /^\/admin\/members\/([A-Za-z0-9-]+)$/, async (ctx, mm) => {
    const cur = await load(ctx, mm[1], 'members.edit');
    const p = Patch.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the changes.', issues(p.error));
    const ch = p.data; const keys = Object.keys(ch);
    if (!keys.length) throw new HttpError(400, 'Nothing to change.');
    if (keys.some((k) => CONTACT.includes(k))) need(ctx, 'members.contact');
    if (ch.standing && ch.standing !== 'good') need(ctx, 'members.archive');
    if (ch.plan && !(await plans(ctx)).some((x) => x.id === ch.plan)) throw new HttpError(400, `There is no plan “${ch.plan}”.`);
    const col: Record<string, string> = { first: 'first_name', middle: 'middle_name', last: 'last_name', preferred: 'preferred_name', email: 'email', phone: 'phone', dob: 'dob', gender: 'gender', street: 'street', city: 'city', state: 'state', zip: 'zip', plan: 'plan', commitment: 'commitment', standing: 'standing', extra: 'extra' };
    const sets: string[] = []; const params: unknown[] = [cur.id];
    for (const [k, v] of Object.entries(ch)) {
      if (!col[k]) continue;
      const val = k === 'phone' ? fmtPhone(String(v)) : k === 'zip' ? String(v).slice(0, 5) : v;
      params.push(k === 'extra' ? JSON.stringify(val) : val);
      sets.push(k === 'dob' ? `dob = NULLIF($${params.length}, '')::date` : k === 'extra' ? `extra = extra || $${params.length}::jsonb` : `${col[k]} = $${params.length}`);
    }
    params.push(JSON.stringify([{ at: new Date().toISOString(), by: ctx.me!.name, action: 'Edited', detail: keys.join(', ') }]));
    sets.push(`record = jsonb_set(record, '{audit}', coalesce(record->'audit', '[]'::jsonb) || $${params.length}::jsonb)`);
    const r = await rows(ctx.db, API(ctx), `UPDATE app.members SET ${sets.join(', ')} WHERE id = $1 RETURNING id, center, zone, status`, params);
    await ctx.db.run(API(ctx), [{ sql: 'SELECT app.refresh_status($1::uuid, $2)', params: [ctx.orgId, cur.id] }]);
    await audit(ctx, 'members', 'Member edited', keys.join(', '), cur.id);
    return { status: 200, body: r[0] };
  }),

  route('POST', /^\/admin\/members\/([A-Za-z0-9-]+)\/center$/, async (ctx, mm) => {
    const cur = await load(ctx, mm[1], 'members.edit');
    const b = body(ctx); const reason = String(b.reason ?? '').trim(); const center = String(b.center ?? '');
    if (reason.length < 3) throw new HttpError(400, 'Say why the member moves to another masjid.');
    const to = await one<{ id: string; name: string; zone: string }>(ctx.db, API(ctx), `SELECT c.id, c.name, z.code AS zone FROM app.centers c JOIN app.zones z ON z.org_id = c.org_id AND z.id = c.zone_id WHERE c.active AND (c.code = $1 OR c.name = $1)`, [center]);
    if (!to) throw new HttpError(400, `“${center}” is not an active masjid.`);
    if (!inScope(ctx.access, ctx.me, to.zone, to.name)) throw new HttpError(403, `${to.name} is outside your masjid or zone.`);
    const ov = cur.center_override as { lockedUntil?: string } | null;
    if (ov?.lockedUntil && ov.lockedUntil > todayCT() && !can(ctx.access, ctx.me, 'admins.manage', todayCT())) throw new HttpError(409, `This member changed masjid recently – locked until ${ov.lockedUntil} (Bylaws).`);
    const until = `${Number(todayCT().slice(0, 4)) + 5}${todayCT().slice(4)}`;
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET center_override = $2::jsonb, center_id = $3::uuid WHERE id = $1`, params: [cur.id, { reason, by: ctx.me!.name, at: new Date().toISOString(), lockedUntil: until, from: cur.center }, to.id] },
      { sql: `INSERT INTO app.center_changes (org_id, member_id, from_center, to_center, reason, status, locked_until, decided_by, decided_at) SELECT $1::uuid, $2, (SELECT id FROM app.centers WHERE name = $3), $4::uuid, $5, 'approved', $6::date, $7, now()`, params: [ctx.orgId, cur.id, cur.center, to.id, reason, until, ctx.me!.name] }]);
    await audit(ctx, 'members', 'Center changed', `${cur.center} → ${to.name}: ${reason}`, cur.id);
    return { status: 200, body: { id: cur.id, center: to.name, lockedUntil: until } };
  }),

  route('POST', /^\/admin\/members\/([A-Za-z0-9-]+)\/notes$/, async (ctx, mm) => {
    const cur = await load(ctx, mm[1], 'members.edit');
    const text = String(body(ctx).text ?? '').trim(); if (!text || text.length > 4000) throw new HttpError(400, 'Write the note (up to 4,000 characters).');
    await ctx.db.run(API(ctx), [{ sql: 'INSERT INTO app.member_notes (org_id, member_id, by, text) VALUES ($1::uuid, $2, $3, $4)', params: [ctx.orgId, cur.id, ctx.me!.name, text] }]);
    return { status: 201, body: { ok: true } };
  }),

  route('POST', /^\/admin\/members\/([A-Za-z0-9-]+)\/payments$/, async (ctx, mm) => {
    const cur = await load(ctx, mm[1], 'payments.record');
    const P = z.object({ year: z.number().int().min(2000).max(2100), amountCents: z.number().int().positive().max(10_000_000), method: z.enum(['check', 'cash', 'card', 'ach']), paidOn: DATE.default(todayCT()), ref: z.string().max(120).default(''), payer: z.enum(['self', 'spouse', 'parent', 'other']).default('self') });
    const p = P.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the payment.', issues(p.error));
    const v = p.data;
    if (v.method === 'check' && !v.ref) throw new HttpError(400, 'Write the check number in ref.');
    if (v.paidOn > todayCT()) throw new HttpError(400, 'The payment date is in the future.');
    const receipt = (await one<{ n: string }>(ctx.db, API(ctx), `SELECT 'R-' || app.next_no($1::uuid, 'receipt', 10001)::text AS n`, [ctx.orgId]))!.n;
    const stmts: Statement[] = [
      { sql: `INSERT INTO app.payments (org_id, member_id, year, paid_on, amount_cents, method, payer, ref, status, processor, receipt_no, recorded_by) VALUES ($1::uuid, $2, $3::int, $4::date, $5::int, $6, $7, $8, 'paid', 'desk', $9, $10)`, params: [ctx.orgId, cur.id, v.year, v.paidOn, v.amountCents, v.method, v.payer, v.ref || receipt, receipt, ctx.me!.name] },
      { sql: 'SELECT app.backfill_memberships($1::uuid)', params: [ctx.orgId] },
      { sql: 'SELECT app.refresh_status($1::uuid, $2)', params: [ctx.orgId, cur.id] },
    ];
    await ctx.db.run(API(ctx), stmts);
    await audit(ctx, 'payments', 'Payment recorded', `${v.year} · $${(v.amountCents / 100).toFixed(2)} · ${v.method}`, cur.id);
    const st = await one<{ status: string; paid_through: string | null }>(ctx.db, API(ctx), 'SELECT status, paid_through::text FROM app.members WHERE id = $1', [cur.id]);
    return { status: 201, body: { receipt, ...st } };
  }),

  route('POST', /^\/admin\/members\/([A-Za-z0-9-]+)\/id-check$/, async (ctx, mm) => {
    const cur = await load(ctx, mm[1], 'members.edit');
    const b = body(ctx); const status = String(b.status ?? ''); const reason = String(b.reason ?? '').trim();
    if (!['verified', 'rejected'].includes(status)) throw new HttpError(400, 'Status: verified or rejected.');
    if (status === 'rejected' && reason.length < 3) throw new HttpError(400, 'Say why the ID was not accepted.');
    const doc = ['driver-license', 'state-id', 'passport', 'other'].includes(String(b.docType)) ? String(b.docType) : 'driver-license';
    await ctx.db.run(API(ctx), [
      { sql: `INSERT INTO app.id_checks (org_id, member_id, doc_type, status, reason, checked_by, checked_at, purge_after) VALUES ($1::uuid, $2, $3, $4, $5, $6, now(), current_date + 30)`, params: [ctx.orgId, cur.id, doc, status, reason, ctx.me!.name] },
      { sql: `UPDATE app.members SET id_check = $2 WHERE id = $1`, params: [cur.id, status === 'verified' ? 'verified' : 'not_started'] },
    ]);
    await audit(ctx, 'members', status === 'verified' ? 'ID verified' : 'ID not accepted', reason, cur.id);
    return { status: 200, body: { id: cur.id, idCheck: status } };
  }),

  route('POST', /^\/admin\/members\/([A-Za-z0-9-]+)\/activity$/, async (ctx, mm) => {
    const cur = await load(ctx, mm[1], 'members.view');
    const b = body(ctx); const action = String(b.action ?? '').trim().slice(0, 80); const detail = String(b.detail ?? '').trim().slice(0, 500);
    if (action.length < 2) throw new HttpError(400, 'Say what was done.');
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET record = jsonb_set(record, '{audit}', coalesce(record->'audit', '[]'::jsonb) || $2::jsonb) WHERE id = $1`, params: [cur.id, JSON.stringify([{ at: new Date().toISOString(), by: ctx.me!.name, action, detail }])] }]);
    await audit(ctx, 'members', action, detail, cur.id);
    return { status: 201, body: { id: cur.id } };
  }),
  route('POST', /^\/admin\/members\/([A-Za-z0-9-]+)\/(archive|restore)$/, async (ctx, mm) => {
    const cur = await load(ctx, mm[1], 'members.archive');
    const reason = String(body(ctx).reason ?? '').trim();
    if (mm[2] === 'archive') {
      if (cur.archived) throw new HttpError(409, 'Already archived.');
      if (reason.length < 3) throw new HttpError(400, 'Say why the record is archived.');
      await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET archived = $2::jsonb WHERE id = $1`, params: [cur.id, { on: todayCT(), reason, by: ctx.me!.name }] }]);
    } else {
      if (!cur.archived) throw new HttpError(409, 'This record is not archived.');
      await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET archived = NULL WHERE id = $1`, params: [cur.id] }, { sql: 'SELECT app.refresh_status($1::uuid, $2)', params: [ctx.orgId, cur.id] }]);
    }
    await audit(ctx, 'members', mm[2] === 'archive' ? 'Archived' : 'Restored', reason, cur.id);
    return { status: 200, body: { id: cur.id, archived: mm[2] === 'archive' } };
  }),

  /* ---------------- work queues ---------------- */
  route('GET', /^\/admin\/queues\/counts$/, async (ctx) => {
    need(ctx, 'members.view');
    const list = await queueRows(ctx);
    return { status: 200, body: Object.fromEntries(Object.entries(list).map(([k, v]) => [k, v.length])) };
  }),
  route('GET', /^\/admin\/queues\/(applications|id|center|duplicates|payments)$/, async (ctx, mm) => {
    need(ctx, 'members.view');
    const list = (await queueRows(ctx))[mm[1] as keyof Awaited<ReturnType<typeof queueRows>>];
    return { status: 200, body: { queue: mm[1], count: list.length, items: list } };
  }),
  route('POST', /^\/admin\/duplicates\/scan$/, async (ctx) => {
    need(ctx, 'members.edit');
    const all = await people(ctx); const stmts: Statement[] = []; const seen = new Set<string>();
    for (const a of all) for (const d of findDuplicates(a, all, 5)) {
      const [x, y] = [a.id!, d.id].sort(); const k = `${x}|${y}`; if (seen.has(k)) continue; seen.add(k);
      stmts.push({ sql: `INSERT INTO app.duplicate_pairs (org_id, a, b, score, reasons) VALUES ($1::uuid, $2, $3, $4::smallint, $5::text[]) ON CONFLICT (org_id, a, b) DO UPDATE SET score = EXCLUDED.score, reasons = EXCLUDED.reasons`, params: [ctx.orgId, x, y, d.score, `{${d.reasons.map((r) => `"${r.replace(/"/g, '')}"`).join(',')}}`] });
    }
    for (let i = 0; i < stmts.length; i += 200) await ctx.db.run(API(ctx), stmts.slice(i, i + 200));
    return { status: 200, body: { pairs: seen.size } };
  }),
  route('POST', /^\/admin\/duplicates\/decide$/, async (ctx) => {
    need(ctx, 'members.edit');
    const b = body(ctx); const [a, c] = [String(b.a ?? ''), String(b.b ?? '')].sort(); const decision = String(b.decision ?? '');
    if (!['not-duplicate', 'merged'].includes(decision)) throw new HttpError(400, 'Decision: not-duplicate or merged.');
    const pair = await one(ctx.db, API(ctx), `SELECT 1 FROM app.duplicate_pairs WHERE a = $1 AND b = $2 AND status = 'open'`, [a, c]);
    if (!pair) throw new HttpError(404, 'No open pair like that.');
    const keep = String(b.keep ?? a); const drop = keep === a ? c : a;
    if (decision === 'merged') { need(ctx, 'members.archive'); await load(ctx, drop); }
    await ctx.db.run(API(ctx), [
      { sql: `UPDATE app.duplicate_pairs SET status = $3, decided_by = $4, decided_at = now() WHERE a = $1 AND b = $2`, params: [a, c, decision, ctx.me!.name] },
      ...(decision === 'merged' ? [{ sql: `UPDATE app.members SET archived = $2::jsonb WHERE id = $1`, params: [drop, { on: todayCT(), reason: `Merged into ${keep}`, by: ctx.me!.name }] },
        { sql: `UPDATE app.payments SET member_id = $2 WHERE member_id = $1`, params: [drop, keep] },
        { sql: 'SELECT app.backfill_memberships($1::uuid)', params: [ctx.orgId] }, { sql: 'SELECT app.refresh_status($1::uuid, $2)', params: [ctx.orgId, keep] }] : []),
    ]);
    await audit(ctx, 'members', decision === 'merged' ? 'Records merged' : 'Not a duplicate', `${drop} → ${keep}`, keep);
    return { status: 200, body: { ok: true } };
  }),
  route('POST', /^\/admin\/center-changes\/([0-9a-f-]{36})\/decide$/, async (ctx, mm) => {
    need(ctx, 'members.edit');
    const cc = await one<{ member_id: string; to_center: string; to_name: string; to_zone: string; reason: string; status: string }>(ctx.db, API(ctx), `SELECT x.member_id, x.to_center, c.name AS to_name, z.code AS to_zone, x.reason, x.status FROM app.center_changes x JOIN app.centers c ON c.org_id = x.org_id AND c.id = x.to_center JOIN app.zones z ON z.org_id = c.org_id AND z.id = c.zone_id WHERE x.id = $1::uuid`, [mm[1]]);
    if (!cc) throw new HttpError(404, 'No such request.');
    if (cc.status !== 'pending') throw new HttpError(409, 'Already decided.');
    const cur = await load(ctx, cc.member_id, 'members.edit');
    if (!inScope(ctx.access, ctx.me, cc.to_zone, cc.to_name)) throw new HttpError(403, 'The new masjid is outside your scope.');
    const ok = String(body(ctx).decision) === 'approve'; const until = `${Number(todayCT().slice(0, 4)) + 5}${todayCT().slice(4)}`;
    await ctx.db.run(API(ctx), [
      { sql: `UPDATE app.center_changes SET status = $2, decided_by = $3, decided_at = now(), locked_until = CASE WHEN $2 = 'approved' THEN $4::date END WHERE id = $1::uuid`, params: [mm[1], ok ? 'approved' : 'declined', ctx.me!.name, until] },
      ...(ok ? [{ sql: `UPDATE app.members SET center_override = $2::jsonb, center_id = $3::uuid WHERE id = $1`, params: [cur.id, { reason: cc.reason, by: ctx.me!.name, at: new Date().toISOString(), lockedUntil: until, from: cur.center }, cc.to_center] }] : []),
    ]);
    await audit(ctx, 'members', ok ? 'Center change approved' : 'Center change declined', `${cur.center} → ${cc.to_name}`, cur.id);
    return { status: 200, body: { status: ok ? 'approved' : 'declined' } };
  }),

  /* ---------------- import ---------------- */
  route('POST', /^\/admin\/members\/import\/check$/, async (ctx) => {
    need(ctx, 'members.archive');
    return { status: 200, body: await importPlan(ctx) };
  }),
  route('POST', /^\/admin\/members\/import$/, async (ctx) => {
    need(ctx, 'members.archive');
    const plan = await importPlan(ctx); const withDup = body(ctx).withDuplicates === true;
    if (plan.missing.length) throw new HttpError(400, `Columns missing: ${plan.missing.join(', ')}.`);
    const take = plan.rows.filter((r) => r.record && (r.status === 'ok' || (withDup && r.status === 'duplicate')));
    const defaultPlan = String(body(ctx).defaultPlan ?? (await plans(ctx))[0]?.id ?? '');
    const today = todayCT(); let created = 0;
    for (const r of take) {
      const rec = r.record as Record<string, string> & { values?: Record<string, unknown> };
      const id = (await one<{ id: string }>(ctx.db, API(ctx), `SELECT app.next_member_id($1::uuid, $2) AS id`, [ctx.orgId, ctx.slug.slice(0, 3).toUpperCase()]))!.id;
      const status = rec.status || 'active';
      const approved = ['active', 'lapsed', 'archived', 'life'].includes(status) ? (rec.memberSince || today) : '';
      const stmts: Statement[] = [{ sql: `INSERT INTO app.members (org_id, id, first_name, middle_name, last_name, email, phone, dob, street, city, zip, plan, joined_year, applied_on, approved_on, source, archived, extra, external_ids, record)
          VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, NULLIF($8, '')::date, $9, $10, $11, $12, $13::int, $14::date, NULLIF($15, '')::date, 'import', NULLIF($16, '')::jsonb, $17::jsonb, $18::jsonb, $19::jsonb) ON CONFLICT DO NOTHING`,
        params: [ctx.orgId, id, rec.first, rec.middle ?? '', rec.last, rec.email, rec.phone ?? '', rec.dob ?? '', rec.street ?? '', rec.city ?? '', (rec.zip ?? '').slice(0, 5), rec.plan || defaultPlan, Number((rec.memberSince || today).slice(0, 4)), rec.memberSince || today, approved,
          status === 'archived' ? JSON.stringify({ on: today, reason: 'Archived in the old system', by: 'Import' }) : '', rec.values ?? {}, rec.externalId ? { import: rec.externalId } : {}, { audit: [{ at: new Date().toISOString(), by: ctx.me!.name, action: 'Imported', detail: `row ${r.line}` }], notes: rec.notes ? [{ at: new Date().toISOString(), by: 'Import', text: rec.notes }] : [] }] }];
      if (status === 'active' && rec.renewalDue !== undefined) stmts.push({ sql: `INSERT INTO app.payments (org_id, member_id, year, paid_on, amount_cents, method, ref, status, processor, recorded_by) VALUES ($1::uuid, $2, $3::int, $4::date, 0, 'cash', 'import', 'paid', 'import', 'Import')`, params: [ctx.orgId, id, Number(today.slice(0, 4)), today] });
      await ctx.db.run(API(ctx), stmts); created++;
    }
    await ctx.db.run(API(ctx), [{ sql: 'SELECT app.backfill_memberships($1::uuid)', params: [ctx.orgId] }, { sql: 'SELECT app.refresh_status($1::uuid)', params: [ctx.orgId] },
      { sql: `INSERT INTO app.imports (org_id, preset, mapping, rows_total, rows_created, rows_skipped, problems, status, by) VALUES ($1::uuid, $2, $3::jsonb, $4::int, $5::int, $6::int, $7::jsonb, 'done', $8)`,
        params: [ctx.orgId, String(body(ctx).preset ?? 'spreadsheet'), body(ctx).mapping ?? {}, plan.rows.length, created, plan.rows.length - created, plan.rows.filter((r) => r.errors.length).slice(0, 200).map((r) => ({ row: r.line, errors: r.errors })), ctx.me!.name] }]);
    await audit(ctx, 'members', 'Import', `${created} of ${plan.rows.length} rows`, '');
    return { status: 201, body: { created, skipped: plan.rows.length - created } };
  }),

  /* ---------------- the member's own record ---------------- */
  route('GET', /^\/member\/me$/, async (ctx) => {
    const id = needMember(ctx);
    const m = await one(ctx.db, API(ctx), `SELECT id, member_no, first_name, middle_name, last_name, preferred_name, email, phone, street, city, state, zip, plan, status, paid_through::text, approved_on::text, id_check, center, zone, prefs FROM app.members WHERE id = $1 AND archived IS NULL`, [id]);
    if (!m) throw new HttpError(404, 'Your record is not available.');
    const terms = await rows(ctx.db, API(ctx), `SELECT plan_id, starts_on::text, ends_on::text, status FROM app.memberships WHERE member_id = $1 ORDER BY starts_on DESC`, [id]);
    const pays = await rows(ctx.db, API(ctx), `SELECT year, paid_on::text, amount_cents, method, receipt_no FROM app.payments WHERE member_id = $1 AND status = 'paid' ORDER BY paid_on DESC`, [id]);
    return { status: 200, body: { member: m, memberships: terms, payments: pays } };
  }),
  route('PATCH', /^\/member\/me$/, async (ctx) => {
    const id = needMember(ctx);
    const P = z.object({ phone: z.union([z.literal(''), PHONE]).optional(), street: z.string().max(120).optional(), city: z.string().max(60).optional(), zip: ZIP.optional(), preferred: z.string().max(60).optional(), prefs: z.record(z.string(), z.unknown()).optional() }).strict();
    const p = P.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check your changes. Your name and email are changed by the office.', issues(p.error));
    const v = p.data; const sets: string[] = []; const params: unknown[] = [id];
    const put = (c: string, val: unknown, cast = '') => { params.push(val); sets.push(`${c} = $${params.length}${cast}`); };
    if (v.phone !== undefined) put('phone', v.phone ? fmtPhone(v.phone) : '');
    if (v.street !== undefined) put('street', v.street); if (v.city !== undefined) put('city', v.city); if (v.zip !== undefined) put('zip', v.zip.slice(0, 5));
    if (v.preferred !== undefined) put('preferred_name', v.preferred); if (v.prefs !== undefined) put('prefs', JSON.stringify(v.prefs), '::jsonb');
    if (!sets.length) throw new HttpError(400, 'Nothing to change.');
    const r = await rows(ctx.db, API(ctx), `UPDATE app.members SET ${sets.join(', ')} WHERE id = $1 AND archived IS NULL RETURNING id, center, zone`, params);
    await audit(ctx, 'members', 'Member updated own record', Object.keys(v).join(', '), id);
    return { status: 200, body: r[0] };
  }),
  route('POST', /^\/member\/center-change$/, async (ctx) => {
    const id = needMember(ctx);
    const b = body(ctx); const reason = String(b.reason ?? '').trim();
    if (reason.length < 3) throw new HttpError(400, 'Say why you would like to belong to another masjid.');
    const to = await one<{ id: string }>(ctx.db, API(ctx), `SELECT id FROM app.centers WHERE active AND (code = $1 OR name = $1)`, [String(b.center ?? '')]);
    if (!to) throw new HttpError(400, 'Pick a masjid from the list.');
    const open = await one(ctx.db, API(ctx), `SELECT 1 FROM app.center_changes WHERE member_id = $1 AND status = 'pending'`, [id]);
    if (open) throw new HttpError(409, 'You already asked – the office will answer soon.');
    const r = await rows(ctx.db, API(ctx), `INSERT INTO app.center_changes (org_id, member_id, from_center, to_center, reason) SELECT $1::uuid, $2, center_id, $3::uuid, $4 FROM app.members WHERE id = $2 RETURNING id`, [ctx.orgId, id, to.id, reason]);
    return { status: 201, body: { id: (r[0] as { id: string }).id, status: 'pending' } };
  }),
];

/* ---------------- queues (rows in the admin's scope) ---------------- */
async function queueRows(ctx: Ctx) {
  const inMine = (r: { zone: string; center: string; zip: string }) => inScope(ctx.access, ctx.me, r.zone, r.center, r.zip);
  const pick = async (sql: string) => ((await rows(ctx.db, API(ctx), sql)) as { zone: string; center: string; zip: string }[]).filter(inMine);
  return {
    applications: await pick(`SELECT id, first_name, last_name, plan, applied_on::text, zone, center, zip FROM app.members WHERE status = 'pending' AND archived IS NULL ORDER BY applied_on`),
    id: await pick(`SELECT id, first_name, last_name, id_check, zone, center, zip FROM app.members WHERE id_check = 'pending' AND archived IS NULL ORDER BY sort_name`),
    center: await pick(`SELECT x.id, x.member_id, m.first_name, m.last_name, x.reason, x.created_at::text, c.name AS to_center, m.zone, m.center, m.zip FROM app.center_changes x JOIN app.members m ON m.org_id = x.org_id AND m.id = x.member_id JOIN app.centers c ON c.org_id = x.org_id AND c.id = x.to_center WHERE x.status = 'pending' ORDER BY x.created_at`),
    duplicates: await pick(`SELECT d.a, d.b, d.score, d.reasons, m.zone, m.center, m.zip FROM app.duplicate_pairs d JOIN app.members m ON m.org_id = d.org_id AND m.id = d.a WHERE d.status = 'open' ORDER BY d.score DESC`),
    payments: await pick(`SELECT p.id, p.member_id, p.year, p.amount_cents, p.status, m.zone, m.center, m.zip FROM app.payments p JOIN app.members m ON m.org_id = p.org_id AND m.id = p.member_id WHERE p.status IN ('failed', 'disputed') ORDER BY p.paid_on DESC`),
  };
}

async function importPlan(ctx: Ctx) {
  const b = body(ctx); const csv = String(b.csv ?? '');
  if (!csv.trim()) throw new HttpError(400, 'Paste or upload the spreadsheet (CSV).');
  if (csv.length > 5_000_000) throw new HttpError(413, 'The file is too large (5 MB). Split it.');
  const cfg = OrgConfigSchema.safeParse(await document(ctx.db, ctx.orgId, 'org-config'));
  const fields = (cfg.success ? cfg.data : mockOrgConfig).members.fields;
  const pl = (await plans(ctx)).map((p) => ({ id: p.id, name: p.name }));
  return planImport(csv, { fields, plans: pl, existing: await people(ctx), today: todayCT(), maxRows: 20000, preset: b.preset ? String(b.preset) : undefined, mapping: (b.mapping as Record<string, string | null>) ?? undefined });
}
export { roleOf };
