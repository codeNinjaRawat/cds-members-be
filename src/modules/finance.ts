/**
 * B4c Finance – the ledger (app.ledger) under the `finance-settings` document: funds with opening balances, approval
 * levels by role and amount, two signatures above a limit, a Board decision above another, Bylaws Art. XII Sec. 4 and
 * restricted-fund transfers. Rules: web/src/lib/community/finance.ts (rows are loaded into Tx shapes).
 *
 *   GET  /admin/finance/transactions?status=&kind=&center=&year=     (finance.view; masjid roles: their masjid)
 *   POST /admin/finance/transactions                                  expense / income / transfer / aid (finance.manage; a masjid's
 *                                                                     Finance Secretary or office enters for its own masjid with payments.record)
 *   POST /admin/finance/transactions/:id/approve | reject {note} | paid {ref, method?} | void {note}
 *   GET  /admin/finance/summary?center=                                fund balances, budget vs actual, months, statements due, warnings
 *   POST /admin/finance/statements {center, year, quarter, incomeCents, expenseCents}
 *   POST /admin/finance/post-donations {month}                         one income line per fund and masjid from Donations (idempotent)
 */
import { z } from 'zod';
import { one, rows, type Statement } from '../db/sql.js';
import { HttpError, audit, document, need, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { can, inScope, roleOf, type Permission } from '@/lib/community/access';
import * as T from '@/lib/community/finance';
import { donationSettings } from './giving.js';
import * as D from '@/lib/community/donations';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
const has = (ctx: Ctx, p: Permission) => !!ctx.me && can(ctx.access, ctx.me, p, todayCT());
const scoped = (ctx: Ctx) => { const r = roleOf(ctx.access, ctx.me); return !!(r?.centerScoped || r?.zoneScoped || r?.areaScoped); };

async function settings(ctx: Ctx): Promise<T.FinanceSettings> { const p = T.FinanceSettingsSchema.safeParse(await document(ctx.db, ctx.orgId, 'finance-settings')); return p.success ? p.data : T.mockFinanceSettings; }
async function zones(ctx: Ctx) { return new Map(((await rows(ctx.db, API(ctx), 'SELECT c.name, z.code FROM app.centers c JOIN app.zones z ON z.org_id = c.org_id AND z.id = c.zone_id')) as { name: string; code: string }[]).map((r) => [r.name, r.code])); }
const mine = (ctx: Ctx, z: Map<string, string>, center: string) => !scoped(ctx) || (!!center && inScope(ctx.access, ctx.me, z.get(center) ?? '', center));

const TX_SQL = `SELECT id, on_date::text AS date, kind, amount_cents::bigint AS "amountCents", coalesce(fund_id, '') AS fund, coalesce(to_fund_id, '') AS "toFund", center_name AS center, category, payee AS party, method, ref,
  coalesce(account_id, '') AS account, memo, source, status, created_by AS "enteredBy", approvals, board_decision AS "boardDecision", relief, decided_note AS note FROM app.ledger`;
async function load(ctx: Ctx, where = '', params: unknown[] = []): Promise<(T.Tx & { note: string })[]> {
  return ((await rows(ctx.db, API(ctx), `${TX_SQL} ${where}`, params)) as any[]).map((r) => ({ ...r, amountCents: Number(r.amountCents), source: (['manual', 'donations', 'zakat', 'dues'].includes(r.source) ? r.source : 'manual') }));
}
async function loadOne(ctx: Ctx, id: string) {
  const t = (await load(ctx, 'WHERE id = $1', [id]))[0]; if (!t) throw new HttpError(404, `No transaction ${id}.`);
  if (!mine(ctx, await zones(ctx), t.center)) throw new HttpError(404, `No transaction ${id}.`);
  return t;
}
/** The approver as the rules see them: the role of theirs with the highest approval limit (an admin may hold several). */
function actorOf(ctx: Ctx, s: T.FinanceSettings): T.Actor {
  const me = ctx.me!; const ids = [me.roleId, ...(me.more ?? []).map((m) => m.roleId)];
  const best = s.approval.levels.filter((l) => ids.includes(l.roleId)).sort((a, b) => b.upToCents - a.upToCents)[0];
  return { id: me.id, name: me.name, roleId: best?.roleId ?? me.roleId, centers: [...me.centers, ...(me.more ?? []).flatMap((m) => m.centers ?? [])] };
}
const insertTx = (ctx: Ctx, t: T.Tx): Statement => ({ sql: `INSERT INTO app.ledger (org_id, id, kind, fund_id, to_fund_id, account_id, center_name, amount_cents, on_date, payee, memo, category, source, source_ref, status, approvals, board_decision, created_by, method, ref, relief)
  VALUES ($1::uuid, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, $8::bigint, $9::date, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21::boolean)`,
  params: [ctx.orgId, t.id, t.kind, t.fund, t.toFund, t.account, t.center, t.amountCents, t.date, t.party, t.memo, t.category, t.source, (t as { sourceRef?: string }).sourceRef ?? '', t.status, JSON.stringify(t.approvals), t.boardDecision, t.enteredBy, t.method, t.ref, t.relief] });
async function nextId(ctx: Ctx, year: string) { return `TX-${year}-${String((await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, $2, 1)::text AS n`, [ctx.orgId, `tx-${year}`]))!.n).padStart(5, '0')}`; }

const TxIn = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), kind: z.enum(['income', 'expense', 'transfer', 'aid']), amountCents: z.number().int().min(1).max(10_000_000_000), fund: z.string().min(2), toFund: z.string().default(''),
  center: z.string().max(80).default(''), category: z.string().min(2), party: z.string().max(120).default(''), method: z.enum(['check', 'ach', 'card', 'cash', 'internal']).default('ach'), ref: z.string().max(40).default(''),
  account: z.string().max(40).default(''), memo: z.string().max(500).default(''), boardDecision: z.string().max(40).default(''), relief: z.boolean().default(false) });

export const FINANCE_ROUTES: Route[] = [
  route('GET', /^\/admin\/finance\/transactions$/, async (ctx) => {
    need(ctx, 'finance.view');
    const [s, z] = await Promise.all([settings(ctx), zones(ctx)]); const q = ctx.req.query; const year = q.get('year') ?? String(s.year);
    const all = await load(ctx, 'WHERE extract(year FROM on_date) = $1::int ORDER BY on_date DESC, id DESC', [year]);
    const list = all.filter((t) => mine(ctx, z, t.center) && (!q.get('status') || t.status === q.get('status')) && (!q.get('kind') || t.kind === q.get('kind')) && (q.get('center') === null || t.center === q.get('center')));
    const me = actorOf(ctx, s);
    return { status: 200, body: { count: list.length, transactions: list.map((t) => ({ ...t, next: T.nextStep(t, s), needs: T.approvalsNeeded(t, s), art12: T.art12(t, all), transfer: T.transferProblem(t, s), canApprove: t.status === 'pending' ? T.cannotApprove(t, me, s) : 'Not waiting for approval.' })) } };
  }),
  route('POST', /^\/admin\/finance\/transactions$/, async (ctx) => {
    const [s, z] = await Promise.all([settings(ctx), zones(ctx)]);
    const p = TxIn.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the transaction.', issues(p.error)); const b = p.data;
    if (!has(ctx, 'finance.manage')) {
      if (!has(ctx, 'payments.record') || !scoped(ctx)) need(ctx, 'finance.manage');
      if (!b.center || !mine(ctx, z, b.center)) throw new HttpError(403, `You enter transactions for ${ctx.me!.centers[0] ?? 'your masjid'} only.`);
      if (b.kind === 'transfer') throw new HttpError(403, 'Transfers between funds are for the Treasurer.');
    }
    if (b.center && !z.has(b.center)) throw new HttpError(422, `“${b.center}” is not a masjid.`);
    if (!s.funds.some((f) => f.id === b.fund)) throw new HttpError(422, `No fund “${b.fund}” in the finance settings.`);
    if (b.toFund && !s.funds.some((f) => f.id === b.toFund)) throw new HttpError(422, `No fund “${b.toFund}”.`);
    if (b.account && !s.accounts.some((a) => a.id === b.account && a.active)) throw new HttpError(422, 'Pick an active bank account.');
    if (b.date > todayCT()) throw new HttpError(422, 'The date is in the future.');
    const t: T.Tx = { ...b, id: await nextId(ctx, b.date.slice(0, 4)), source: 'manual', status: b.kind === 'income' ? 'received' : 'pending', enteredBy: ctx.me!.id, approvals: [] };
    const v = T.TxSchema.safeParse(t); if (!v.success) throw new HttpError(422, v.error.issues[0].message, issues(v.error));
    const tp = T.transferProblem(t, s); if (tp) throw new HttpError(422, tp);
    const all = await load(ctx, `WHERE kind = 'aid'`);
    const a12 = T.art12(t, all); if (a12.level !== 'none' && !t.boardDecision) throw new HttpError(422, `${a12.text} Link the Board decision first.`);
    await ctx.db.run(API(ctx), [insertTx(ctx, t)]);
    await audit(ctx, 'finance', 'Transaction entered', `${t.id} ${T.KIND[t.kind]} ${T.usd(t.amountCents)} ${t.party}`, t.id);
    return { status: 201, body: { transaction: t, next: T.nextStep(t, s), needs: T.approvalsNeeded(t, s) } };
  }),
  route('POST', /^\/admin\/finance\/transactions\/(TX-\d{4}-\d{4,6})\/(approve|reject|paid|void)$/, async (ctx, mm) => {
    const s = await settings(ctx); const t = await loadOne(ctx, mm[1]); const b = body(ctx); const note = String(b.note ?? '').trim().slice(0, 300);
    let next: T.Tx; let action = '';
    if (mm[2] === 'approve') {
      need(ctx, 'finance.view');
      try { next = T.approveTx(t, actorOf(ctx, s), s, new Date().toISOString()); } catch (e) { throw new HttpError(403, (e as Error).message); }
      action = next.status === 'approved' ? 'Approved' : `Approval ${next.approvals.length} of ${T.approvalsNeeded(t, s)}`;
    } else if (mm[2] === 'reject') {
      need(ctx, 'finance.view'); if (t.status !== 'pending') throw new HttpError(409, 'Only waiting transactions can be turned down.');
      if (T.cannotApprove(t, actorOf(ctx, s), s).startsWith('Your role')) throw new HttpError(403, 'Your role cannot decide payments.');
      if (note.length < 3) throw new HttpError(400, 'Say why.'); next = { ...t, status: 'rejected' }; action = 'Rejected';
    } else if (mm[2] === 'paid') {
      need(ctx, 'finance.manage'); if (t.status !== 'approved') throw new HttpError(409, t.status === 'pending' ? `Not approved yet (${T.nextStep(t, s)}).` : `This one is ${T.STATUS[t.status]}.`);
      const ref = String(b.ref ?? t.ref).trim().slice(0, 40); const method = (String(b.method ?? t.method)) as T.Tx['method'];
      if (method === 'check' && t.kind !== 'transfer' && !ref) throw new HttpError(400, 'Enter the check number.');
      next = { ...t, status: 'paid', ref, method }; action = 'Paid';
    } else {
      need(ctx, 'finance.manage'); if (t.status === 'void') throw new HttpError(409, 'Already void.');
      if (note.length < 3) throw new HttpError(400, 'Say why it is void.'); next = { ...t, status: 'void' }; action = 'Void';
    }
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.ledger SET status = $2, approvals = $3::jsonb, ref = $4, method = $5, decided_note = CASE WHEN $6 = '' THEN decided_note ELSE $6 END WHERE id = $1`, params: [t.id, next.status, JSON.stringify(next.approvals), next.ref, next.method, note] }]);
    await audit(ctx, 'finance', action, `${t.id} ${T.usd(t.amountCents)}${note ? ` – ${note}` : ''}`, t.id);
    return { status: 200, body: { id: t.id, status: next.status, approvals: next.approvals.length, next: T.nextStep(next, s) } };
  }),
  route('GET', /^\/admin\/finance\/summary$/, async (ctx) => {
    need(ctx, 'finance.view');
    const [s, z] = await Promise.all([settings(ctx), zones(ctx)]); const today = todayCT();
    const txs = (await load(ctx, 'WHERE extract(year FROM on_date) = $1::int', [s.year])).filter((t) => mine(ctx, z, t.center));
    const statements = ((await rows(ctx.db, API(ctx), `SELECT c.name AS center, split_part(s.period, '-Q', 1)::int AS year, split_part(s.period, '-Q', 2)::int AS quarter, s.received_on::text AS "submittedOn", s.submitted_by AS by FROM app.statements s JOIN app.centers c ON c.org_id = s.org_id AND c.id = s.center_id`)) as T.Statement[]);
    const centerList = Array.from(new Set([...s.budgets.map((b) => b.center), ...txs.map((t) => t.center)])).filter((c) => c && z.has(c) && mine(ctx, z, c));
    const center = ctx.req.query.get('center');
    return { status: 200, body: {
      year: s.year, balances: scoped(ctx) ? undefined : T.fundBalances(s, txs),
      budget: center !== null ? T.budgetVsActual(s, txs, center) : undefined,
      monthly: T.monthly(txs, s.year, center ?? undefined),
      statementsDue: T.statementsDue(scoped(ctx) ? ctx.me!.centers : centerList, statements, s.year, today),
      warnings: scoped(ctx) ? [] : T.financeWarnings(s, txs, statements, centerList, today),
      pending: txs.filter((t) => t.status === 'pending').length,
      statements: statements.filter((x) => !scoped(ctx) || mine(ctx, z, x.center)) } };   // the received statements (the admin's grid)
  }),
  route('POST', /^\/admin\/finance\/statements$/, async (ctx) => {
    const z = await zones(ctx); const b = body(ctx); const center = String(b.center ?? ''); const year = Number(b.year); const quarter = Number(b.quarter);
    if (!has(ctx, 'finance.manage')) { if (!has(ctx, 'payments.record')) need(ctx, 'finance.manage'); if (!mine(ctx, z, center)) throw new HttpError(403, 'Only your own masjid’s statement.'); }
    if (!z.has(center)) throw new HttpError(422, 'Pick the masjid.');
    if (!Number.isInteger(year) || ![1, 2, 3, 4].includes(quarter)) throw new HttpError(422, 'Year and quarter (1–4).');
    if (new Date(Date.UTC(year, quarter * 3, 0)).toISOString().slice(0, 10) >= todayCT()) throw new HttpError(422, 'That quarter has not ended yet.');
    const income = Math.max(0, Math.round(Number(b.incomeCents ?? 0))); const expense = Math.max(0, Math.round(Number(b.expenseCents ?? 0)));
    await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.statements (org_id, center_id, period, income_cents, expense_cents, file_ref, submitted_by) SELECT $1::uuid, c.id, $3, $4::bigint, $5::bigint, $6, $7 FROM app.centers c WHERE c.name = $2
      ON CONFLICT (org_id, center_id, period) DO UPDATE SET income_cents = EXCLUDED.income_cents, expense_cents = EXCLUDED.expense_cents, file_ref = EXCLUDED.file_ref, submitted_by = EXCLUDED.submitted_by, received_on = current_date`,
      params: [ctx.orgId, center, `${year}-Q${quarter}`, income, expense, String(b.fileRef ?? '').slice(0, 200), ctx.me!.name] }]);
    await audit(ctx, 'finance', 'Quarterly statement', `${center} ${year}-Q${quarter}`, center);
    return { status: 201, body: { center, period: `${year}-Q${quarter}` } };
  }),
  route('POST', /^\/admin\/finance\/post-donations$/, async (ctx) => {
    need(ctx, 'finance.manage');
    const month = String(body(ctx).month ?? ''); if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Month like 2026-10.');
    const [s, ds] = await Promise.all([settings(ctx), donationSettings(ctx)]);
    const sums = (await rows(ctx.db, API(ctx), `SELECT d.fund_id AS fund, coalesce(c.name, '') AS center, sum(d.amount_cents)::bigint AS cents, count(*)::int AS n FROM app.donations d LEFT JOIN app.centers c ON c.org_id = d.org_id AND c.id = d.center_id
      WHERE to_char(d.given_on, 'YYYY-MM') = $1 AND d.state IN ('ok', 'awaiting-payout') AND d.fund_id IS NOT NULL GROUP BY 1, 2`, [month])) as { fund: string; center: string; cents: string; n: number }[];
    let posted = 0, skipped = 0; const missing = new Set<string>();
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const date = last > todayCT() ? todayCT() : last;
    for (const r of sums) {
      if (!s.funds.some((f) => f.id === r.fund)) { missing.add(r.fund); continue; }
      const sourceRef = `${month}:${r.fund}:${r.center}`;
      if (await one(ctx.db, API(ctx), `SELECT 1 AS x FROM app.ledger WHERE source = 'donations' AND source_ref = $1`, [sourceRef])) { skipped++; continue; }
      const center = D.routedCenter({ fund: r.fund, center: r.center } as D.Donation, ds) === 'All centers' ? '' : D.routedCenter({ fund: r.fund, center: r.center } as D.Donation, ds);
      const t = { id: await nextId(ctx, month.slice(0, 4)), date, kind: 'income' as const, amountCents: Number(r.cents), fund: r.fund, toFund: '', center, category: 'donations', party: `Donations ${month} (${r.n} gifts)`, method: 'internal' as const, ref: '', account: '', memo: 'Posted from Donations', source: 'donations' as const, status: 'received' as const, enteredBy: ctx.me!.id, approvals: [], boardDecision: '', relief: false, sourceRef };
      await ctx.db.run(API(ctx), [insertTx(ctx, t)]); posted++;
    }
    await audit(ctx, 'finance', 'Donations posted', `${month}: ${posted} lines`, month);
    return { status: 200, body: { posted, skipped, fundsMissing: Array.from(missing) } };
  }),
];
