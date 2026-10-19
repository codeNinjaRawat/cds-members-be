/**
 * B4d Zakat and Sadaqah – black-box over HTTP on a migrated + seeded database.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/zakat.test.ts
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
const zipOf = async (center: string) => (await one<{ zip: string }>(db, OWNER, `SELECT cz.zip FROM app.center_zips cz JOIN app.centers c ON c.org_id = cz.org_id AND c.id = cz.center_id WHERE c.name = $1 ORDER BY cz.zip LIMIT 1`, [center]))!.zip;
const N1 = 'North Islamic Center 1'; const nZip = await zipOf(N1);
const app = (over: Record<string, unknown> = {}, who: Record<string, unknown> = {}) => ({ applicant: { name: 'Amina Yusuf', phone: '713-555-0110', email: 'amina.z@example.org', zip: nZip, household: 4, monthlyIncomeCents: 180000, ...who },
  category: 'rent', reason: 'Lost my job in September and rent is due on the first.', requestedCents: 30000, months: 1, urgent: false, consent: true, ...over });
const act = (id: string, step: string, b: unknown, who: string) => call('POST', `/admin/zakat/cases/${id}/${step}`, b, who);
const verify = async (id: string, visit = false) => { await act(id, 'checks', { documents: true, income: true, hardship: true, ...(visit ? { homeVisit: { on: '2026-10-17', note: 'Family of four, rent notice seen.' } } : {}) }, 'lzc-north'); return act(id, 'decide', { fund: 'zakat' }, 'lzc-north'); };

/* website intake → routed by ZIP to the masjid's coordinator */
const a1 = await call('POST', '/public/zakat/applications', app(), '');
ok(a1.status === 201 && /^ZKT-\d{4}-\d{3,5}$/.test(a1.body.reference) && a1.body.center === N1, `request ${a1.body.reference} routed to ${a1.body.center}`, a1.body);
const c1 = a1.body.reference as string;
ok(await n(`SELECT count(*)::int AS n FROM app.notices WHERE admin_id = 'lzc-north' AND kind = 'assignment'`) === 1, 'the local coordinator is told');
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'amina.z@example.org' AND kind = 'zakat-received'`) === 1, 'the applicant gets a reference');
ok((await call('POST', '/public/zakat/applications', app(), '')).status === 409, 'one open request per person');
ok((await call('POST', '/public/zakat/applications', app({}, { email: '', phone: '' }), '')).status === 422, 'needs a way to reach them');
ok((await call('POST', '/public/zakat/applications', app({ requestedCents: 600000 }, { email: 'x1@example.org' }), '')).status === 422, 'above the largest request');
ok((await call('POST', '/public/zakat/applications', app({ consent: false }, { email: 'x2@example.org' }), '')).status === 422, 'consent needed');
ok((await call('POST', '/public/zakat/applications', app({ months: 9 }, { email: 'x3@example.org' }), '')).status === 422, 'monthly help at most 6 months');

/* privacy */
ok((await call('GET', '/admin/zakat/cases', undefined, 'web-editor')).status === 403, 'no zakat.view → nothing');
ok((await call('GET', `/admin/zakat/cases/${c1}`, undefined, 'ad-se1')).status === 404, 'another masjid’s case does not exist for them');
const ql = await call('GET', '/admin/zakat/cases', undefined, 'lzc-north');
ok(ql.status === 200 && ql.body.cases.some((c: any) => c.id === c1 && c.actions.includes('verify')), 'coordinator sees it with the verify action', ql.body.cases?.[0]);
ok(ql.body.cases.every((c: any) => c.center === N1), 'and only their masjid');
const opened = await call('GET', `/admin/zakat/cases/${c1}`, undefined, 'zakat-chair');
ok(opened.status === 200 && opened.body.steps[0].action === 'intake', 'the case with its history');
ok(await n(`SELECT count(*)::int AS n FROM app.audit_log WHERE area = 'zakat' AND action = 'Case opened'`) >= 1, 'who opened a case is logged');

/* verify → decide → L1 approves a small case → Operations pays */
ok((await act(c1, 'decide', { fund: 'zakat' }, 'lzc-north')).status === 409, 'no decision before the checks');
const d1 = await verify(c1);
ok(d1.status === 200 && d1.body.case.status === 'awaiting-approval' && d1.body.case.nextLevel === 1, 'eligible for Zakat → Level 1', d1.body);
ok((await act(c1, 'approve', { amountCents: 30000 }, 'zakat-ccm')).status === 403, 'a Level 2 member waits for Level 1');
ok((await act(c1, 'approve', { amountCents: 99999 }, 'lzc-north')).status === 403, 'not more than asked for');
const ap1 = await act(c1, 'approve', { amountCents: 25000, note: 'Rent notice checked' }, 'lzc-north');
ok(ap1.status === 200 && ap1.body.case.status === 'approved' && ap1.body.case.totalCents === 25000, '$250 approved at Level 1 (lowered)', ap1.body);
ok(await n(`SELECT count(*)::int AS n FROM app.notices WHERE admin_id = 'zakat-ops' AND kind = 'approval'`) >= 1, 'Operations is told to pay');
ok((await act(c1, 'pay', { method: 'transfer', ref: 'ACH-1' }, 'lzc-north')).status === 403, 'whoever approved does not pay');
ok((await act(c1, 'pay', { method: 'transfer', ref: '' }, 'zakat-ops')).status === 403, 'a transfer needs its number');
const p1 = await act(c1, 'pay', { method: 'transfer', ref: 'ACH-55102' }, 'zakat-ops');
ok(p1.status === 200 && p1.body.case.status === 'paid' && p1.body.case.paidCents === 25000, 'paid', p1.body);
ok(await n(`SELECT count(*)::int AS n FROM app.zakat_payouts WHERE case_id = $1 AND amount_cents = 25000`, [c1]) === 1, 'payout recorded');
ok(await n(`SELECT count(*)::int AS n FROM app.ledger WHERE source = 'zakat' AND source_ref = $1 AND fund_id = 'zakat' AND status = 'paid' AND category = 'zakat-aid'`, [`${c1}:1`]) === 1, 'the ledger shows the money leaving the Zakat fund');
ok((await act(c1, 'pay', { method: 'cash' }, 'zakat-ops')).status === 403, 'never paid twice');

/* a bigger case climbs the levels; nobody approves twice */
const a2 = await call('POST', '/public/zakat/applications', app({ requestedCents: 90000, category: 'medical', reason: 'Surgery bill after the accident in August.' }, { email: 'yusuf.z@example.org', phone: '713-555-0111', name: 'Yusuf Ali' }), '');
const c2 = a2.body.reference; await verify(c2);
ok((await act(c2, 'approve', { amountCents: 90000 }, 'lzc-north')).body.case.status === 'awaiting-approval', 'Level 1 approves – still waiting ($900 needs Level 3)');
ok((await act(c2, 'approve', { amountCents: 90000 }, 'lzc-north')).status === 403, 'the same person cannot approve again');
const l2 = await act(c2, 'approve', { amountCents: 90000 }, 'zakat-ccm');
ok(l2.body.case.status === 'awaiting-approval' && l2.body.case.nextLevel === 3, 'Level 2 approves → Level 3 next', l2.body.case);
ok((await act(c2, 'approve', { amountCents: 90000, note: 'Hospital bill seen' }, 'zakat-chair')).body.case.status === 'approved', 'Level 3 → approved');
let sneaky = false; try { await db.run({ org: (await one<{ id: string }>(db, OWNER, `SELECT id FROM platform.organizations WHERE slug = 'isgh'`))!.id, role: 'app_api' }, [{ sql: `INSERT INTO app.zakat_steps (org_id, case_id, by, admin_id, action) SELECT org_id, id, 'x', 'zakat-ccm', 'pay' FROM app.zakat_cases WHERE id = $1`, params: [c2] }]); sneaky = true; } catch { /* refused */ }
ok(!sneaky, 'the database itself refuses a payout step by an approver');

/* monthly help above every limit: home visit, the Chair's override, three payouts */
const a3 = await call('POST', '/public/zakat/applications', app({ requestedCents: 60000, months: 3, reason: 'Rent for three months while my husband recovers.' }, { email: 'sara.z@example.org', phone: '713-555-0112', name: 'Sara Omar' }), '');
const c3 = a3.body.reference;
await act(c3, 'checks', { documents: true, income: true, hardship: true }, 'lzc-north');
const nov = await act(c3, 'decide', { fund: 'zakat' }, 'lzc-north');
ok(nov.status === 409 && nov.body.error.includes('home visit'), '$1,800 in total needs a home visit first', nov.body);
const d3 = await verify(c3, true);
ok(d3.body.case.needsLevel === 4, 'above every level → the Chair overrides');
ok((await act(c3, 'approve', { amountCents: 60000 }, 'lzc-north')).body.case.status === 'awaiting-approval', 'Level 1 alone is not enough');
const ov = await act(c3, 'approve', { amountCents: 60000, override: true, note: 'Urgent family need' }, 'zakat-chair');
ok(ov.status === 200 && ov.body.case.status === 'approved', 'Chair override → approved', ov.body);
for (const ref of ['CHK-201', 'CHK-202']) await act(c3, 'pay', { method: 'check', ref }, 'zakat-ops');
const m2 = await call('GET', `/admin/zakat/cases/${c3}`, undefined, 'zakat-ops');
ok(m2.body.case.status === 'approved' && m2.body.case.paidCents === 120000, 'two of three months paid – still open');
ok((await act(c3, 'pay', { method: 'check', ref: 'CHK-203' }, 'zakat-ops')).body.case.status === 'paid', 'third month → paid');
ok(await n(`SELECT count(*)::int AS n FROM app.ledger WHERE source = 'zakat' AND source_ref LIKE $1`, [`${c3}:%`]) === 3, 'three ledger lines');

/* send back, ask for information, reject, not eligible */
const a4 = await call('POST', '/public/zakat/applications', app({ requestedCents: 35000, category: 'utilities', reason: 'Electricity cut-off notice for next week.' }, { email: 'huda.z@example.org', phone: '713-555-0113', name: 'Huda Karim' }), '');
const c4 = a4.body.reference;
ok((await act(c4, 'request-info', { note: 'x' }, 'lzc-north')).status === 400, 'say what is needed');
const ri = await act(c4, 'request-info', { note: 'A copy of the electricity bill, please.' }, 'lzc-north');
ok(ri.body.case.status === 'info-requested', 'waiting for the applicant');
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'huda.z@example.org' AND kind = 'zakat-update' AND body LIKE '%electricity bill%'`) === 1, 'the applicant is asked by email');
await verify(c4);
ok((await act(c4, 'return', { note: 'no' }, 'lzc-north')).status === 403, 'a short reason is refused');
const rt = await act(c4, 'return', { note: 'Please confirm the account number on the bill.' }, 'lzc-north');
ok(rt.status === 200 && rt.body.case.status === 'verifying', 'sent back to verification', rt.body);
await act(c4, 'decide', { fund: 'sadaqah' }, 'lzc-north');
const rj = await act(c4, 'reject', { note: 'The bill was paid by another charity.' }, 'zakat-chair');
ok(rj.body.case.status === 'rejected', 'rejected with a reason');
const a5 = await call('POST', '/public/zakat/applications', app({ category: 'other', reason: 'Would like help with a family trip abroad.' }, { email: 'trip.z@example.org', phone: '713-555-0114', name: 'Trip Person' }), '');
ok((await act(a5.body.reference, 'decide', { fund: 'none' }, 'lzc-north')).body.case.status === 'rejected', 'not eligible – closed without checks');

