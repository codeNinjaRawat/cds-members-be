/**
 * B4d Zakat and Sadaqah. Rules: web/src/lib/community/zakat.ts (levels, response times, separation of duties) under the
 * `zakat-settings` document. The case lives in app.zakat_cases.spec; each step is also written to app.zakat_steps,
 * whose trigger refuses a second approval by the same person and a payout by anyone who approved it (so the rule holds
 * even if this code had a bug). Applicants' data is sensitive: zakat.view to see anything; masjid-limited roles see their
 * masjid's cases only; the website and the member portal get a reference and a plain status, never notes or approvers.
 *
 *   POST /public/zakat/applications          {applicant{name, phone, email, zip, household, monthlyIncomeCents}, category, reason, requestedCents, months?, urgent?, consent}
 *   GET  /member/zakat/applications          the member's own requests (status only)
 *   GET  /admin/zakat/cases?status=&center=&overdue=1 · GET /admin/zakat/cases/:id
 *   POST /admin/zakat/cases                  in-person intake (zakat.intake)
 *   POST /admin/zakat/cases/:id/checks       {documents, income, hardship, homeVisit?{on, note}}   (zakat.verify)
 *   POST /admin/zakat/cases/:id/request-info {note} · /decide {fund: zakat | sadaqah | none}
 *   POST /admin/zakat/cases/:id/approve      {amountCents, note, override?} · /return | /reject {note}
 *   POST /admin/zakat/cases/:id/pay          {method: transfer | check | cash, ref} → payout row + ledger line (zakat.disburse)
 *   POST /admin/zakat/cases/:id/notes {text} · /assign {coordinator}
 */
