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
{ // a promised check is not a payment: the member record shows no dues until the office marks it received
  const { MEMBER_SQL } = await import('../src/modules/member-shape.js');
  const shaped = await one<{ payments: unknown[] }>(db, OWNER, `${MEMBER_SQL} WHERE m.id = $1`, [sub.body.memberId]);
  const open = await one<{ n: number }>(db, OWNER, `SELECT count(*)::int AS n FROM app.payments WHERE member_id = $1 AND status = 'check_pending'`, [sub.body.memberId]);
  ok((open?.n ?? 0) > 0 && Array.isArray(shaped?.payments) && shaped!.payments.length === 0, `check waiting: ${open?.n} open payment(s), 0 counted as paid on the member`);
}
const ev2 = await call('POST', '/public/join/email/verify', { email, code: (await call('POST', '/public/join/email/start', { email })).body.devCode });
ok(ev2.status === 200 && ev2.body.alreadyApplied?.applicationId === sub.body.applicationId && !ev2.body.joinToken && !JSON.stringify(ev2.body).match(/[A-Z]{3}-\d{5,}/), 'same email again: the waiting application is shown, not a second one (no member number)');

/* ---------- drafts: nothing typed is lost; the office sees who stopped ---------- */
{
  const half = 'half.way@example.org';
  const code = (await call('POST', '/public/join/email/start', { email: half })).body.devCode;
  const v = await call('POST', '/public/join/email/verify', { email: half, code });
  ok(v.status === 200 && v.body.resumeToken?.length > 30 && v.body.resumed === false, 'verify gives a 30-day saved-application link');
  const rec = await one<{ id: string; stage: string; step: string }>(db, OWNER, `SELECT id, record->>'joinStage' AS stage, record->'join'->>'step' AS step FROM app.members WHERE email = $1`, [half]);
  ok(rec?.stage === 'incomplete' && rec.step === 'about', `a record exists from the moment the email is proven (${rec?.id})`);
  const sv = await call('PUT', '/public/join/draft', { resumeToken: v.body.resumeToken, step: 'plan', progress: { index: 2, total: 6, label: 'Plan' }, data: { about: { firstName: 'Hana', lastName: 'Saleh', phone: '7135550199', dob: '1990-02-03', street: '5 Oak St', city: 'Pasadena', state: 'tx', zip: se1zip, idImage: 'data:image/png;base64,AAAA' }, plan: { planId: 'single' }, otp: { code: '123456' }, custom: { gender: 'Female' } } });
  ok(sv.status === 200 && sv.body.saved, 'autosave');
  const after = await one<any>(db, OWNER, `SELECT first_name, last_name, phone, dob::text, state, zip, plan, center, record->'join' AS j FROM app.members WHERE id = $1`, [rec!.id]);
  ok(after.first_name === 'Hana' && after.phone === '(713) 555-0199' && after.state === 'TX' && after.zip === se1zip && after.plan === 'single' && after.center === 'Southeast Islamic Center 1', 'answers land on the record (and it is placed by ZIP)');
  ok(after.j.step === 'plan' && after.j.furthest === 'Plan' && after.j.furthestIndex === 2 && after.j.draft.custom.gender === 'Female' && !JSON.stringify(after.j.draft).includes('data:image') && !after.j.draft.otp, 'whole draft kept – no pictures, no codes');
  const sv2 = await call('PUT', '/public/join/draft', { resumeToken: v.body.resumeToken, step: 'about', progress: { index: 1, total: 6, label: 'About you' }, data: { about: { firstName: 'Hana', lastName: '' } } });
  const back = await one<any>(db, OWNER, `SELECT last_name, record->'join'->>'furthest' AS furthest FROM app.members WHERE id = $1`, [rec!.id]);
  ok(sv2.status === 200 && back.last_name === 'Saleh' && back.furthest === 'Plan', 'clearing a field never wipes what they gave; furthest step kept');
  ok((await call('PUT', '/public/join/draft', { resumeToken: 'x'.repeat(40), step: 'plan', data: {} })).status === 401, 'unknown link refused');
  // J1: yes/no only – same person (name + birth date) / phone on another member's record
  const someone = await one<any>(db, OWNER, `SELECT first_name, last_name, dob::text AS dob, phone FROM app.members WHERE approved_on IS NOT NULL AND dob IS NOT NULL AND phone <> '' LIMIT 1`);
  const chk = await call('POST', '/public/join/check', { resumeToken: v.body.resumeToken, firstName: someone.first_name, lastName: someone.last_name, dob: someone.dob, phone: someone.phone });
  ok(chk.status === 200 && chk.body.possibleMember === true && chk.body.phoneOnFile === true && Object.keys(chk.body).length === 2, `existing-person check: same person + phone on file, yes/no only (${JSON.stringify(chk.body)})`);
  const chk2 = await call('POST', '/public/join/check', { resumeToken: v.body.resumeToken, firstName: 'Hana', lastName: 'Saleh', dob: '1990-02-03', phone: '7135550199' });
  ok(chk2.body.possibleMember === false && chk2.body.phoneOnFile === false, 'no match for a new person (their own record does not count)');
  ok((await call('POST', '/public/join/check', { resumeToken: 'y'.repeat(40), firstName: 'a', lastName: 'b', dob: '1990-01-01', phone: '' })).status === 401, 'check needs a proven email');
  const open = await call('GET', `/public/join/draft/${v.body.resumeToken}`);
  ok(open.status === 200 && open.body.email === half && open.body.data.about.firstName === 'Hana' && open.body.joinToken, 'the link opens the saved answers');
  const link = await call('POST', '/public/join/draft/link', { resumeToken: v.body.resumeToken });
  const mail = await one<{ body: string }>(db, OWNER, `SELECT body FROM platform.outbox WHERE kind = 'join-link' AND to_address = $1 ORDER BY created_at DESC LIMIT 1`, [half]);
  ok(link.body.sent && mail?.body.includes(`resume=${v.body.resumeToken}`), 'save and finish later emails the link');
  // the office: not approvable, a reminder with a fresh link
  ok((await call('POST', `/admin/members/${rec!.id}/approve`, { ref: 'x' }, 'owner')).status === 409, 'an unfinished application cannot be approved');
  const rem = await call('POST', `/admin/members/${rec!.id}/join-reminder`, {}, 'owner');
  const rr = await one<any>(db, OWNER, `SELECT record->'join'->>'reminders' AS n, record->'audit'->-1->>'action' AS last FROM app.members WHERE id = $1`, [rec!.id]);
  ok(rem.status === 200 && /^https?:\/\/[^/]+\/membership\/join\?resume=/.test(rem.body.link) && !/admin/.test(rem.body.link) && rr.n === '1' && rr.last === 'Reminder sent', 'office reminder: link emailed, counted, in the audit log');
  // coming back with the email: same record, answers back
  const code2 = (await call('POST', '/public/join/email/start', { email: half })).body.devCode;
  const v2 = await call('POST', '/public/join/email/verify', { email: half, code: code2 });
  ok(v2.body.resumed === true && v2.body.data.about.firstName === 'Hana' && v2.body.step === 'about', 'verifying again picks up the same answers');
  // finishing: the same record becomes the application (via the saved link – the 12-hour token is not needed)
  const fin = await call('POST', '/public/membership/applications', { ...app({ account: { email: half, verified: true }, about: { ...app().about, firstName: 'Hana', lastName: 'Saleh' }, pledge: { ...app().pledge, signature: 'Hana Saleh' } }), resumeToken: v.body.resumeToken });
  const done = await one<any>(db, OWNER, `SELECT count(*)::int AS n, max(record->>'joinStage') AS stage, max(record->'join'->>'step') AS step, bool_or(record->'join' ? 'draft') AS draft FROM app.members WHERE email = $1`, [half]);
  ok(fin.status === 201 && fin.body.memberId === rec!.id && done.n === 1 && done.stage === null && done.step === 'done' && !done.draft, `finished on the same record (${fin.status} ${fin.body?.error ?? ''})`);
  ok((await call('GET', `/public/join/draft/${v.body.resumeToken}`)).status === 404, 'the link is done once the application is sent');
}
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
