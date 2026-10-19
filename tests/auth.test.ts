/**
 * B1 sign-in – black-box over HTTP (plus a few direct database pokes to age a session).
 * Run on a migrated + seeded database: DATABASE_URL=… DB_ADAPTER=psql AUTH_DEV_CODES=1 tsx tests/auth.test.ts
 */
process.env.AUTH_DEV_CODES = '1'; process.env.AUTH_GOOGLE_FAKE = '1'; delete process.env.AUTH_DEV_HEADER;
process.env.ALLOWED_ORIGINS = 'https://member-web.nextgrow.pro,https://member-admin.nextgrow.pro';
const { createApi } = await import('../src/http/server.js');
const { openDb, one, rows } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { c ? pass++ : (fail++, console.log('FAIL', m)); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
type Res = { status: number; body: any; cookie: string };
const call = async (method: string, path: string, body?: unknown, jar = '', headers: Record<string, string> = {}): Promise<Res> => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(jar ? { cookie: jar } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.get('set-cookie') ?? ''; const m = set.match(/ms_sid=([^;]*)/);
  return { status: r.status, body: await r.json().catch(() => null), cookie: m ? `ms_sid=${m[1]}` : '' };
};
const signIn = async (address: string) => {
  const s = await call('POST', '/auth/code/start', { address });
  const v = await call('POST', '/auth/code/verify', { address, code: s.body.devCode });
  return { start: s, verify: v, jar: v.cookie };
};
await db.run(OWNER, [{ sql: 'DELETE FROM platform.login_codes' }, { sql: 'DELETE FROM platform.sign_in_events' }, { sql: 'DELETE FROM platform.sessions' }]);

/* methods */
const methods = await call('GET', '/auth/methods');
ok(methods.status === 200 && methods.body.methods.emailCode === true && methods.body.methods.password === false, 'methods from the sign-in document');

/* codes: same answer for unknown addresses, no code leaks */
const unknown = await call('POST', '/auth/code/start', { address: 'nobody@example.org' });
ok(unknown.status === 202 && !unknown.body.devCode && unknown.body.message.includes('If this email'), 'unknown address: same answer, nothing sent');
ok((await call('POST', '/auth/code/start', { address: 'not-an-email' })).status === 400, 'bad address refused');
ok((await call('POST', '/auth/code/start', { address: '713-555-0100' })).status === 400, 'text codes off by default');

/* an admin with sensitive permissions: code → session → two-step → work */
const own = await call('POST', '/auth/code/start', { address: 'owner@example.org' });
ok(own.status === 202 && /^\d{6}$/.test(own.body.devCode), 'code sent to an admin (dev shows it)');
const outbox = await one<{ n: number }>(db, OWNER, `SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'owner@example.org' AND body LIKE '%' || $1 || '%'`, [own.body.devCode]);
ok(outbox?.n === 1, 'the code went to the outbox');
const stored = await one<{ h: string }>(db, OWNER, `SELECT encode(code_hash, 'hex') AS h FROM platform.login_codes WHERE address = 'owner@example.org' ORDER BY created_at DESC LIMIT 1`);
ok(!!stored && !stored.h.includes(own.body.devCode), 'only a hash of the code is stored');
const wrong = await call('POST', '/auth/code/verify', { address: 'owner@example.org', code: '000000' === own.body.devCode ? '111111' : '000000' });
ok(wrong.status === 400 && wrong.body.code === 'wrong-code' && wrong.body.detail.left === 4, 'wrong code: 4 tries left');
const v = await call('POST', '/auth/code/verify', { address: 'owner@example.org', code: own.body.devCode });
ok(v.status === 200 && !!v.cookie && v.body.dashboards.some((d: any) => d.kind === 'organization'), 'right code: cookie + dashboards');
ok(v.body.twoStep.required === true, 'owner needs two-step (sensitive permissions)');
ok((await call('POST', '/auth/code/verify', { address: 'owner@example.org', code: own.body.devCode })).status === 400, 'a code works once');
const jar = v.cookie;
const blocked = await call('GET', '/admin/members?limit=1', undefined, jar);
ok(blocked.status === 401 && blocked.body.code === 'two-step', 'admin pages wait for the second step');
const ts = await call('POST', '/auth/two-step/start', {}, jar);
ok(ts.status === 202 && /^\d{6}$/.test(ts.body.devCode), 'two-step code sent');
ok((await call('POST', '/auth/two-step/verify', { code: ts.body.devCode }, jar)).status === 200, 'two-step done');
const members = await call('GET', '/admin/members?limit=2', undefined, jar);
ok(members.status === 200 && members.body.count === 320, `signed-in owner sees members (${members.body.count})`);
const me = await call('GET', '/auth/me', undefined, jar);
ok(me.status === 200 && me.body.email === 'owner@example.org' && me.body.twoStep.ok === true && me.body.actingAs.admin === 'owner', 'me: who, acting as, two-step ok');

/* no cookie, no dev header → nothing */
ok((await call('GET', '/admin/members')).status === 401, 'no session → 401');
ok((await call('GET', '/admin/members', undefined, '', { 'x-admin': 'owner' })).status === 401, 'the x-admin header is off outside tests');
ok((await call('GET', '/admin/members', undefined, 'ms_sid=' + 'x'.repeat(43))).status === 401, 'a made-up cookie is nobody');

/* a member: membership dashboard only, no admin pages */
const mem = await one<{ email: string; id: string }>(db, OWNER, `SELECT m.email, m.id FROM app.members m JOIN platform.organizations o ON o.id = m.org_id WHERE o.slug = 'isgh' AND m.archived IS NULL AND m.approved_on IS NOT NULL AND m.email NOT IN (SELECT 'owner@example.org') ORDER BY m.id LIMIT 1`);
const ms = await signIn(mem!.email);
ok(ms.verify.status === 200 && ms.verify.body.dashboards.length === 1 && ms.verify.body.dashboards[0].kind === 'member', 'member: one dashboard – my membership');
ok((await call('GET', '/admin/members', undefined, ms.jar)).status === 401, 'member cannot open admin pages');
ok((await call('GET', '/auth/me', undefined, ms.jar)).body.actingAs.member === mem!.id, 'member session acts as the member record');

/* several roles: Yasir is Associate Director of a masjid and Area Representative; switch dashboards */
const y = await signIn('ad.se1@example.org');
const kinds = y.verify.body.dashboards.map((d: any) => d.kind);
ok(y.verify.status === 200 && kinds.includes('masjid') && kinds.includes('area') && y.verify.body.chooseDashboard === true, `several dashboards, chooser asks (${kinds.join(', ')})`);
const area = y.verify.body.dashboards.find((d: any) => d.kind === 'area');
const sw = await call('POST', '/auth/dashboard', { index: area.index }, y.jar);
ok(sw.status === 200 && sw.body.current === area.index, 'switched to the area dashboard');
ok((await call('POST', '/auth/dashboard', { index: 99 }, y.jar)).status === 403, 'cannot switch to a dashboard that is not yours');

/* idle sessions end */
await db.run(OWNER, [{ sql: `UPDATE platform.sessions SET last_seen_at = now() - interval '3 hours' WHERE member_id = $1`, params: [mem!.id] }]);
ok((await call('GET', '/auth/me', undefined, ms.jar)).status === 401, 'idle session ended');

/* sign-out */
ok((await call('POST', '/auth/sign-out', {}, y.jar)).status === 200 && (await call('GET', '/auth/me', undefined, y.jar)).status === 401, 'signed out');

/* passwords: off until the organization allows them (publish needs a signed-in admin with two-step) */
ok((await call('POST', '/auth/password', { email: 'owner@example.org', password: 'whatever-long' })).status === 400, 'passwords off by default');
const si = await call('GET', '/admin/documents/sign-in', undefined, jar);
const pub = await call('PUT', '/admin/documents/sign-in', { data: { ...si.body.data, methods: { ...si.body.data.methods, password: true } }, note: 'allow passwords' }, jar);
ok(pub.status === 200, 'owner (session + two-step) publishes the sign-in settings');
ok((await call('POST', '/auth/password/set', { password: 'short' }, jar)).status === 400, 'short password refused');
ok((await call('POST', '/auth/password/set', { password: 'masjid garden 2026 river' }, jar)).status === 200, 'password set');
const pw = await call('POST', '/auth/password', { email: 'owner@example.org', password: 'masjid garden 2026 river' });
ok(pw.status === 200 && !!pw.cookie, 'password sign-in works');
ok((await call('POST', '/auth/password', { email: 'owner@example.org', password: 'nope nope nope' })).status === 401, 'wrong password refused');
const hash = await one<{ hash: string }>(db, OWNER, `SELECT p.hash FROM platform.passwords p JOIN platform.users u ON u.id = p.user_id WHERE u.email = 'owner@example.org'`);
ok(!!hash && hash.hash.startsWith('scrypt$') && !hash.hash.includes('river'), 'password stored as a scrypt hash');
await call('PUT', '/admin/documents/sign-in', { data: si.body.data, note: 'passwords off again' }, jar);

/* Google */
const g = await call('POST', '/auth/google', { idToken: 'fake:treasurer@isgh.org' });
ok(g.status === 200 && g.body.dashboards.some((d: any) => d.kind === 'organization'), 'Google sign-in for an admin');
ok((await call('POST', '/auth/google', { idToken: 'fake:stranger@gmail.com' })).status === 403, 'Google account with no access refused');

/* CSRF: writes from another site are refused */
ok((await call('POST', '/auth/sign-out', {}, jar, { origin: 'https://evil.example' })).status === 403, 'write from a foreign origin refused');
ok((await call('GET', '/auth/me', undefined, jar, { origin: 'https://evil.example' })).status === 200, 'reads are fine');

/* rate limits and lock-out */
for (let i = 0; i < 4; i++) await call('POST', '/auth/code/start', { address: 'board@isgh.org' });
ok((await call('POST', '/auth/code/start', { address: 'board@isgh.org' })).status === 202, '5th code in 15 minutes still ok');
ok((await call('POST', '/auth/code/start', { address: 'board@isgh.org' })).status === 429, '6th code in 15 minutes refused');
for (let i = 0; i < 10; i++) await call('POST', '/auth/code/verify', { address: 'web@isgh.org', code: '123456' });
ok((await call('POST', '/auth/code/start', { address: 'web@isgh.org' })).body.code === 'locked', 'locked after 10 failed tries');
const ev = await rows(db, OWNER, `SELECT method, ok FROM platform.sign_in_events WHERE address = 'owner@example.org'`);
ok(ev.some((e) => e.ok === true) && ev.some((e) => e.ok === false), 'sign-in history kept (ok and failed)');

/* sign out everywhere */
const all = await call('POST', '/auth/sign-out-everywhere', {}, jar);
ok(all.status === 200 && all.body.signedOut >= 2 && (await call('GET', '/auth/me', undefined, pw.cookie)).status === 401, `signed out everywhere (${all.body.signedOut})`);

server.close(); await db.close();
console.log(`auth ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