import { z } from 'zod';
import { one, rows, type Statement } from '../db/sql.js';
import { HttpError, PLATFORM, audit, document, need, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { can, inScope, roleOf, zakatLevelOf } from '@/lib/community/access';
import * as Z from '@/lib/community/zakat';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
const nowIso = () => new Date().toISOString();

async function settings(ctx: Ctx): Promise<Z.ZakatSettings> { const p = Z.ZakatSettingsSchema.safeParse(await document(ctx.db, ctx.orgId, 'zakat-settings')); return p.success ? p.data : Z.mockZakatSettings; }
const actor = (ctx: Ctx): Z.Actor => ({ id: ctx.me!.id, name: ctx.me!.name, level: zakatLevelOf(ctx.access, ctx.me, todayCT()), can: (p: string) => can(ctx.access, ctx.me, p as never, todayCT()) });
const scoped = (ctx: Ctx) => { const r = roleOf(ctx.access, ctx.me); return !!(r?.centerScoped || r?.zoneScoped || r?.areaScoped); };
const visible = (ctx: Ctx, c: Z.ZakatCase) => !scoped(ctx) || (!!c.center && inScope(ctx.access, ctx.me, c.zone, c.center));

async function loadCase(ctx: Ctx, id: string): Promise<Z.ZakatCase> {
  need(ctx, 'zakat.view');
  const r = await one<{ spec: Z.ZakatCase }>(ctx.db, API(ctx), 'SELECT spec FROM app.zakat_cases WHERE id = $1', [id]);
  if (!r || !visible(ctx, r.spec)) throw new HttpError(404, `No case ${id}.`);   // never confirm a case outside your masjid exists
  return r.spec;
}
/** Write the case back: the spec, the columns the queue uses, and the step (the trigger checks the duties). */
function saveCase(ctx: Ctx, c: Z.ZakatCase, s: Z.ZakatSettings, step: { action: string; level?: number | null; amountCents?: number | null; note?: string }): Statement[] {
  const total = c.requestedCents * c.months;
  return [
    { sql: `UPDATE app.zakat_cases SET spec = $2::jsonb, status = $3, fund = $4, urgent = $5::boolean, level_needed = $6::smallint, approved_cents = NULLIF($7, '')::bigint, checks = $8::jsonb, home_visit = NULLIF($9, 'null')::jsonb, due_at = $10::timestamptz, coordinator = $11 WHERE id = $1`,
      params: [c.id, JSON.stringify(c), c.status, c.fund || 'undecided', c.urgent, Math.min(3, Z.levelFor(total, s)), Z.liveApprovals(c).length ? String(Z.totalOf(c)) : '', JSON.stringify(c.checks), JSON.stringify(c.homeVisit), Z.dueAt(c, s), c.coordinator] },
    { sql: `INSERT INTO app.zakat_steps (org_id, case_id, by, admin_id, action, level, amount_cents, note) VALUES ($1::uuid, $2, $3, $4, $5, NULLIF($6, '')::smallint, NULLIF($7, '')::bigint, $8)`,
      params: [ctx.orgId, c.id, ctx.me?.name ?? 'Applicant', ctx.me?.id ?? '', step.action, step.level ? String(step.level) : '', step.amountCents ? String(step.amountCents) : '', (step.note ?? '').slice(0, 2000)] },
  ];
}
async function run(ctx: Ctx, st: Statement[]) {
  try { await ctx.db.run(API(ctx), st); } catch (e) {
    const m = String((e as Error).message);
    if (m.includes('already approved')) throw new HttpError(403, 'You already approved this case – another person approves the next step.');
    if (m.includes('cannot pay it out')) throw new HttpError(403, 'You approved this case, so someone else pays it out.');
    throw e;
  }
}
async function place(ctx: Ctx, zip: string) {
  const h = await one<{ zone: string; center: string; why: string }>(ctx.db, API(ctx), `SELECT coalesce(z.code, '') AS zone, coalesce(c.name, '') AS center, h.why FROM app.home_for_zip($1) h LEFT JOIN app.zones z ON z.org_id = app.current_org() AND z.id = h.zone_id LEFT JOIN app.centers c ON c.org_id = app.current_org() AND c.id = h.center_id`, [zip]);
  return h ?? { zone: '', center: '', why: 'Unknown ZIP.' };
}
async function newCaseId(ctx: Ctx) { const y = todayCT().slice(0, 4); return `ZKT-${y}-${String((await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, $2, 1)::text AS n`, [ctx.orgId, `zakat-${y}`]))!.n).padStart(3, '0')}`; }

const Apply = z.object({
  applicant: z.object({ name: z.string().trim().min(2).max(80), phone: z.string().max(20).default(''), email: z.union([z.literal(''), z.string().trim().toLowerCase().email().max(120)]).default(''), zip: z.string().regex(/^\d{5}$/, 'A ZIP code has 5 digits.'),
    household: z.number().int().min(1).max(20), monthlyIncomeCents: z.number().int().min(0).max(10_000_000) }),
  category: z.enum(Object.keys(Z.CATEGORIES) as [Z.Category, ...Z.Category[]]), reason: z.string().trim().min(10).max(2000), requestedCents: z.number().int().min(100).max(10_000_000), months: z.number().int().min(1).max(12).default(1),
  urgent: z.boolean().default(false), consent: z.literal(true, { errorMap: () => ({ message: 'Agree that we may check what you tell us.' }) }) });

async function intake(ctx: Ctx, raw: unknown, channel: Z.ZakatCase['channel']) {
  const p = Apply.safeParse(raw); if (!p.success) throw new HttpError(422, 'Some answers need a look.', issues(p.error));
  const b = p.data; const s = await settings(ctx);
  if (!b.applicant.email && !b.applicant.phone) throw new HttpError(422, 'Give a phone number or an email so the coordinator can reach you.');
  const where = await place(ctx, b.applicant.zip);
  const now = nowIso();
  const c: Z.ZakatCase = { id: await newCaseId(ctx), createdAt: now, channel, urgent: b.urgent, applicant: { ...b.applicant, memberId: ctx.memberId ?? undefined }, category: b.category, reason: b.reason, requestedCents: b.requestedCents, months: b.months,
    zone: where.zone, center: where.center, coordinator: '', status: 'new', stepSince: now, fund: '', checks: { documents: false, income: false, hardship: false }, homeVisit: null, approvals: [], payouts: [], notes: where.why ? [{ at: now, byName: 'System', text: where.why }] : [] };
  const problems = Z.intakeProblems(c, s); if (problems.length) throw new HttpError(422, problems[0], problems);
  // one open request at a time per person (email or phone)
  const open = await one<{ id: string }>(ctx.db, API(ctx), `SELECT id FROM app.zakat_cases WHERE status NOT IN ('paid', 'rejected', 'closed') AND ((email <> '' AND email = $1) OR (phone <> '' AND phone = $2)) LIMIT 1`, [b.applicant.email, b.applicant.phone]);
  if (open) throw new HttpError(409, `You already have an open request (${open.id}) – the coordinator will contact you.`);
  // the coordinator of the masjid, when there is one
  const coord = ctx.access.admins.find((a) => a.status === 'active' && a.roleId === 'zakat-coordinator' && a.centers.includes(c.center));
  if (coord) c.coordinator = coord.id;
  await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.zakat_cases (org_id, id, applicant_name, email, phone, zip, member_id, zone_id, center_id, household_size, monthly_income_cents, need, story, urgent, requested_cents, months, channel, status, spec, created_by, consent_at, coordinator, due_at)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, NULLIF($7, ''), (SELECT id FROM app.zones WHERE code = $8), (SELECT id FROM app.centers WHERE name = $9), $10::smallint, $11::bigint, $12, $13, $14::boolean, $15::bigint, $16::smallint, $17, 'new', $18::jsonb, $19, now(), $20, $21::timestamptz)`,
    params: [ctx.orgId, c.id, b.applicant.name, b.applicant.email, b.applicant.phone, b.applicant.zip, ctx.memberId ?? '', c.zone, c.center, b.applicant.household, b.applicant.monthlyIncomeCents, b.category, b.reason, b.urgent, b.requestedCents, b.months, channel, JSON.stringify(c), ctx.me?.name ?? 'Website', c.coordinator, Z.dueAt(c, s)] },
    { sql: `INSERT INTO app.zakat_steps (org_id, case_id, by, admin_id, action, amount_cents, note) VALUES ($1::uuid, $2, $3, $4, 'intake', $5::bigint, $6)`, params: [ctx.orgId, c.id, ctx.me?.name ?? 'Applicant', ctx.me?.id ?? '', b.requestedCents * b.months, `${channel}${c.center ? ` → ${c.center}` : ' – no masjid for this ZIP'}`] }]);
  if (b.applicant.email) await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, 'zakat-received')`,
    params: [ctx.orgId, b.applicant.email, `We received your request ${c.id}`, `Assalamu alaikum ${b.applicant.name.split(' ')[0]},\n\nWe have your request (${c.id}). ${c.center ? `The Zakat coordinator at ${c.center}` : 'Our Zakat office'} will contact you${b.urgent ? ' as soon as possible' : ' within a few days'}. Your information is kept private.`] }]);
  if (c.coordinator) await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.notices (org_id, admin_id, kind, title, link) VALUES ($1::uuid, $2, 'assignment', $3, $4)`, params: [ctx.orgId, c.coordinator, `New ${b.urgent ? 'URGENT ' : ''}Zakat request ${c.id}`, `/zakat?case=${c.id}`] }]);
  return c;
}
const view = (ctx: Ctx, c: Z.ZakatCase, s: Z.ZakatSettings, now: string) => {
  const a = actor(ctx);
  return { ...c, actions: Z.actionsFor(c, a, s), blocked: Z.blockedReason(c, a, s), dueAt: Z.dueAt(c, s), overdue: Z.isOverdue(c, s, now), nextLevel: Z.nextLevel(c, s), totalCents: Z.totalOf(c), paidCents: Z.paidCents(c), needsLevel: Z.levelFor(Z.totalOf(c), s) };
};

