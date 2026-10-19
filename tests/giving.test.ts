/**
 * B4c Giving, fundraising and finance – black-box over HTTP on a migrated + seeded database.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/giving.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, who: string | { cookie: string } = 'owner') => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof who === 'string') { if (who) h['x-admin'] = who; } else h.cookie = who.cookie;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(db, OWNER, sql, p))!.n;
const SE1 = 'Southeast Islamic Center 1', N1 = 'North Islamic Center 1';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

/* projections */
ok(await n(`SELECT count(*)::int AS n FROM app.campaigns WHERE status = 'live'`) >= 3, 'campaigns from the fundraising document');
ok(await n(`SELECT count(*)::int AS n FROM app.campaign_pages`) >= 3, 'personal pages too');

/* cash and checks at a masjid */
const cash = await call('POST', '/admin/donations', { amountCents: 5000, platform: 'cash', fund: 'general', center: SE1, name: 'Bilal Haddad', email: 'bilal.g@example.org' }, 'fs-se1');
ok(cash.status === 201 && /^D-\d+$/.test(cash.body.donation.id) && cash.body.donation.state === 'matched', 'cash gift entered and matched', cash.body);
ok(cash.body.donation.checkomatic.qualifies === true, 'a $50 General gift qualifies for Check-o-matic (application mode)');
ok((await call('POST', '/admin/donations', { amountCents: 5000, platform: 'check', fund: 'general', center: SE1, name: 'No Number' }, 'fs-se1')).status === 422, 'a check needs its number');
ok((await call('POST', '/admin/donations', { amountCents: 5000, platform: 'cash', fund: 'general', center: N1, name: 'Elsewhere' }, 'fs-se1')).status === 403, 'only for their own masjid');
ok((await call('POST', '/admin/donations', { amountCents: 5000, platform: 'cash', fund: 'nope', center: SE1, name: 'Bad Fund' }, 'fs-se1')).status === 422, 'fund must be active');
ok((await call('POST', '/admin/donations', { amountCents: 5000, platform: 'cash', fund: 'general', center: SE1, name: 'Web' }, 'web-editor')).status === 403, 'website editor cannot record gifts');
const big = await call('POST', '/admin/donations', { amountCents: 50000, platform: 'check', ref: '2231', fund: 'building', center: SE1, name: 'Maryam Siddiqui', email: 'maryam.s@example.org', givenOn: '2026-10-10' }, 'fs-se1');
ok(big.status === 201 && big.body.donation.needsReceipt === true, '$500 check → written receipt due', big.body);
ok((await call('POST', '/admin/donations', { amountCents: 5000, platform: 'cash', fund: 'general', center: SE1, name: 'Future', givenOn: '2099-01-01' }, 'fs-se1')).status === 422, 'no gifts from the future');

/* platform sync: idempotent, reconcile, deposit */
const imp = { platform: 'stripe', gifts: [
  { ref: 'ch_1', at: '2026-10-12', amountCents: 10000, feeCents: 320, name: 'Hana Ali', email: 'hana.g@example.org', fund: 'sadaqah', center: N1 },
  { ref: 'ch_2', at: '2026-10-12', amountCents: 2500, feeCents: 103, name: '', email: '' },
  { ref: 'ch_3', at: '2026-10-13', amountCents: 25000, feeCents: 755, name: 'Omar K.', email: 'omar.k@example.org', campaignId: 'expansion-phase-2', pageId: 'aisha-runs-for-the-masjid' } ] };
