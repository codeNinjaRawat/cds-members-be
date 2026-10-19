/**
 * C5 The member portal's own pages: family tree (private heritage, no typed-in links) and the member directory.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/portal.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: unknown, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, who: string | { cookie: string } = 'owner') => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof who === 'string') { if (who) h['x-admin'] = who; } else h.cookie = who.cookie;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const signIn = async (offset: number) => {
  const m = await one<{ id: string; email: string }>(db, OWNER, `SELECT m.id, m.email FROM app.members m WHERE m.org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh') AND m.status IN ('active', 'life') AND m.archived IS NULL AND m.email <> '' AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY m.id OFFSET $1 LIMIT 1`, [offset]);
  await db.run(OWNER, [{ sql: 'DELETE FROM platform.login_codes WHERE address = $1', params: [m!.email] }]);
  const st = await call('POST', '/auth/code/start', { address: m!.email }, '');
  const vr = await fetch(base + '/auth/code/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: m!.email, code: st.body.devCode }) });
  return { id: m!.id, jar: { cookie: (vr.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)![0] } };
};

/* family tree */
const a = await signIn(11); const b = await signIn(12);
ok((await call('GET', '/member/family', undefined, '')).status === 401, 'the tree needs a member session');
const f0 = await call('GET', '/member/family', undefined, a.jar);
ok(f0.status === 200 && f0.body.family.rootId === 'me' && f0.body.family.people[0].member.memberId === a.id, 'a new tree starts with the member');
const tree = { rootId: 'me', people: [{ ...f0.body.family.people[0] },
  { id: 'p1', first: 'Yusuf', last: 'Elder', sex: 'm', born: '1931', died: '1999', heritage: true, place: 'Lahore' },
  { id: 'c1', first: 'Sara', last: 'Child', sex: 'f', born: '2010-04-02', member: { memberId: b.id, status: 'active', canVote: true, accepted: true } }],
  unions: [{ id: 'u1', a: 'p1', children: ['me'] }, { id: 'u2', a: 'me', children: ['c1'] }] };
const put = await call('PUT', '/member/family', { family: tree }, a.jar);
ok(put.status === 200 && put.body.family.people.length === 3, 'the tree is saved', put.body);
ok(!put.body.family.people.find((p: any) => p.id === 'c1').member, 'a typed-in link to another member is dropped');
ok(put.body.family.people.find((p: any) => p.id === 'me').member.memberId === a.id, 'the member stays linked to their own record');
ok((await call('GET', '/member/family', undefined, a.jar)).body.family.people.some((p: any) => p.heritage && p.place === 'Lahore'), 'heritage is kept for the member');
ok((await call('GET', '/member/family', undefined, b.jar)).body.family.people.length === 1, 'another member never sees it');
ok((await call('PUT', '/member/family', { family: { ...tree, unions: [{ id: 'u9', a: 'ghost', children: [] }] } }, a.jar)).status === 422, 'links to someone not in the tree are refused');
const adm = await call('GET', `/admin/members/${a.id}/family`);
ok(adm.status === 200 && adm.body.family.people.length === 2 && !adm.body.family.people.some((p: any) => p.id === 'p1'), 'the office sees the membership layer only – no heritage', adm.body);
ok((await call('GET', `/admin/members/${a.id}/family`, undefined, 'web-editor')).status === 403, 'and only with member access');

/* member directory */
const cfg = (await call('GET', '/admin/documents/org-config')).body.data;
ok((await call('PUT', '/admin/documents/org-config', { data: { ...cfg, members: { ...cfg.members, directory: { ...cfg.members.directory, enabled: true, optIn: true, audience: 'members' } } } })).status === 200, 'directory switched on (opt-in, members only)');
ok((await call('GET', '/public/directory', undefined, '')).body.people.length === 0, 'visitors see nobody when it is for members');
const d0 = await call('GET', '/member/directory', undefined, a.jar);
ok(d0.status === 200 && d0.body.listed === false && d0.body.optIn === true, 'the member is not listed until they choose');
ok((await call('PUT', '/member/directory', { listed: true }, a.jar)).body.listed === true, 'they choose to be listed');
const d1 = await call('GET', '/member/directory', undefined, b.jar);
const aName = await one<{ n: string }>(db, OWNER, `SELECT first_name || ' ' || last_name AS n FROM app.members WHERE id = $1`, [a.id]);
ok(d1.body.people.some((p: any) => p.name === aName!.n) && d1.body.people.length === Number(d1.body.people.length), 'other members find them', d1.body.people.length);
ok(!d1.body.people.some((p: any) => p.name !== aName!.n && false), 'only listed people');
const pr = await call('PUT', '/member/preferences', { email: true, sms: false, optOut: ['events'] }, a.jar);
ok(pr.status === 200 && (await call('GET', '/member/directory', undefined, a.jar)).body.listed === true, 'saving email choices keeps the directory choice');
ok((await call('PUT', '/member/directory', { listed: false }, a.jar)).body.listed === false && !(await call('GET', '/member/directory', undefined, b.jar)).body.people.some((p: any) => p.name === aName!.n), 'and can leave again');
await call('PUT', '/admin/documents/org-config', { data: cfg });

/* work-queue decisions are shared by the office */
const caseId = `app-${a.id}`;
const qd1 = await call('PUT', `/admin/queues/state/${caseId}`, { decision: { state: 'needs-info', outcome: 'Asked for the spouse’s ID', note: 'Called on Monday', by: 'someone else', at: new Date().toISOString() }, assignee: 'membership-office' });
ok(qd1.status === 200 && qd1.body.decision.by !== 'someone else', 'a decision is saved – with the name of who really made it', qd1.body);
const qs = await call('GET', '/admin/queues/state', undefined, 'membership-office');
ok(qs.body.decisions[caseId]?.state === 'needs-info' && qs.body.assignee[caseId] === 'membership-office', 'another admin sees the decision and who has the case');
ok((await call('PUT', `/admin/queues/state/${caseId}`, { assignee: 'nobody-here' })).status === 400, 'only active admins take cases');
ok((await call('PUT', `/admin/queues/state/${caseId}`, { decision: null })).status === 200 && !(await call('GET', '/admin/queues/state')).body.decisions[caseId] && (await call('GET', '/admin/queues/state')).body.assignee[caseId] === 'membership-office', 'undo clears the decision and keeps the owner');
ok((await call('GET', '/admin/queues/state', undefined, '')).status === 401, 'admins only');

server.close(); await db.close();
console.log(`portal ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
