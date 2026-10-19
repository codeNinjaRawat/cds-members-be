/**
 * B3 Website + member portal – black-box over HTTP on a migrated + seeded database.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/website.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { c ? pass++ : (fail++, console.log('FAIL', m)); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, who: string | { cookie: string } = '') => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof who === 'string') { if (who) h['x-admin'] = who; } else h.cookie = who.cookie;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any, cookie: (r.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)?.[0] ?? '' };
};
const se1zip = (await one<{ zip: string }>(db, OWNER, `SELECT cz.zip FROM app.center_zips cz JOIN app.centers c ON c.org_id = cz.org_id AND c.id = cz.center_id WHERE c.name = 'Southeast Islamic Center 1' ORDER BY cz.zip LIMIT 1`))!.zip;

/* public reads */
const centers = await call('GET', '/public/centers');
ok(centers.status === 200 && centers.body.zones.length === 5 && centers.body.centers.length >= 5 && Array.isArray(centers.body.centers[0].jumuah), `public masjids and zones (${centers.body.centers.length})`);
ok(!JSON.stringify(centers.body).includes('director_email'), 'no private fields in the public list');
const place = await call('GET', `/public/place?zip=${se1zip}`);
ok(place.body.center_name === 'Southeast Islamic Center 1' && place.body.why === '', 'ZIP → masjid → zone');
ok((await call('GET', '/public/place?zip=10001')).body.why.includes('outside every zone'), 'ZIP outside the map explained');
ok((await call('GET', '/public/place?zip=abc')).status === 400, 'bad ZIP refused');
const hd = await call('GET', '/public/helpdesk');
ok(hd.status === 200 && hd.body.categories.length > 0 && !JSON.stringify(hd.body).includes('owner'), 'help-desk categories without owners');
ok((await call('POST', '/public/newsletter', { email: 'reader@example.org', consentText: 'Yes, email me the newsletter.' })).status === 202, 'newsletter sign-up');
ok((await one<{ n: number }>(db, OWNER, `SELECT count(*)::int AS n FROM app.consents WHERE email = 'reader@example.org'`))!.n === 1, 'newsletter consent kept');

/* join: prove the email, then apply */
const email = 'new.joiner@example.org';
const app = (over: Record<string, unknown> = {}) => ({
  account: { email, verified: true },
  about: { firstName: 'Yusra', lastName: 'Bakr', dob: '1992-05-14', phone: '(713) 555-0144', street: '200 Elm St', city: 'Pasadena', state: 'TX', zip: se1zip, centerId: 'anything', zoneId: 'se' },
  plan: { memberClass: 'natural', planId: 'single', years: 1 },
  pledge: { commitments: ['programs'], pledgeAccepted: true, signature: 'Yusra Bakr', emailConsent: true, smsConsent: false },
  payment: { payer: 'self' }, pledgeVersion: 'v1', emailConsentVersion: 'v1', smsConsentVersion: 'v1',
  checkout: { method: 'check' }, ...over,
});
ok((await call('POST', '/public/membership/applications', app())).status === 401, 'no proven email → refused');
const es = await call('POST', '/public/join/email/start', { email });
ok(es.status === 202 && /^\d{6}$/.test(es.body.devCode), 'join code sent');
ok((await call('POST', '/public/join/email/verify', { email, code: es.body.devCode === '000000' ? '111111' : '000000' })).status === 400, 'wrong join code');
const ev = await call('POST', '/public/join/email/verify', { email, code: es.body.devCode });
ok(ev.status === 200 && ev.body.joinToken.length > 30, 'join token');
const badSig = await call('POST', '/public/membership/applications', { ...app(), joinToken: ev.body.joinToken, pledge: { ...app().pledge, signature: 'Someone Else' } });
ok(badSig.status === 422 && Object.keys(badSig.body.detail).some((k) => k.includes('signature')), 'the signature must match the name');
ok((await call('POST', '/public/membership/applications', { ...app({ checkout: { method: 'bitcoin' } }), joinToken: ev.body.joinToken })).status === 422, 'only the organization’s ways to pay');
const sub = await call('POST', '/public/membership/applications', { ...app(), joinToken: ev.body.joinToken });
ok(sub.status === 201 && /^APP-\d{4}-\d{5}$/.test(sub.body.applicationId) && sub.body.center === 'Southeast Islamic Center 1', `application ${sub.body.applicationId}, placed by ZIP (browser's centerId ignored)`);
ok(sub.body.amountCents > 0 && sub.body.payment.status === 'check_pending', `check payment waits (${sub.body.payment.status}, $${sub.body.amountCents / 100})`);
ok((await call('POST', '/public/membership/applications', { ...app(), joinToken: ev.body.joinToken })).status === 401, 'a join token works once');
const ev2 = await call('POST', '/public/join/email/verify', { email, code: (await call('POST', '/public/join/email/start', { email })).body.devCode });
const twice = await call('POST', '/public/membership/applications', { ...app(), joinToken: ev2.body.joinToken });
ok(twice.status === 409 && twice.body.error.includes('already waiting'), 'second application with the same email refused');
const mid = sub.body.memberId;
const row = await one<{ status: string; approved_on: string | null }>(db, OWNER, 'SELECT status, approved_on FROM app.members WHERE id = $1', [mid]);
ok(row!.status === 'pending' && row!.approved_on === null, 'the applicant is pending');
ok((await one<{ n: number }>(db, OWNER, 'SELECT count(*)::int AS n FROM app.consents WHERE member_id = $1', [mid]))!.n === 3, 'pledge, email and text consents kept with their versions');
const qa = await call('GET', '/admin/queues/applications', undefined, 'owner');
ok(qa.body.items.some((x: any) => x.id === mid), 'the application is in the work queue');