const i1 = await call('POST', '/admin/donations/import', imp, 'treasurer');
ok(i1.status === 200 && i1.body.added === 3, 'three platform gifts imported', i1.body);
const i2 = await call('POST', '/admin/donations/import', { ...imp, gifts: [...imp.gifts.slice(0, 2), { ...imp.gifts[2], refunded: false }] }, 'treasurer');
ok(i2.body.added === 0 && i2.body.skipped === 3, 'the same sync twice adds nothing', i2.body);
ok((await call('POST', '/admin/donations/import', { platform: 'bloomerang', gifts: imp.gifts }, 'treasurer')).status === 409, 'a platform switched off is refused');
const list = await call('GET', '/admin/donations?state=unmatched', undefined, 'treasurer');
const unknown = list.body.donations.find((d: any) => d.ref === 'ch_2');
ok(!!unknown && unknown.state === 'unmatched', 'unknown donor and fund → needs reconciling', list.body.stats);
const fix = await call('PATCH', `/admin/donations/${unknown.id}`, { fund: 'general', center: N1, donor: { name: 'Kiosk donor', anonymous: true } }, 'treasurer');
ok(fix.status === 200 && fix.body.donation.state === 'pending', 'reconciled – now waiting for the deposit', fix.body);
const camp = (await call('GET', '/admin/donations?campaign=expansion-phase-2', undefined, 'treasurer')).body.donations[0];
ok(camp && camp.fund === 'building', 'a campaign gift goes to the campaign’s fund', camp);
const zk = await call('POST', '/admin/donations', { amountCents: 10000, platform: 'cash', fund: 'zakat', center: SE1, name: 'Zakat Giver' }, 'fs-se1');
ok((await call('PATCH', `/admin/donations/${zk.body.donation.id}`, { fund: 'general' }, 'treasurer')).status === 409, 'Zakat stays Zakat');
const po = await call('POST', '/admin/payouts', { platform: 'stripe', id: 'po_1', amountCents: 10000 - 320 + 2500 - 103 + 25000 - 755, arrivedOn: '2026-10-15', refs: ['ch_1', 'ch_2', 'ch_3'] }, 'treasurer');
ok(po.status === 200 && po.body.matched === true && po.body.differenceCents === 0, 'deposit matches its gifts to the cent', po.body);
ok(await n(`SELECT count(*)::int AS n FROM app.donations WHERE payout_id = 'po_1' AND state = 'ok'`) === 3, 'gifts in the deposit are matched');
const po2 = await call('POST', '/admin/payouts', { platform: 'stripe', id: 'po_2', amountCents: 999, arrivedOn: '2026-10-16', refs: ['ch_9'] }, 'treasurer');
ok(po2.body.matched === false && po2.body.missing.includes('ch_9'), 'a deposit with an unknown gift is flagged', po2.body);

