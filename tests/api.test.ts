/**
 * Black-box API tests – run against a migrated and seeded database: `DATABASE_URL=… DB_ADAPTER=psql tsx tests/api.test.ts`.
 * Starts the server on a free port, talks HTTP only. Covers tenancy, permissions and scope, document publish and
 * validation, members and the approval rule, the retired v0 tickets, the public projections, the audit log.
 */
process.env.AUTH_DEV_HEADER = '1';   // the x-admin header is a test/dev door only (B1)
import { createApi } from '../src/http/server.js';
import { openDb } from '../src/db/sql.js';

let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { c ? pass++ : (fail++, console.log('FAIL', m)); };
const db = openDb();
const server = createApi(db);
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;
const base = `http://localhost:${port}`;
type Res = { status: number; body: any };
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const asOwner = { 'x-admin': 'owner' };

/* health, tenancy */
ok((await call('GET', '/health')).body.ok === true, 'health');
ok((await call('GET', '/admin/members', undefined, { 'x-org': 'nobody' })).status === 404, 'unknown organization → 404');
ok((await call('GET', '/admin/members')).status === 401, 'no actor → 401');
ok((await call('GET', '/admin/members', undefined, { 'x-admin': 'ghost' })).status === 401, 'unknown admin → 401');

/* members and scope */
const all = await call('GET', '/admin/members?limit=5', undefined, asOwner);
ok(all.status === 200 && all.body.count === 320 && all.body.members.length === 5, `owner sees 320 members (${all.body.count})`);
const se = await call('GET', '/admin/members?limit=400', undefined, { 'x-admin': 'ad-se1' });
ok(se.status === 200 && se.body.count > 0 && se.body.members.every((m: any) => m.center === 'Southeast Islamic Center 1'), `masjid role sees only its masjid (${se.body.count})`);
const outside = await call('GET', `/admin/members/${all.body.members.find((m: any) => m.center !== 'Southeast Islamic Center 1').id}`, undefined, { 'x-admin': 'ad-se1' });
ok(outside.status === 403, 'masjid role cannot open a member elsewhere');
ok((await call('GET', '/admin/members', undefined, { 'x-admin': 'web-editor' })).status === 403, 'website editor has no members.view');
const one = await call('GET', `/admin/members/${all.body.members[0].id}`, undefined, asOwner);
ok(one.status === 200 && one.body.eligibility && typeof one.body.status === 'string', 'one member with status and eligibility');
ok((await call('GET', '/admin/members/HOU-000000', undefined, asOwner)).status === 404, 'unknown member → 404');
const pending = await call('GET', '/admin/members?view=pending&limit=400', undefined, asOwner);
ok(pending.body.count > 0 && pending.body.members.every((m: any) => !m.approvedOn), `pending view (${pending.body.count})`);

/* documents: publish with validation and permission; versions */
const ms = await call('GET', '/admin/documents/membership-settings', undefined, asOwner);
ok(ms.status === 200 && ms.body.data.plans.length >= 4, 'published membership settings (seeded)');
const bad = await call('PUT', '/admin/documents/membership-settings', { data: { ...ms.body.data, plans: [{ ...ms.body.data.plans[0], priceCents: -5 }] } }, asOwner);
ok(bad.status === 400 && Array.isArray(bad.body.detail) && bad.body.detail[0].path.startsWith('plans.0'), 'invalid document refused with the field path');
ok((await call('PUT', '/admin/documents/membership-settings', { data: ms.body.data }, { 'x-admin': 'web-editor' })).status === 403, 'website editor cannot publish membership rules');
const rulesOn = { ...ms.body.data, rules: { ...ms.body.data.rules, approval: { ...ms.body.data.rules.approval, requireFullPayment: true } } };
const pub = await call('PUT', '/admin/documents/membership-settings', { data: rulesOn, note: 'approval after payment' }, asOwner);
ok(pub.status === 200 && pub.body.version === ms.body.version + 1, `publish bumps the version (${pub.body.version})`);
const hist = await call('GET', '/admin/documents/membership-settings?versions=1', undefined, asOwner);
ok(hist.body.versions.length >= 2 && hist.body.versions[0].note === 'approval after payment', 'versions kept with the note');
ok((await call('GET', '/admin/documents/nope', undefined, asOwner)).status === 404, 'unknown document key');

