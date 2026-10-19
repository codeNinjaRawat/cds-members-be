/**
 * B6b A second organization is its own world: starter content by template (never ISGH's name, places or people),
 * its own member ID prefix, its own clock, nothing of another organization visible.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/tenancy.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1'; process.env.PLATFORM_OWNER_EMAIL = 'founder@masajid.test';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');
const { allStarters } = await import('../src/platform/starter.js');
const { PUBLIC } = await import('../src/registry.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, h: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const staff = { 'x-staff': 'founder@masajid.test' };
const ISGH = /ISGH|Greater Houston|isgh\.org|Eastside|HOU-\d|Southwest Islamic|Masjid Aqsa|@isgh/;
const mk = (slug: string, shortName: string, template: string) => ({ name: `${shortName} Community Center`, shortName, type: 'masjid', city: 'Austin', state: 'TX', address: '12 Oak Lane', phone: '(512) 555-0100', email: `office@${slug}.example`, slug, template, planId: 'growth', cycle: 'annual', trial: false, owner: { name: 'Owner Person', email: `owner@${slug}.example` }, modules: {} });

for (const [slug, short, template] of [['cvic-austin', 'CVIC', 'simple-masjid'], ['bayou', 'BAYOU', 'bylaws-society'], ['quiet', 'QMC', 'blank']] as const) {
  const r = await call('POST', '/platform/orgs', mk(slug, short, template), staff);
  ok(r.status === 201, `${slug} created (${template})`, r.body);
}
const idOf = async (slug: string) => (await one<{ id: string }>(db, OWNER, 'SELECT id::text FROM platform.organizations WHERE slug = $1', [slug]))!.id;

/* starter content: every document fits its schema and carries nothing of ISGH */
for (const slug of ['cvic-austin', 'bayou', 'quiet']) {
  const all = await allStarters(db, await idOf(slug)); const text = JSON.stringify(all);
  const hit = text.match(ISGH);
  ok(!hit, `${slug}: no ISGH name, place or person in any starter document`, hit ? text.slice(Math.max(0, hit.index! - 120), hit.index! + 80) : '');
  ok(text.includes(slug === 'cvic-austin' ? 'CVIC' : slug === 'bayou' ? 'BAYOU' : 'QMC'), `${slug}: its own short name is used`);
}
const pagesOf = async (slug: string) => Object.keys((await allStarters(db, await idOf(slug))).pages as object);
ok(!(await pagesOf('cvic-austin')).includes('constitution-bylaws') && (await pagesOf('cvic-austin')).includes('about'), 'simple masjid: no Bylaws or election pages');
ok((await pagesOf('bayou')).includes('constitution-bylaws') && (await pagesOf('bayou')).includes('elections'), 'Bylaws society keeps them');
ok((await pagesOf('quiet')).every((p) => ['privacy', 'terms', 'accessibility', 'contact'].includes(p)), 'blank: only the legal pages');

/* the website of a new organization */
for (const key of Object.keys(PUBLIC)) {
  const r = await call('GET', `/public/documents/${key}`, undefined, { 'x-org': 'cvic-austin' });
  ok((r.status === 200 || r.status === 404) && !JSON.stringify(r.body ?? {}).match(ISGH), `public ${key} for Crescent is its own`, JSON.stringify(r.body).match(ISGH)?.[0]);
}
const sc = await call('GET', '/public/documents/site-config', undefined, { 'x-org': 'cvic-austin' });
ok(sc.body.data.org.name === 'CVIC Community Center' && sc.body.data.org.address.join(' ').includes('12 Oak Lane'), 'site settings: its own name and address', sc.body.data.org);
ok((await call('GET', '/public/documents/site-config', undefined, { 'x-org': 'isgh' })).body.data.org.shortName === 'ISGH', 'ISGH still sees its own');

/* its own member numbers */
const crOwner = ((await one<{ data: any }>(db, OWNER, `SELECT data FROM app.documents WHERE org_id = $1::uuid AND key = 'admin-access'`, [await idOf('cvic-austin')]))!.data.admins[0]).id;
const asCr = { 'x-org': 'cvic-austin', 'x-admin': crOwner };
ok((await call('GET', '/admin/members', undefined, asCr)).body.count === 0, 'Crescent sees none of ISGH’s members');
const nm = await call('POST', '/admin/members', { first: 'Sara', last: 'Khan', email: 'sara.khan@cvic-austin.example', phone: '', dob: '1990-02-02', street: '1 Elm', city: 'Austin', state: 'TX', zip: '78701', plan: 'single' }, asCr);
ok(nm.status === 201 && /^CVIC-1\d{5}$/.test(nm.body.member?.id ?? nm.body.id ?? ''), `member ID from its own prefix (${nm.body.member?.id ?? nm.body.id})`, nm.body);
const isghNew = await call('POST', '/admin/members', { first: 'Test', last: 'Prefix', email: 'test.prefix@example.org', phone: '', dob: '1990-02-02', street: '1 Elm', city: 'Houston', state: 'TX', zip: '77036', plan: 'single' }, { 'x-admin': 'owner' });
ok(/^HOU-\d{6}$/.test(isghNew.body.member?.id ?? isghNew.body.id ?? ''), 'ISGH keeps HOU- (a setting now)', isghNew.body);
ok((await call('GET', `/admin/members/${nm.body.member?.id ?? nm.body.id}`, undefined, { 'x-admin': 'owner' })).status === 404, 'ISGH cannot open Crescent’s member');