/* receipts, refunds, Check-o-matic, scope */
const rc = await call('POST', `/admin/donations/${big.body.donation.id}/receipt`, {}, 'fs-se1');
ok(rc.status === 200 && rc.body.sent === 1, 'receipt sent');
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'maryam.s@example.org' AND kind = 'donation-receipt' AND body LIKE '%No goods or services%'`) === 1, 'the receipt carries the IRS sentence');
ok(await n(`SELECT count(*)::int AS n FROM app.donations WHERE id = $1 AND receipt_no ~ '^R-2026-\\d{5}$'`, [big.body.donation.id]) === 1, 'receipt number R-2026-…');
ok((await call('POST', `/admin/donations/${unknown.id}/receipt`, {}, 'treasurer')).status === 409, 'anonymous → no email receipt');
ok((await call('POST', `/admin/donations/${cash.body.donation.id}/refund`, { reason: 'Entered twice' }, 'fs-se1')).status === 403, 'refunds need payments.refund');
const rf = await call('POST', `/admin/donations/${cash.body.donation.id}/refund`, { reason: 'Entered twice' }, 'treasurer');
ok(rf.status === 200 && rf.body.refunded, 'treasurer refunds');
ok((await call('POST', `/admin/donations/${cash.body.donation.id}/refund`, { reason: 'again' }, 'treasurer')).status === 409, 'not twice');
const co = await call('GET', '/admin/donations/checkomatic', undefined, 'treasurer');
ok(co.status === 200 && co.body.mode === 'application' && !co.body.donors.some((d: any) => d.email === 'bilal.g@example.org'), 'a refunded gift no longer qualifies', co.body);
const seView = await call('GET', '/admin/donations', undefined, 'fs-se1');
ok(seView.body.donations.every((d: any) => d.center === SE1), 'a masjid’s Finance Secretary sees its own gifts only');

/* fundraising */
const pubC = await call('GET', '/public/campaigns', undefined, '');
const exp = pubC.body.campaigns.find((c: any) => c.id === 'expansion-phase-2');
ok(pubC.status === 200 && exp && exp.totalCents >= 25000, `campaign total from real gifts (${exp?.totalCents})`, exp);
ok(!JSON.stringify(pubC.body).includes('omar.k@example.org') && !JSON.stringify(pubC.body).includes('25000,"name"'), 'no emails or amounts with names in public');
ok(exp.pages.find((p: any) => p.id === 'aisha-runs-for-the-masjid')?.totalCents === 25000, 'the personal page counts its gift');
ok(!pubC.body.campaigns.some((c: any) => c.state === 'draft'), 'no drafts');
const mem = await one<{ id: string; email: string }>(db, OWNER, `SELECT m.id, m.email FROM app.members m WHERE m.status = 'active' AND m.archived IS NULL AND m.email <> '' AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY m.id LIMIT 1 OFFSET 11`);
const st = await call('POST', '/auth/code/start', { address: mem!.email }, '');
const vr = await fetch(base + '/auth/code/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: mem!.email, code: st.body.devCode }) });
const jar = { cookie: (vr.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)![0] };
ok((await call('POST', '/member/campaigns/expansion-phase-2/pages', { title: 'Tiny', goalCents: 100 }, jar)).status === 422, 'page goal below the campaign minimum');
const pg = await call('POST', '/member/campaigns/expansion-phase-2/pages', { title: 'My Quran khatm for the masjid', story: 'One gift per juz.', goalCents: 60000 }, jar);
ok(pg.status === 201 && pg.body.waitsForApproval === true, 'member page waits for approval', pg.body);
ok((await call('POST', '/member/campaigns/expansion-phase-2/pages', { title: 'Second page', goalCents: 60000 }, jar)).status === 409, 'one page per member per campaign');
ok((await call('POST', '/member/campaigns/zakat-winter-2026/pages', { title: 'Zakat page', goalCents: 60000 }, jar)).status === 409, 'campaigns without personal pages refuse');
ok(!(await call('GET', '/public/campaigns/expansion-phase-2', undefined, '')).body.campaign.pages.some((p: any) => p.id === pg.body.page.id), 'not public before approval');
ok((await call('POST', `/admin/fundraising/pages/${pg.body.page.id}/decision`, { decision: 'reject' }, 'treasurer')).status === 400, 'a rejection needs a reason');
ok((await call('POST', `/admin/fundraising/pages/${pg.body.page.id}/decision`, { decision: 'approve' }, 'treasurer')).status === 200, 'approved');
ok((await call('GET', '/public/campaigns/expansion-phase-2', undefined, '')).body.campaign.pages.some((p: any) => p.id === pg.body.page.id), 'now on the campaign page');
ok(await n(`SELECT count(*)::int AS n FROM app.campaign_pages WHERE id = $1 AND status = 'approved'`, [pg.body.page.id]) === 1, 'projected');
const pl = await call('POST', '/admin/pledges', { campaignId: 'expansion-phase-2', name: 'Maryam Siddiqui', email: 'maryam.s@example.org', totalCents: 100000, dueBy: '2026-12-31' }, 'treasurer');
ok(pl.status === 201 && /^P-\d+$/.test(pl.body.id), 'pledge recorded', pl.body);
await call('POST', '/admin/donations', { amountCents: 60000, platform: 'check', ref: '2240', fund: 'general', center: SE1, name: 'Maryam Siddiqui', email: 'maryam.s@example.org', campaignId: 'expansion-phase-2', pledge: pl.body.id }, 'fs-se1');
let pls = (await call('GET', '/admin/pledges?campaign=expansion-phase-2', undefined, 'treasurer')).body.pledges.find((p: any) => p.id === pl.body.id);
ok(pls.paidCents === 60000 && pls.leftCents === 40000 && !pls.done, 'pledge partly paid', pls);
await call('POST', '/admin/donations', { amountCents: 40000, platform: 'cash', fund: 'general', center: SE1, name: 'Maryam Siddiqui', email: 'maryam.s@example.org', campaignId: 'expansion-phase-2', pledge: pl.body.id }, 'fs-se1');
ok(await n(`SELECT count(*)::int AS n FROM app.pledges WHERE ref = $1 AND status = 'fulfilled'`, [pl.body.id]) === 1, 'paid in full → fulfilled');
const fr = await call('GET', '/admin/fundraising', undefined, 'treasurer');
const fe = fr.body.campaigns.find((c: any) => c.id === 'expansion-phase-2');
ok(fr.status === 200 && fe.progress.givenCents === 125000 && fe.matching.length === 1 && Array.isArray(fr.body.warnings) && typeof fr.body.insights.donors === 'number', 'admin view: progress, matching, warnings, insights', fe?.progress);

/* member giving history */
const mg = await call('GET', '/member/giving', undefined, jar);
ok(mg.status === 200 && Array.isArray(mg.body.gifts), 'member giving page');
ok((await call('GET', '/member/giving', undefined, '')).status === 401, 'needs a member session');

/* finance: entry, approvals by level, dual sign, Board limit, Art. XII, restricted transfer */
const e1 = await call('POST', '/admin/finance/transactions', { date: today, kind: 'expense', amountCents: 80000, fund: 'general', center: SE1, category: 'maintenance', party: 'Cool Air HVAC', method: 'check' }, 'fs-se1');
ok(e1.status === 201 && e1.body.transaction.status === 'pending' && e1.body.needs === 1, 'masjid enters an expense – one approval', e1.body);
ok((await call('POST', '/admin/finance/transactions', { date: today, kind: 'expense', amountCents: 80000, fund: 'general', center: N1, category: 'maintenance', party: 'X Co' }, 'fs-se1')).status === 403, 'not for another masjid');
ok((await call('POST', `/admin/finance/transactions/${e1.body.transaction.id}/approve`, {}, 'fs-se1')).status === 403, 'nobody approves their own');
const a1 = await call('POST', `/admin/finance/transactions/${e1.body.transaction.id}/approve`, {}, 'treasurer');
ok(a1.status === 200 && a1.body.status === 'approved', 'treasurer approves', a1.body);
ok((await call('POST', `/admin/finance/transactions/${e1.body.transaction.id}/paid`, { method: 'check' }, 'treasurer')).status === 400, 'a check payment needs the check number');
ok((await call('POST', `/admin/finance/transactions/${e1.body.transaction.id}/paid`, { ref: '10401' }, 'treasurer')).body.status === 'paid', 'paid');
ok((await call('POST', `/admin/finance/transactions/${e1.body.transaction.id}/void`, { note: 'oops' }, 'treasurer')).status === 200, 'a paid one can only be voided');
const e2 = await call('POST', '/admin/finance/transactions', { date: today, kind: 'expense', amountCents: 900000, fund: 'general', category: 'maintenance', party: 'Demo Roofing', method: 'ach' }, 'treasurer');
ok(e2.body.needs === 2, 'over $5,000 → two approvals');
ok((await call('POST', `/admin/finance/transactions/${e2.body.transaction.id}/approve`, {}, 'treasurer')).status === 403, 'the person who entered it cannot approve');
const a2 = await call('POST', `/admin/finance/transactions/${e2.body.transaction.id}/approve`, {}, 'owner');
ok(a2.body.status === 'pending' && a2.body.approvals === 1, 'first signature', a2.body);
ok((await call('POST', `/admin/finance/transactions/${e2.body.transaction.id}/approve`, {}, 'owner')).status === 403, 'the same person twice is not two signatures');
ok((await call('POST', `/admin/finance/transactions/${e2.body.transaction.id}/paid`, {}, 'treasurer')).status === 409, 'not paid before it is approved');
const e3 = await call('POST', '/admin/finance/transactions', { date: today, kind: 'expense', amountCents: 2500000, fund: 'building', category: 'construction', party: 'Demo Builders' }, 'treasurer');
ok((await call('POST', `/admin/finance/transactions/${e3.body.transaction.id}/approve`, {}, 'owner')).status === 403, 'over the Board limit (and the owner’s $20,000) needs the Board');
const tr = await call('POST', '/admin/finance/transactions', { date: today, kind: 'transfer', amountCents: 100000, fund: 'sadaqah', toFund: 'general', category: 'admin', method: 'internal' }, 'treasurer');
ok(tr.status === 422 && tr.body.error.includes('restricted'), 'restricted money does not move without a Board decision', tr.body);
ok((await call('POST', '/admin/finance/transactions', { date: today, kind: 'transfer', amountCents: 100000, fund: 'general', toFund: 'building', category: 'construction', method: 'internal' }, 'fs-se1')).status === 403, 'transfers are for the Treasurer');
const aid1 = await call('POST', '/admin/finance/transactions', { date: today, kind: 'aid', amountCents: 1500000, fund: 'general', category: 'aid', party: 'Test Academy', method: 'check' }, 'treasurer');
ok(aid1.status === 201, 'aid under $20,000 in 12 months');
const aid2 = await call('POST', '/admin/finance/transactions', { date: today, kind: 'aid', amountCents: 600000, fund: 'general', category: 'aid', party: 'Test Academy', method: 'check' }, 'treasurer');
ok(aid2.status === 422 && aid2.body.error.includes('Art. XII'), 'over $20,000 to one party in 12 months needs the Joint Board-Councils', aid2.body);
ok((await call('POST', '/admin/finance/transactions', { date: today, kind: 'aid', amountCents: 600000, fund: 'general', category: 'aid', party: 'Test Academy', method: 'check', boardDecision: 'MTG-2026-040' }, 'treasurer')).status === 201, 'with the decision linked it may be entered');
const rj = await call('POST', `/admin/finance/transactions/${e3.body.transaction.id}/reject`, { note: 'Bring it to the Board' }, 'owner');
ok(rj.body.status === 'rejected', 'rejected with a reason');

/* summary, statements, donations → ledger */
const pd = await call('POST', '/admin/finance/post-donations', { month: '2026-10' }, 'treasurer');
ok(pd.status === 200 && pd.body.posted >= 2, `October donations posted (${pd.body.posted} lines)`, pd.body);
ok((await call('POST', '/admin/finance/post-donations', { month: '2026-10' }, 'treasurer')).body.posted === 0, 'posting twice adds nothing');
ok((await call('POST', '/admin/finance/statements', { center: SE1, year: 2026, quarter: 3, incomeCents: 1200000, expenseCents: 900000 }, 'fs-se1')).status === 201, 'quarterly statement from the masjid');
ok((await call('POST', '/admin/finance/statements', { center: SE1, year: 2026, quarter: 4 }, 'fs-se1')).status === 422, 'not before the quarter ends');
const sum = await call('GET', '/admin/finance/summary', undefined, 'treasurer');
ok(sum.status === 200 && sum.body.balances.some((f: any) => f.id === 'general') && Array.isArray(sum.body.warnings) && sum.body.monthly.length === 12, 'fund balances, months, warnings', Object.keys(sum.body ?? {}));
ok(sum.body.statementsDue.every((x: any) => !(x.center === SE1 && x.quarter === 3)), 'the statement counts');
const seSum = await call('GET', `/admin/finance/summary?center=${encodeURIComponent(SE1)}`, undefined, 'fs-se1');
ok(seSum.status === 200 && seSum.body.balances === undefined && Array.isArray(seSum.body.budget), 'a masjid sees its budget, not the organization’s balances');
const txs = await call('GET', '/admin/finance/transactions', undefined, 'fs-se1');
ok(txs.body.transactions.every((t: any) => t.center === SE1), 'and its own transactions only');
ok((await call('GET', '/admin/finance/transactions', undefined, 'web-editor')).status === 403, 'finance needs finance.view');
ok(await n(`SELECT count(*)::int AS n FROM app.audit_log WHERE area = 'finance'`) >= 8, 'every money step is in the audit log');

server.close(); await db.close();
console.log(`giving ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