/* notes, assignment, in-person intake, stats, member view */
ok((await act(c2, 'notes', { text: 'Called the hospital billing office.' }, 'zakat-chair')).status === 200, 'note added');
ok((await act(c2, 'assign', { coordinator: 'web-editor' }, 'zakat-chair')).status === 400, 'only someone who verifies');
const walk = await call('POST', '/admin/zakat/cases', app({ urgent: true, reason: 'Stranded after the car broke down on the highway.', category: 'travel', requestedCents: 15000 }, { email: '', phone: '713-555-0199', name: 'Walk In' }), 'lzc-north');
ok(walk.status === 201 && walk.body.case?.channel === 'in-person' && walk.body.case.urgent, 'in-person urgent intake', walk.body);
ok((await call('POST', '/admin/zakat/cases', app({}, { email: 'z9@example.org', phone: '713-555-0198' }), 'zakat-ops')).status === 403, 'Operations does not take applications');
const stats = (await call('GET', '/admin/zakat/cases', undefined, 'zakat-chair')).body.stats;
ok(stats.paidCents === 25000 + 90000 * 0 + 180000 && stats.urgent >= 1, `stats: paid ${stats.paidCents}`, stats);
const mem = await one<{ id: string; email: string }>(db, OWNER, `SELECT m.id, m.email FROM app.members m WHERE m.status = 'active' AND m.archived IS NULL AND m.email <> '' AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY m.id LIMIT 1 OFFSET 15`);
const st = await call('POST', '/auth/code/start', { address: mem!.email }, '');
const vr = await fetch(base + '/auth/code/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: mem!.email, code: st.body.devCode }) });
const jar = { cookie: (vr.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)![0] };
const ma = await call('POST', '/public/zakat/applications', app({ reason: 'School fees for my two children this term.', category: 'education' }, { email: mem!.email, phone: '713-555-0177', name: 'Member Applicant' }), jar);
ok(ma.status === 201, 'a member applies while signed in');
const mine = await call('GET', '/member/zakat/applications', undefined, jar);
ok(mine.status === 200 && mine.body.requests.length === 1 && mine.body.requests[0].id === ma.body.reference && !JSON.stringify(mine.body).includes('approvals'), 'the portal shows a plain status only', mine.body);

server.close(); await db.close();
console.log(`zakat ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