/* approval rule from the published document */
const unpaid = pending.body.members.find((m: any) => m.plan === 'single' && m.payments.length === 0);
const blocked = await call('POST', `/admin/members/${unpaid.id}/approve`, { ref: 'Board meeting' }, asOwner);
ok(blocked.status === 409 && blocked.body.detail[0].startsWith('Dues not paid in full'), `approval refused by the rule (${blocked.body.detail?.[0]})`);
await call('PUT', '/admin/documents/membership-settings', { data: ms.body.data, note: 'rule off again' }, asOwner);
const approved = await call('POST', `/admin/members/${unpaid.id}/approve`, { ref: 'Board meeting, October 2026' }, asOwner);
ok(approved.status === 200 && approved.body.approvedOn, 'approved once the rule is off');
const again = await call('GET', `/admin/members/${unpaid.id}`, undefined, asOwner);
ok(again.body.member.approvedOn === approved.body.approvedOn && again.body.member.audit.at(-1).action === 'Approved', 'approval stored with its audit entry');
ok((await call('POST', `/admin/members/${unpaid.id}/approve`, {}, asOwner)).status === 409, 'cannot approve twice');
ok((await call('POST', `/admin/members/${pending.body.members[1].id}/approve`, {}, { 'x-admin': 'web-editor' })).status === 403, 'approval needs members.approve');

/* v0 tickets are retired: the admin routes point to the help desk, the old website form still works */
const gone = await call('GET', '/admin/tickets', undefined, asOwner);
ok(gone.status === 410 && /helpdesk/.test(gone.body.error ?? JSON.stringify(gone.body)), 'old ticket list: 410 with the new address');
ok((await call('POST', '/admin/tickets/T-1041/updates', { text: 'x' }, asOwner)).status === 410, 'old ticket updates: 410');
const web = await call('POST', '/public/tickets', { kind: 'complaint', title: 'Parking blocked again', detail: 'Cars across the exit at Jumu’ah.', name: 'A member', email: 'member-web@example.com', center: 'Southwest Islamic Center 1' });
ok(web.status === 201 && /^T-\d+$/.test(web.body.id) && web.body.message, 'old website form creates a help-desk ticket');
const webT = await call('GET', `/admin/helpdesk/tickets/${web.body.id}`, undefined, asOwner);
ok(webT.status === 200 && JSON.stringify(webT.body).includes('Parking blocked again') && JSON.stringify(webT.body).includes('facilities'), 'it is in the help desk, under a complaint topic');
ok((await call('POST', '/public/tickets', { kind: 'feedback', title: 'Bot', detail: 'Buy now buy now', website: 'http://spam' })).body.ok === true, 'honeypot swallows bots');
ok((await call('POST', '/public/tickets', { kind: 'feedback', title: 'Hi', detail: 'short', email: 'a@example.com' })).status === 422, 'still needs a title and details');

/* public documents */
const lead = await call('GET', '/public/documents/officials');
ok(lead.status === 200 && lead.body.data.people.length > 0 && !JSON.stringify(lead.body).match(/HOU-\d{6}/), 'public leadership: no member ids');
ok(lead.body.data.past.length === 3 && lead.body.data.past[0].terms[0].seat === 'President', 'public past leadership by year');
const recs = await call('GET', '/public/documents/records');
ok(recs.status === 200 && recs.body.data.items.every((r: any) => r.audience === 'public'), 'public records only');
ok((await call('GET', '/public/documents/admin-access')).status === 404, 'admin-access is never public');
ok((await call('GET', '/public/documents/membership-settings')).body.data.plans.length >= 4, 'membership settings public');

/* audit */
const aud = await call('GET', '/admin/audit', undefined, asOwner);
ok(aud.status === 200 && aud.body.entries.some((e: any) => e.action === 'Approved') && aud.body.entries.some((e: any) => e.action === 'Published'), 'audit log has the approval and the publishes');
ok((await call('GET', '/admin/audit', undefined, { 'x-admin': 'treasurer' })).status === 403, 'audit needs admins.manage');

server.close(); await db.close();
console.log(`api ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
