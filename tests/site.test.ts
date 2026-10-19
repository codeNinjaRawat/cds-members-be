/**
 * C1 – the website's server reads documents through the API, and the member home.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/site.test.ts   (after tenancy: uses its organization cvic-austin when present)
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, h: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any, headers: r.headers };
};

/* documents for the website's server */
const home = await call('GET', '/site/documents/home');
ok(home.status === 200 && home.body.key === 'home' && home.body.data && typeof home.body.version === 'number', 'the website reads its home page document');
const ev = await call('GET', '/site/documents/events');
ok(ev.status === 200 && Array.isArray(ev.body.data.events), 'and the whole events document (its server filters)');
for (const k of ['admin-access', 'integrations', 'finance-settings', 'zakat-settings', 'donation-settings']) ok((await call('GET', `/site/documents/${k}`)).status === 404, `never ${k}`);
ok((await call('GET', '/site/documents/nothing')).status === 404, 'nor an unknown key');

process.env.TENANT_FROM_HOST = '1'; process.env.EDGE_KEY = 'e'.repeat(48);
const KEY = { 'x-edge-key': 'e'.repeat(48) };
ok((await call('GET', '/site/documents/home', undefined, { 'x-org': 'isgh' })).status !== 200, 'in production a stranger cannot read them');
ok((await call('GET', '/site/documents/home', undefined, { ...KEY, 'x-org': 'isgh' })).status === 200, 'our website (edge key) can');
const cv = await one<{ slug: string }>(db, OWNER, `SELECT slug FROM platform.organizations WHERE slug <> 'isgh' ORDER BY created_at LIMIT 1`);
if (cv) {
  const sc = await call('GET', '/site/documents/site-config', undefined, { ...KEY, 'x-org-host': `${cv.slug}.nextgrow.pro` });
  ok(sc.status === 200 && sc.body.data.org.shortName !== 'ISGH' && !JSON.stringify(sc.body.data).includes('Greater Houston'), `another organization gets its own content (${cv.slug})`, sc.body.data?.org);
}
delete process.env.TENANT_FROM_HOST; delete process.env.EDGE_KEY;

/* the member home */
ok((await call('GET', '/member/portal')).status === 401, 'member home needs a session');
const mem = await one<{ id: string; email: string }>(db, OWNER, `SELECT m.id, m.email FROM app.members m WHERE m.org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh') AND m.status IN ('active', 'life') AND m.archived IS NULL AND m.email <> '' AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY m.id LIMIT 1`);
const st = await call('POST', '/auth/code/start', { address: mem!.email });
const vr = await call('POST', '/auth/code/verify', { address: mem!.email, code: st.body.devCode });
const jar = { cookie: (vr.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)![0] };
const me = await call('GET', '/member/portal', undefined, jar);
const p = me.body?.member;
ok(me.status === 200 && p.memberId === mem!.id && p.email.toLowerCase() === mem!.email.toLowerCase(), 'the signed-in member’s own home', me.body);
ok(['Active', 'Expired', 'Pending approval', 'Inactive'].includes(p.status) && typeof p.plan === 'string' && p.plan.length > 0, `status and plan in words (${p.status}, ${p.plan})`);
ok(Array.isArray(p.checks) && p.checks.length >= 3 && p.checks.every((c: any) => ['ok', 'todo', 'wait', 'no'].includes(c.state) && c.label), `voting checks for ${p.votingYear}`, p.checks);
ok(Array.isArray(p.payments) && p.payments.every((x: any) => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.amountCents > 0), 'payments with dates and amounts');
ok(Array.isArray(p.groupIds) && typeof p.idVerified === 'boolean' && Array.isArray(p.address), 'groups, ID and address');
ok(!('dob' in p) && !('notes' in p) && !('audit' in p), 'no office notes, audit or birth date');

/* public membership check */
const full = await one<{ id: string; last_name: string; zip: string }>(db, OWNER, `SELECT id, last_name, left(zip, 5) AS zip FROM app.members WHERE id = $1`, [mem!.id]);
const v = await call('POST', '/public/members/verify', { memberId: full!.id.toLowerCase(), lastName: full!.last_name.toUpperCase(), zip: full!.zip });
ok(v.status === 200 && v.body.found === true && v.body.status === 'Active' && typeof v.body.votingEligible === 'boolean', 'an active member is confirmed', v.body);
ok(Object.keys(v.body).sort().join() === 'found,status,validThrough,votingEligible', 'and nothing else about them');
ok((await call('POST', '/public/members/verify', { memberId: full!.id, lastName: 'Nobody', zip: full!.zip })).body.found === false, 'a wrong last name finds nobody');
ok((await call('POST', '/public/members/verify', { memberId: 'x', lastName: 'a', zip: '1' })).status === 422, 'all three are needed');
let limitHit = false; for (let i = 0; i < 25 && !limitHit; i++) limitHit = (await call('POST', '/public/members/verify', { memberId: full!.id, lastName: 'Guess' + i, zip: full!.zip }, { 'x-forwarded-for': '198.51.100.77' })).status === 429;
ok(limitHit, 'guessing is limited per address');

/* anonymous feedback and complaints (website forms) */
const an = await call('POST', '/public/tickets', { kind: 'feedback', title: 'Feedback: Friday parking', detail: 'The new parking volunteers were wonderful.', anonymous: true });
ok(an.status === 201 && /^T-\d+$/.test(an.body.id), 'anonymous feedback is received', an.body);
const anT = await one<{ requester_name: string; requester_email: string }>(db, OWNER, 'SELECT requester_name, requester_email FROM app.hd_tickets WHERE id = $1 AND org_id = (SELECT id FROM platform.organizations WHERE slug = $2)', [an.body.id, 'isgh']);
ok(anT?.requester_name === 'Anonymous' && anT.requester_email === '', 'without a name or email');
ok((await call('POST', '/public/tickets', { kind: 'request', title: 'Need a letter', detail: 'Please send me a membership letter.', anonymous: true })).status === 422, 'a request still needs an email to answer');

server.close(); await db.close();
console.log(`site ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
