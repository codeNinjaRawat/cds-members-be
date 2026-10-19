/**
 * C4g Meetings and minutes, benefit uses – the admin's Minutes and Benefits screens through the API.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/records.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');
const { mockMeetings } = await import('@/lib/community/minutes');
const { mockBenefits } = await import('@/lib/community/benefits');

let pass = 0, fail = 0; const ok = (c: unknown, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, admin = 'owner', h: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin': admin } : {}), ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

/* meetings */
const draft = { ...structuredClone(mockMeetings[0]), id: 'MTG-2026-999', status: 'draft' as const, approvedOn: '' };
const made = await call('PUT', `/admin/meetings/${draft.id}`, { meeting: draft });
ok(made.status === 201 && /^MTG-\d{4}-\d{3,}$/.test(made.body.meeting.id) && made.body.meeting.id !== 'MTG-2026-999', `a new meeting gets the server's number (${made.body.meeting?.id})`, made.body);
const id = made.body.meeting.id;
ok((await call('GET', '/admin/meetings')).body.meetings.some((m: any) => m.id === id), 'listed');
const bad = await call('PUT', `/admin/meetings/${id}`, { meeting: { ...made.body.meeting, status: 'approved', approvedOn: '' } });
ok(bad.status === 422 && /approved/.test(bad.body.error), 'approved minutes need the approval date (the shared rule)', bad.body);
const pub = await call('PUT', `/admin/meetings/${id}`, { meeting: { ...made.body.meeting, status: 'published', approvedOn: '2026-10-10', audience: 'members' } });
ok(pub.status === 200 && pub.body.meeting.status === 'published', 'approved and published');
ok((await call('PUT', `/admin/meetings/${id}`, { meeting: { ...pub.body.meeting, status: 'draft', approvedOn: '' } })).status === 409, 'published minutes do not go back to a draft');
ok((await call('PUT', `/admin/meetings/${id}`, { meeting: pub.body.meeting }, 'treasurer')).status === 403, 'only people who keep minutes write them');
ok(await one<{ n: number }>(db, OWNER, `SELECT count(*)::int AS n FROM app.meetings WHERE id = $1 AND status = 'published' AND title <> ''`, [id]).then((r) => r!.n === 1), 'the columns follow (status, title)');

/* the member reads published minutes */
const mem = await one<{ email: string }>(db, OWNER, `SELECT m.email FROM app.members m WHERE m.org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh') AND m.status IN ('active', 'life') AND m.archived IS NULL AND m.email <> '' AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY random() LIMIT 1`);
const st = await call('POST', '/auth/code/start', { address: mem!.email }, '');
const vr = await fetch(base + '/auth/code/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: mem!.email, code: st.body.devCode }) });
const jar = { cookie: (vr.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)![0] };
const mine = await (await fetch(base + '/member/minutes', { headers: jar })).json() as any;
ok(mine.meetings.some((m: any) => m.id === id) && mine.meetings.every((m: any) => m.status !== 'draft' && m.audience !== 'leaders'), 'members read published minutes only');

/* benefit uses */
const offer = mockBenefits.offers[0];
const who = await one<{ id: string }>(db, OWNER, `SELECT id FROM app.members WHERE org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh') AND status = 'active' AND archived IS NULL LIMIT 1`);
const use = await call('POST', '/admin/benefits/uses', { offerId: offer.id, memberId: who!.id.toLowerCase() });
ok(use.status === 201 && /^R-\d+$/.test(use.body.use.id), `a use is logged (${use.body.use?.id})`, use.body);
ok((await call('GET', '/admin/benefits/uses')).body.uses.some((u: any) => u.id === use.body.use.id && u.memberId === who!.id), 'and listed');
ok((await call('POST', '/admin/benefits/uses', { offerId: 'nope', memberId: who!.id })).status === 422, 'only real offers');
const old = await one<{ id: string }>(db, OWNER, `SELECT id FROM app.members WHERE org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh') AND status = 'expired' AND archived IS NULL LIMIT 1`);
if (old) ok((await call('POST', '/admin/benefits/uses', { offerId: offer.id, memberId: old.id })).status === 409, 'only for current members');
ok((await call('GET', '/admin/benefits/uses', undefined, 'treasurer')).status === 403, 'the log needs benefits.manage');

server.close(); await db.close();
console.log(`records ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
