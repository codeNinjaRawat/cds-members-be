/**
 * C3 – the admin's documents through the API: reading, publishing with the admin's own server checks, resetting.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/documents.test.ts   (uses ISGH; another organization when one exists)
 */
process.env.AUTH_DEV_HEADER = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: unknown, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, admin = 'owner', h: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin': admin } : {}), ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

/* reading */
const home = await call('GET', '/admin/documents/home', undefined, 'web-editor');
ok(home.status === 200 && home.body.data && typeof home.body.version === 'number' && 'publishedAt' in home.body, 'a website editor reads documents (no member permission needed)', home.body);
ok((await call('GET', '/admin/documents/integrations', undefined, 'web-editor')).status === 403, 'but not the integrations');
ok((await call('GET', '/admin/documents/home', undefined, '')).status === 401, 'nobody signed in reads nothing');
const other = await one<{ slug: string }>(db, OWNER, `SELECT slug FROM platform.organizations WHERE slug <> 'isgh' ORDER BY created_at LIMIT 1`);
if (other) {
  const owner = await one<{ id: string }>(db, OWNER, `SELECT a->>'id' AS id FROM app.documents d, jsonb_array_elements(d.data->'admins') a WHERE d.key = 'admin-access' AND d.org_id = (SELECT id FROM platform.organizations WHERE slug = $1) AND a->>'roleId' = 'owner' LIMIT 1`, [other.slug]);
  const g = await call('GET', '/admin/documents/giving', undefined, owner?.id ?? 'owner', { 'x-org': other.slug });
  ok(g.status === 200 && !JSON.stringify(g.body.data).includes('ISGH') && !JSON.stringify(g.body.data).includes('Houston'), `another organization's unpublished document is its starter content (${other.slug})`, g.body.data);
}

/* publishing */
const v0 = home.body.version;
const pub = await call('PUT', '/admin/documents/home', { data: home.body.data, baseVersion: v0, note: 'C3 test' });
ok(pub.status === 200 && pub.body.ok && pub.body.version === v0 + 1 && pub.body.publishedAt, `published v${pub.body.version}`, pub.body);
const stale = await call('PUT', '/admin/documents/home', { data: home.body.data, baseVersion: v0, note: 'stale' });
ok(stale.status === 409 && /newer version/.test(stale.body.error), 'publishing over a newer version is refused (409)');
ok((await call('PUT', '/admin/documents/home', { data: { nonsense: true } })).status === 400, 'an invalid document is refused');
ok((await call('PUT', '/admin/documents/home', { data: home.body.data }, 'treasurer')).status === 403, 'a role without the permission cannot publish');

const th = await call('GET', '/admin/documents/themes');
const ugly = JSON.parse(JSON.stringify(th.body.data)); const t0 = Object.keys(ugly.themes)[0];
const walk = (o: any) => { for (const k of Object.keys(o)) { if (typeof o[k] === 'string' && /^#[0-9a-f]{6}$/i.test(o[k])) o[k] = '#777777'; else if (o[k] && typeof o[k] === 'object') walk(o[k]); } };
walk(ugly.themes[t0]);
const tc = await call('PUT', '/admin/documents/themes', { data: ugly });
ok(tc.status === 400 && /hard to read/.test(tc.body.error), 'unreadable theme colors are refused', tc.body);

const integ = await call('GET', '/admin/documents/integrations');
const changed = JSON.parse(JSON.stringify(integ.body.data)); changed.email.mode = changed.email.mode === 'live' ? 'test' : 'live';
const fe = await call('PUT', '/admin/documents/integrations', { data: changed });
ok(fe.status === 409 || fe.status === 400, `a provider mode change needs a second admin (four eyes) (${fe.status}: ${fe.body?.error})`);

const acc = await call('GET', '/admin/documents/admin-access');
const leader = (acc.body.data.admins as any[]).find((a) => a.status === 'active' && ['associate-director'].includes(a.roleId));
if (leader) {
  const roles = JSON.parse(JSON.stringify(acc.body.data)); roles.requireTwoStepFor = roles.requireTwoStepFor === 'none' ? 'sensitive' : 'none';
  const tp = await call('PUT', '/admin/documents/admin-access', { data: roles }, leader.id);
  ok(tp.status === 403 && /sign-in rules/.test(tp.body.error), 'a masjid leader cannot change the sign-in rules', tp.body);
}
const noOwner = JSON.parse(JSON.stringify(acc.body.data)); noOwner.admins = noOwner.admins.map((a: any) => (a.roleId === 'owner' ? { ...a, status: 'suspended' } : a));
ok((await call('PUT', '/admin/documents/admin-access', { data: noOwner })).status === 400, 'the last active owner cannot be removed');
ok((await call('DELETE', '/admin/documents/admin-access')).status === 409, 'the admin list cannot be reset');

/* an election's recorded facts change only through the election steps */
const el = await call('GET', '/admin/documents/elections');
if (el.body.data.elections.length) {
  const e0 = el.body.data.elections[0];
  const bump = (f: (e: any) => void) => { const d = JSON.parse(JSON.stringify(el.body.data)); f(d.elections[0]); return d; };
  for (const [what, f] of [['status', (e: any) => { e.status = e.status === 'closed' ? 'planning' : 'closed'; }], ['voter list', (e: any) => { e.voters = { frozenOn: '2026-07-01', count: 1 }; }], ['nominations', (e: any) => { if (e.nominations[0]) e.nominations[0].note = 'Changed by publishing'; else e.status = e.status; }], ['counts', (e: any) => { e.results = e.results.length ? [] : [{ seatKey: e.seats[0]?.key ?? 'x', ballotsCast: 1, spoiled: 0, counts: [], winners: [], note: '' }]; }]] as const) {
    const r = await call('PUT', '/admin/documents/elections', { data: bump(f) });
    ok(r.status === 409 && /election desk/.test(r.body.error), `publishing cannot change the ${what} (${e0.year})`, r.body);
  }
  const rules = await call('PUT', '/admin/documents/elections', { data: bump((e) => { e.rules = { ...e.rules, certifiedBy: 'Election Commission (test)' }; }) });
  ok(rules.status === 200, 'its rules are still published as a document', rules.body);
}

/* reset to the starter content: a new version, history kept */
const before = (await call('GET', '/admin/documents/home?versions=1')).body;
const rs = await call('DELETE', '/admin/documents/home');
const after = (await call('GET', '/admin/documents/home?versions=1')).body;
ok(rs.status === 200 && after.version === before.version + 1 && after.note === 'Back to the starter content', 'reset is published as a new version', after);
ok(after.versions.length >= before.versions.length && after.versions.some((x: any) => x.version === before.version && x.publishedAt && !('data' in x)), 'and the earlier versions stay in the history');
const full = (await call('GET', '/admin/documents/home?versions=full')).body.versions;
ok(full.length && full.every((x: any) => x.data && typeof x.version === 'number'), 'with their content on request (load into draft)');

server.close(); await db.close();
console.log(`documents ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