export const ZAKAT_ROUTES: Route[] = [
  route('POST', /^\/public\/zakat\/applications$/, async (ctx) => {
    const b = body(ctx); if (typeof b.website === 'string' && b.website) return { status: 202, body: { reference: 'ZKT-0000-000' } };
    const c = await intake(ctx, b, String(ctx.req.headers['x-client'] ?? '') === 'app' ? 'app' : 'website');
    return { status: 201, body: { reference: c.id, center: c.center || null, status: Z.STATUS[c.status] } };
  }),
  route('GET', /^\/member\/zakat\/applications$/, async (ctx) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const list = (await rows(ctx.db, API(ctx), 'SELECT spec FROM app.zakat_cases WHERE member_id = $1 ORDER BY created_at DESC', [ctx.memberId])) as { spec: Z.ZakatCase }[];
    // plain status only: no notes, no approvers, no amounts decided
    return { status: 200, body: { requests: list.map(({ spec: c }) => ({ id: c.id, createdAt: c.createdAt, category: Z.CATEGORIES[c.category], status: ['verifying', 'awaiting-approval'].includes(c.status) ? 'Being reviewed' : Z.STATUS[c.status], center: c.center, needsYou: c.status === 'info-requested' })) } };
  }),
  route('GET', /^\/admin\/zakat\/cases$/, async (ctx) => {
    need(ctx, 'zakat.view');
    const s = await settings(ctx); const now = nowIso(); const q = ctx.req.query;
    const all = ((await rows(ctx.db, API(ctx), 'SELECT spec FROM app.zakat_cases ORDER BY urgent DESC, due_at NULLS LAST, created_at')) as { spec: Z.ZakatCase }[]).map((r) => r.spec).filter((c) => visible(ctx, c));
    const list = all.filter((c) => (!q.get('status') || c.status === q.get('status')) && (!q.get('center') || c.center === q.get('center')) && (!q.get('overdue') || Z.isOverdue(c, s, now)) && (!q.get('mine') || Z.actionsFor(c, actor(ctx), s).length > 0));
    return { status: 200, body: { stats: Z.zakatStats(all, s, now), count: list.length, cases: list.map((c) => view(ctx, c, s, now)) } };
  }),
  route('GET', /^\/admin\/zakat\/cases\/(ZKT-\d{4}-\d{3,5})$/, async (ctx, mm) => {
    const c = await loadCase(ctx, mm[1]); const s = await settings(ctx);
    const steps = await rows(ctx.db, API(ctx), `SELECT at::text, by, action, level, amount_cents::int AS "amountCents", note FROM app.zakat_steps WHERE case_id = $1 ORDER BY id`, [c.id]);
    await audit(ctx, 'zakat', 'Case opened', c.id, c.id);   // who looked at a sensitive record
    return { status: 200, body: { case: view(ctx, c, s, nowIso()), steps } };
  }),
  route('POST', /^\/admin\/zakat\/cases$/, async (ctx) => {
    need(ctx, 'zakat.intake');
    const c = await intake(ctx, { ...body(ctx), consent: true }, 'in-person');
    await audit(ctx, 'zakat', 'Case taken in person', c.id, c.id);
    if (scoped(ctx) && !visible(ctx, c)) return { status: 201, body: { reference: c.id, note: `Saved – the ZIP belongs to ${c.center || 'no masjid of yours'}, so its coordinator has it now.` } };
    return { status: 201, body: { case: view(ctx, c, await settings(ctx), nowIso()) } };
  }),
  route('POST', /^\/admin\/zakat\/cases\/(ZKT-\d{4}-\d{3,5})\/(checks|request-info|decide|approve|return|reject|pay|notes|assign)$/, async (ctx, mm) => {
    let c = await loadCase(ctx, mm[1]); const s = await settings(ctx); const b = body(ctx); const now = nowIso(); const a = actor(ctx);
    const note = String(b.note ?? b.text ?? '').trim();
    let step: Parameters<typeof saveCase>[3]; const extra: Statement[] = []; let mail = '';
    try {
      switch (mm[2]) {
        case 'checks': {
          need(ctx, 'zakat.verify'); if (!['new', 'verifying', 'info-requested'].includes(c.status)) throw new HttpError(409, 'Checks are done before the decision.');
          const P = z.object({ documents: z.boolean().optional(), income: z.boolean().optional(), hardship: z.boolean().optional(), homeVisit: z.object({ on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(1000).default('') }).nullable().optional() }).strict();
          const p = P.safeParse(b); if (!p.success) throw new HttpError(400, 'Check the checks.', issues(p.error));
          c = { ...c, status: 'verifying', stepSince: c.status === 'verifying' ? c.stepSince : now, checks: { documents: p.data.documents ?? c.checks.documents, income: p.data.income ?? c.checks.income, hardship: p.data.hardship ?? c.checks.hardship },
            homeVisit: p.data.homeVisit === undefined ? c.homeVisit : p.data.homeVisit && { on: p.data.homeVisit.on, by: a.name, note: p.data.homeVisit.note } };
          step = { action: p.data.homeVisit ? 'home-visit' : 'check', note: Object.entries(c.checks).filter(([, v]) => v).map(([k]) => k).join(', ') };
          break;
        }
        case 'request-info': {
          need(ctx, 'zakat.verify'); if (!['new', 'verifying'].includes(c.status)) throw new HttpError(409, 'Ask for information while verifying.');
          if (note.length < 5) throw new HttpError(400, 'Say what is needed – the applicant reads it.');
          c = { ...c, status: 'info-requested', stepSince: now, notes: [...c.notes, { at: now, byName: a.name, text: `Asked the applicant: ${note}` }] };
          step = { action: 'request-info', note }; mail = `To continue your request ${c.id} we need: ${note}\n\nPlease reply to this email or call the office.`;
          break;
        }
        case 'decide': {
          need(ctx, 'zakat.verify'); const fund = String(b.fund ?? '') as 'zakat' | 'sadaqah' | 'none';
          if (!['zakat', 'sadaqah', 'none'].includes(fund)) throw new HttpError(400, 'Decide: zakat, sadaqah or none.');
          if (!['new', 'verifying', 'info-requested'].includes(c.status)) throw new HttpError(409, 'Already decided.');
          if (fund !== 'none') { const vp = Z.verifyProblems(c, s); if (vp.length) throw new HttpError(409, vp[0], vp); }
          c = Z.decideEligibility(c, fund, s, now, a.name); step = { action: 'decide', note: fund === 'none' ? `Not eligible${note ? `: ${note}` : ''}` : `Eligible for ${fund}` };
          if (fund === 'none') mail = `We are sorry – your request ${c.id} could not be approved. You may ask the office about other help.`;
          break;
        }
        case 'approve': {
          const amount = Math.round(Number(b.amountCents ?? Z.amountOf(c))); const override = !!b.override;
          c = Z.approve(c, a, s, now, amount, note, override);
          step = { action: override ? 'override' : 'approve', level: override ? 3 : a.level, amountCents: amount, note };
          if (c.status === 'approved') extra.push(...ctx.access.admins.filter((x) => x.status === 'active' && x.roleId === 'zakat-operations').map((x) => ({ sql: `INSERT INTO app.notices (org_id, admin_id, kind, title, link) VALUES ($1::uuid, $2, 'approval', $3, $4)`, params: [ctx.orgId, x.id, `Approved – to pay: ${c.id} (${Z.usd(Z.totalOf(c))})`, `/zakat?case=${c.id}`] })));
          break;
        }
        case 'return': case 'reject': {
          c = Z.decline(c, a, s, now, mm[2], note); step = { action: mm[2], level: Z.nextLevel(c, s), note };
          if (mm[2] === 'reject') mail = `We are sorry – your request ${c.id} could not be approved.`;
          break;
        }
        case 'pay': {
          const method = String(b.method ?? '') as 'transfer' | 'check' | 'cash'; if (!['transfer', 'check', 'cash'].includes(method)) throw new HttpError(400, 'How is it paid: transfer, check or cash?');
          const ref = String(b.ref ?? '').trim().slice(0, 60);
          const monthNo = c.payouts.length + 1;
          c = Z.pay(c, a, s, now, method, ref); const amt = Z.amountOf(c);
          step = { action: 'pay', amountCents: amt, note: `Month ${monthNo} of ${c.months} · ${method}${ref ? ` ${ref}` : ''}` };
          extra.push({ sql: `INSERT INTO app.zakat_payouts (org_id, case_id, month_no, amount_cents, method, ref, paid_by, paid_by_id) VALUES ($1::uuid, $2, $3::smallint, $4::bigint, $5, $6, $7, $8)`, params: [ctx.orgId, c.id, monthNo, amt, method, ref, a.name, a.id] });
          // the money leaves the Zakat (or Sadaqah) fund in the ledger – approved here, so no second approval there
          extra.push({ sql: `INSERT INTO app.ledger (org_id, id, kind, fund_id, center_name, amount_cents, on_date, payee, memo, category, source, source_ref, status, method, ref, created_by)
            VALUES ($1::uuid, 'TX-' || to_char(current_date, 'YYYY') || '-' || lpad(app.next_no($1::uuid, 'tx-' || to_char(current_date, 'YYYY'), 1)::text, 5, '0'), 'expense', $2, $3, $4::bigint, current_date, 'Zakat case ' || $5::text, $6, $7, 'zakat', $5::text || ':' || $8::text, 'paid', $9, $10, $11)`,
            params: [ctx.orgId, c.fund || 'zakat', c.center, amt, c.id, `Month ${monthNo} of ${c.months}`, c.fund === 'sadaqah' ? 'aid' : 'zakat-aid', String(monthNo), method === 'transfer' ? 'ach' : method, ref, a.id] });
          break;
        }
        case 'notes': {
          need(ctx, 'zakat.view'); if (note.length < 2 || note.length > 2000) throw new HttpError(400, 'Write the note.');
          c = { ...c, notes: [...c.notes, { at: now, byName: a.name, text: note }] }; step = { action: 'note', note };
          break;
        }
        default: {
          need(ctx, 'zakat.verify'); const who = String(b.coordinator ?? '');
          const adm = ctx.access.admins.find((x) => x.id === who && x.status === 'active'); if (!adm || !can(ctx.access, adm, 'zakat.verify', todayCT())) throw new HttpError(400, 'The coordinator must be an active admin who verifies cases.');
          c = { ...c, coordinator: who }; step = { action: 'note', note: `Assigned to ${adm.name}` };
          extra.push({ sql: `INSERT INTO app.notices (org_id, admin_id, kind, title, link) VALUES ($1::uuid, $2, 'assignment', $3, $4)`, params: [ctx.orgId, who, `Zakat case ${c.id} is yours`, `/zakat?case=${c.id}`] });
        }
      }
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(403, (e as Error).message); }
    await run(ctx, [...saveCase(ctx, c, s, step), ...extra]);
    if (mail && c.applicant.email) await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, 'zakat-update')`, params: [ctx.orgId, c.applicant.email, `Your request ${c.id}`, `Assalamu alaikum ${c.applicant.name.split(' ')[0]},\n\n${mail}`] }]);
    await audit(ctx, 'zakat', `Case ${mm[2]}`, `${c.id} → ${Z.STATUS[c.status]}`, c.id);
    return { status: 200, body: { case: view(ctx, c, s, now) } };
  }),
];