/* the office: check clears → membership term; approve → active */
const pay = await one<{ id: string }>(db, OWNER, `SELECT id FROM app.payments WHERE member_id = $1`, [mid]);
ok((await call('POST', `/admin/payments/${pay!.id}/status`, { status: 'refunded' }, 'treasurer')).status === 409, 'a waiting check cannot be refunded');
ok((await call('POST', `/admin/payments/${pay!.id}/status`, { status: 'paid' }, 'web-editor')).status === 403, 'marking paid needs payments.record');
ok((await call('POST', `/admin/payments/${pay!.id}/status`, { status: 'paid', note: 'Check 1188 cleared' }, 'treasurer')).status === 200, 'check cleared');
ok((await one<{ paid: boolean }>(db, OWNER, `SELECT paid FROM app.applications WHERE member_id = $1`, [mid]))!.paid === true, 'application shows paid');
const appr = await call('POST', `/admin/members/${mid}/approve`, { ref: 'Board, November' }, 'owner');
ok(appr.status === 200, 'Board approves');
const after = await one<{ status: string; paid_through: string }>(db, OWNER, 'SELECT status, paid_through::text FROM app.members WHERE id = $1', [mid]);
ok(after!.status === 'active' && !!after!.paid_through, `active, paid through ${after!.paid_through}`);
ok((await one<{ status: string }>(db, OWNER, `SELECT status FROM app.applications WHERE member_id = $1`, [mid]))!.status === 'approved', 'application approved');

/* member portal: sign in → renewal, records, leadership */
const st = await call('POST', '/auth/code/start', { address: email });
const jar = { cookie: (await call('POST', '/auth/code/verify', { address: email, code: st.body.devCode })).cookie };
const rn = await call('GET', '/member/renewal', undefined, jar);
ok(rn.status === 200 && rn.body.plan.id === 'single' && typeof rn.body.canRenew.ok === 'boolean', `renewal view (${rn.body.canRenew.reason})`);
const recs = await call('GET', '/member/records', undefined, jar);
ok(recs.status === 200 && recs.body.items.some((r: any) => r.audience === 'members') && !recs.body.items.some((r: any) => r.audience === 'leaders'), 'members-only records, never leaders-only');
const lead = await call('GET', '/member/leadership', undefined, jar);
ok(lead.status === 200 && lead.body.years.length > 0 && !JSON.stringify(lead.body).match(/HOU-\d{6}/), 'who served – no member ids');
ok((await call('GET', '/member/records')).status === 401, 'records need a member session');

/* renewal for an expired member with a card → pending payment waiting for checkout */
const ex = await one<{ email: string; id: string }>(db, OWNER, `SELECT m.email, m.id FROM app.members m WHERE m.status = 'expired' AND m.plan = 'single' AND m.archived IS NULL AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY m.id LIMIT 1`);
const st2 = await call('POST', '/auth/code/start', { address: ex!.email });
const jar2 = { cookie: (await call('POST', '/auth/code/verify', { address: ex!.email, code: st2.body.devCode })).cookie };
const view = await call('GET', '/member/renewal', undefined, jar2);
ok(view.body.canRenew.ok === true && view.body.options.length >= 1, `expired member may renew (${view.body.options.length} option(s))`);
const ren = await call('POST', '/member/renewal', { years: 1, method: 'card' }, jar2);
ok(ren.status === 201 && /^RNW-\d+$/.test(ren.body.ref) && ren.body.payment.status === 'pending', `renewal started ${ren.body.ref}`);
ok((await call('POST', '/member/renewal', { years: 1, method: 'card' }, jar2)).status === 409, 'one renewal payment at a time');
await call('POST', `/admin/payments/${ren.body.paymentIds[0]}/status`, { status: 'paid' }, 'treasurer');
const renewed = await one<{ status: string }>(db, OWNER, 'SELECT status FROM app.members WHERE id = $1', [ex!.id]);
ok(renewed!.status === 'active', 'paid renewal → active again');
await call('POST', `/admin/payments/${ren.body.paymentIds[0]}/status`, { status: 'refunded', note: 'Asked for a refund' }, 'treasurer');
ok((await one<{ status: string }>(db, OWNER, 'SELECT status FROM app.members WHERE id = $1', [ex!.id]))!.status === 'expired', 'refund takes the term away again');

server.close(); await db.close();
console.log(`website ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