/* its own clock */
await db.run(OWNER, [{ sql: `UPDATE platform.organizations SET timezone = 'Pacific/Honolulu' WHERE slug = 'quiet'` }]);
const t = await call('POST', '/public/helpdesk/tickets', { categoryId: 'feedback', subject: 'Clock check', detail: 'Which time zone is this ticket in?', name: 'Clock Tester', email: 'clock@quiet.example' }, { 'x-org': 'quiet' });
const q = await one<{ local: string }>(db, { org: await idOf('quiet'), role: 'app_api' }, `SELECT to_char(created_at AT TIME ZONE 'Pacific/Honolulu', 'HH24') AS local FROM app.hd_tickets WHERE id = $1`, [t.body.reference]);
const hono = new Date().toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', hour: '2-digit', hourCycle: 'h23' });
const tk = await call('GET', `/admin/helpdesk/tickets/${t.body.reference}`, undefined, { 'x-org': 'quiet', 'x-admin': ((await one<{ data: any }>(db, OWNER, `SELECT data FROM app.documents WHERE org_id = $1::uuid AND key = 'admin-access'`, [await idOf('quiet')]))!.data.admins[0]).id });
ok(t.status === 201 && tk.body.ticket.createdAt.slice(11, 13) === q!.local && q!.local === hono.padStart(2, '0'), `the ticket is stamped in Honolulu time (${tk.body.ticket?.createdAt})`, tk.body);

/* production: only our own apps (with the edge key) may name the organization or the visitor's address */
{
  const { clientIp } = await import('../src/http/core.js');
  process.env.TENANT_FROM_HOST = '1'; process.env.EDGE_KEY = 'k'.repeat(64);
  const name = async (h: Record<string, string>) => { const r = await call('GET', '/public/documents/site-config', undefined, h); return r.status === 200 ? r.body.data.org.shortName : r.status; };
  ok(await name({ 'x-org': 'cvic-austin' }) === 404, 'a stranger cannot pick the organization with x-org (the host decides)');
  ok(await name({ 'x-org': 'cvic-austin', 'x-edge-key': 'wrong'.padEnd(64, 'x') }) === 404, 'nor with a wrong key');
  const cv = await name({ 'x-org': 'cvic-austin', 'x-edge-key': 'k'.repeat(64) });
  ok(cv !== 404 && cv !== 'ISGH', `our website with the key: the organization it names (${cv})`);
  ok(await name({ 'x-org-host': 'cvic-austin.nextgrow.pro', 'x-edge-key': 'k'.repeat(64) }) === cv, 'or the address the visitor used');
  ok(await name({ 'x-org-host': 'cvic-austin-admin.nextgrow.pro', 'x-edge-key': 'k'.repeat(64) }) === cv, 'its admin address too');
  ok(await name({ 'x-org-host': 'nobody.nextgrow.pro', 'x-edge-key': 'k'.repeat(64) }) === 404, 'an unknown address is no organization');
  ok(clientIp({ 'x-forwarded-for': '6.6.6.6' }, '::ffff:10.0.0.5') === '10.0.0.5', 'a made-up x-forwarded-for is ignored');
  ok(clientIp({ 'x-client-ip': '203.0.113.9', 'x-edge-key': 'k'.repeat(64) }, '10.0.0.5') === '203.0.113.9', 'our apps pass the visitor’s address');
  ok(clientIp({ 'x-client-ip': '203.0.113.9' }, '10.0.0.5') === '10.0.0.5', 'nobody else can');
  process.env.TRUST_PROXY = '1';
  ok(clientIp({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }, '127.0.0.1') === '198.51.100.7', 'behind nginx: the hop nginx added, not the one the visitor wrote');
  delete process.env.TENANT_FROM_HOST; delete process.env.EDGE_KEY; delete process.env.TRUST_PROXY;
}

server.close(); await db.close();
console.log(`tenancy ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
