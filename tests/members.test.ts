/**
 * B2 Members – black-box over HTTP on a migrated + seeded database (the demo map and 320 demo members).
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/members.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { c ? pass++ : (fail++, console.log('FAIL', m)); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, who: string | { cookie: string } = 'owner') => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof who === 'string') { if (who) h['x-admin'] = who; } else h.cookie = who.cookie;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any, cookie: (r.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)?.[0] ?? '' };
};
const zipOf = async (center: string) => (await one<{ zip: string }>(db, OWNER, `SELECT cz.zip FROM app.center_zips cz JOIN app.centers c ON c.org_id = cz.org_id AND c.id = cz.center_id WHERE c.name = $1 ORDER BY cz.zip LIMIT 1`, [center]))!.zip;
const se1 = await zipOf('Southeast Islamic Center 1'); const sw1 = await zipOf('Southwest Islamic Center 1');

/* the seed copied the documents into tables and placed everyone */
const placed = await one<{ n: number; all: number }>(db, OWNER, `SELECT count(*) FILTER (WHERE center_id IS NOT NULL)::int AS n, count(*)::int AS all FROM app.members`);
ok(placed!.n === placed!.all && placed!.all === 320, `every demo member placed in a masjid (${placed!.n}/${placed!.all})`);
const st = await one<{ active: number; pending: number }>(db, OWNER, `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'pending')::int AS pending FROM app.members`);
ok(st!.active > 100 && st!.pending > 0, `statuses from payments (${st!.active} active, ${st!.pending} pending)`);
const first = await call('GET', '/admin/members?limit=3');
ok(first.status === 200 && first.body.members[0].center <= first.body.members[2].center, 'list in the primary sort (masjid first)');

/* create */
const base1 = { first: 'Huda', last: 'Farooqui', email: 'huda.f@example.org', phone: '713-555-0177', dob: '1990-04-02', street: '100 Main St', city: 'Pasadena', zip: se1, plan: 'single', approved: true };
ok((await call('POST', '/admin/members', { first: 'X' })).status === 400, 'missing fields refused');
ok((await call('POST', '/admin/members', { ...base1, plan: 'gold' })).status === 400, 'unknown plan refused');
ok((await call('POST', '/admin/members', base1, 'web-editor')).status === 403, 'website editor cannot add members');
const made = await call('POST', '/admin/members', base1);
ok(made.status === 201 && /^HOU-\d{6}$/.test(made.body.id) && made.body.center === 'Southeast Islamic Center 1', `created ${made.body.id} and placed by ZIP (${made.body.center})`);
const dup = await call('POST', '/admin/members', { ...base1, first: 'Hooda' });
ok(dup.status === 409 && dup.body.detail[0].reasons.includes('Same email'), 'same email → possible duplicate (409)');
ok((await call('POST', '/admin/members', { ...base1, first: 'Hooda', force: true })).status === 201, 'force adds anyway');
ok((await call('POST', '/admin/members', { first: 'Adam', last: 'Ibrahim', email: 'other@example.org', zip: sw1, plan: 'single' }, 'ad-se1')).status === 403, 'masjid role cannot add a member of another masjid');
ok((await call('POST', '/admin/members', { first: 'Sami', last: 'Nasser', email: 'se.new@example.org', zip: se1, plan: 'single' }, 'ad-se1')).status === 201, 'masjid role adds a member of its masjid');
const id = made.body.id;

/* edit */
ok((await call('PATCH', `/admin/members/${id}`, { phone: '(281) 555-0101' }, 'board-secretary')).status === 403, 'edit needs members.edit');
const ed = await call('PATCH', `/admin/members/${id}`, { phone: '281-555-0101', preferred: 'Huda F.' });
ok(ed.status === 200, 'edited');
const row = await one<{ phone: string; preferred_name: string; record: any }>(db, OWNER, 'SELECT phone, preferred_name, record FROM app.members WHERE id = $1', [id]);
ok(row!.phone === '(281) 555-0101' && row!.preferred_name === 'Huda F.' && row!.record.audit.at(-1).action === 'Edited', 'phone formatted, audit in the record');
ok((await call('PATCH', `/admin/members/${id}`, { zip: '1234' })).status === 400, 'bad ZIP refused');
const moved = await call('PATCH', `/admin/members/${id}`, { zip: sw1 });
ok(moved.status === 200 && moved.body.center === 'Southwest Islamic Center 1', 'new ZIP → new masjid');

/* payments → status */
ok((await call('POST', `/admin/members/${id}/payments`, { year: 2026, amountCents: 2500, method: 'check' })).status === 400, 'check needs its number');
const paid = await call('POST', `/admin/members/${id}/payments`, { year: 2026, amountCents: 2500, method: 'check', ref: '1042' });
ok(paid.status === 201 && /^R-\d+$/.test(paid.body.receipt) && paid.body.paid_through === '2026-12-31', `payment recorded (${paid.body.receipt}, paid through ${paid.body.paid_through})`);
ok((await call('POST', `/admin/members/${id}/payments`, { year: 2026, amountCents: 2500, method: 'cash' }, 'web-editor')).status === 403, 'payments need payments.record');

/* center by hand, 5-year lock */
ok((await call('POST', `/admin/members/${id}/center`, { center: 'North Islamic Center 1' })).status === 400, 'a move needs a reason');
const mv = await call('POST', `/admin/members/${id}/center`, { center: 'North Islamic Center 1', reason: 'Lives near the border, prays there' }, 'membership-office');
ok(mv.status === 200 && mv.body.center === 'North Islamic Center 1' && mv.body.lockedUntil > '2030', 'moved by hand, locked 5 years');
ok((await call('POST', `/admin/members/${id}/center`, { center: 'Southwest Islamic Center 1', reason: 'Again' }, 'membership-office')).status === 409, 'second move inside the lock refused');
const zipLater = await call('PATCH', `/admin/members/${id}`, { zip: se1 });
ok(zipLater.body.center === 'North Islamic Center 1', 'a hand placement survives a ZIP change');

/* ID, notes, archive */
ok((await call('POST', `/admin/members/${id}/id-check`, { status: 'rejected' })).status === 400, 'rejecting an ID needs a reason');
ok((await call('POST', `/admin/members/${id}/id-check`, { status: 'verified', docType: 'passport' })).body.idCheck === 'verified', 'ID verified');
ok((await call('POST', `/admin/members/${id}/notes`, { text: 'Called about the Eid volunteer list.' })).status === 201, 'note added');
ok((await call('POST', `/admin/members/${id}/archive`, { reason: 'x' }, 'membership-office')).status === 400, 'archive needs a reason');
ok((await call('POST', `/admin/members/${id}/archive`, { reason: 'Moved away' }, 'board-secretary')).status === 403, 'archive needs members.archive');
ok((await call('POST', `/admin/members/${id}/archive`, { reason: 'Moved away' })).status === 200, 'archived');
ok((await one<{ status: string }>(db, OWNER, 'SELECT status FROM app.members WHERE id = $1', [id]))!.status === 'archived', 'status archived');
ok((await call('POST', `/admin/members/${id}/restore`, {})).status === 200 && (await one<{ status: string }>(db, OWNER, 'SELECT status FROM app.members WHERE id = $1', [id]))!.status === 'active', 'restored and active again');

/* queues */
const qc = await call('GET', '/admin/queues/counts');
ok(qc.status === 200 && qc.body.applications > 0 && 'duplicates' in qc.body, `queue counts (${JSON.stringify(qc.body)})`);
const qse = await call('GET', '/admin/queues/applications', undefined, 'ad-se1');
ok(qse.body.items.every((x: any) => x.center === 'Southeast Islamic Center 1'), `masjid role sees its masjid's applications (${qse.body.count})`);
const scan = await call('POST', '/admin/duplicates/scan', {});
ok(scan.status === 200 && scan.body.pairs >= 1, `duplicate scan (${scan.body.pairs} pairs)`);
const pairs = await call('GET', '/admin/queues/duplicates');
const pr = pairs.body.items[0];
ok((await call('POST', '/admin/duplicates/decide', { a: pr.a, b: pr.b, decision: 'not-duplicate' })).status === 200, 'pair marked not a duplicate');
ok((await call('POST', '/admin/duplicates/decide', { a: pr.a, b: pr.b, decision: 'not-duplicate' })).status === 404, 'a decided pair is gone from the queue');

/* the member's own record (signed in with a code) */
const mem = await one<{ email: string; id: string; center: string }>(db, OWNER, `SELECT email, id, center FROM app.members WHERE status = 'active' AND center = 'Southeast Islamic Center 1' AND center_override IS NULL ORDER BY id LIMIT 1`);
const start = await call('POST', '/auth/code/start', { address: mem!.email }, '');
const ver = await call('POST', '/auth/code/verify', { address: mem!.email, code: start.body.devCode }, '');
const jar = { cookie: ver.cookie };
const me = await call('GET', '/member/me', undefined, jar);
ok(me.status === 200 && me.body.member.id === mem!.id && Array.isArray(me.body.memberships), 'member reads their own record');
ok((await call('PATCH', '/member/me', { email: 'new@example.org' }, jar)).status === 400, 'member cannot change their email here');
ok((await call('PATCH', '/member/me', { phone: '832-555-0199' }, jar)).status === 200, 'member updates their phone');
ok((await call('GET', '/member/me', undefined, '')).status === 401, 'no session → 401');
ok((await call('POST', '/member/center-change', { center: 'North Islamic Center 1', reason: 'x' }, jar)).status === 400, 'center request needs a reason');
const req = await call('POST', '/member/center-change', { center: 'North Islamic Center 1', reason: 'Work is next to it' }, jar);
ok(req.status === 201 && req.body.status === 'pending', 'member asks to change masjid');
ok((await call('POST', '/member/center-change', { center: 'North Islamic Center 1', reason: 'Again please' }, jar)).status === 409, 'one open request at a time');
const dec = await call('POST', `/admin/center-changes/${req.body.id}/decide`, { decision: 'approve' }, 'ad-se1');
ok(dec.status === 403, 'the old masjid’s director cannot move them into another masjid');
const dec2 = await call('POST', `/admin/center-changes/${req.body.id}/decide`, { decision: 'approve' });
ok(dec2.status === 200 && (await one<{ center: string }>(db, OWNER, 'SELECT center FROM app.members WHERE id = $1', [mem!.id]))!.center === 'North Islamic Center 1', 'approved – member moved');

/* import (Wild Apricot style) */
const csv = `User ID,First name,Last name,Email,Phone,Membership level,Membership status,Member since,Zip
10234,Omar,Saleh,omar.saleh@example.org,7135550123,Single,Active,03/04/2019,${se1}
10235,Layla,Haddad,layla.h@example.org,,Single,Lapsed,01/01/2020,${sw1}
10236,,Mahmoud,bad@example.org,,Single,Active,,77002
10237,Rania,Jaber,not-an-email,,Single,Active,,77002`;
const chk = await call('POST', '/admin/members/import/check', { csv, preset: 'wildapricot' });
ok(chk.status === 200 && chk.body.rows.filter((r: any) => r.status === 'ok').length === 2 && chk.body.rows.filter((r: any) => r.errors.length).length === 2, 'import check: 2 ok, 2 with problems');
ok((await call('POST', '/admin/members/import', { csv }, 'membership-office')).status === 201, 'membership officer may import');
const imported = await one<{ status: string; center: string; source: string }>(db, OWNER, `SELECT status, center, source FROM app.members WHERE email = 'omar.saleh@example.org'`);
ok(imported?.source === 'import' && imported.center === 'Southeast Islamic Center 1' && imported.status === 'active', `imported member placed and active (${imported?.status})`);
ok((await one<{ status: string }>(db, OWNER, `SELECT status FROM app.members WHERE email = 'layla.h@example.org'`))!.status === 'expired', 'Lapsed imports as expired');
ok((await one<{ n: number }>(db, OWNER, `SELECT count(*)::int AS n FROM app.imports WHERE rows_created = 2`))!.n === 1, 'import logged');
ok((await call('POST', '/admin/members/import', { csv }, 'web-editor')).status === 403, 'import needs members.archive');

/* audit */
const aud = await call('GET', '/admin/audit');
ok(['Member created', 'Payment recorded', 'Center changed', 'ID verified', 'Archived', 'Import'].every((a) => aud.body.entries.some((e: any) => e.action === a)), 'every change is in the audit log');

/* C4a: what the admin's screens load in live mode */
const every = await call('GET', '/admin/members?view=any&limit=all');
const live = await call('GET', '/admin/members?limit=all');
const total = (await one<{ n: number }>(db, { org: null, role: 'owner' }, `SELECT count(*)::int AS n FROM app.members WHERE org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh')`))!.n;
ok(every.body.members.length === total && every.body.members.length - live.body.members.length === every.body.members.filter((m: any) => m.archived).length, `view=any is every record, archived too (${every.body.members.length}/${total})`);
ok((await call('GET', '/admin/members')).body.members.length <= 200, 'the default page stays 200');
const one1 = every.body.members.find((m: any) => !m.archived);
ok((await call('POST', `/admin/members/${one1.id}/notes`, { text: 'Prefers a call after Maghrib.' })).status === 201, 'note written');
const got = (await call('GET', `/admin/members/${one1.id}`)).body.member;
ok(got.notes.some((x: any) => x.text === 'Prefers a call after Maghrib.' && x.by), 'notes come back with the record');
ok(typeof got.prefs === 'object' || got.prefs === undefined, 'preferences still in the shape');
const act = await call('POST', `/admin/members/${one1.id}/activity`, { action: 'Family outreach', detail: 'Invitation sent to the spouse' });
ok(act.status === 201 && (await call('GET', `/admin/members/${one1.id}`)).body.member.audit.some((x: any) => x.action === 'Family outreach'), 'a step outside the record is kept in its history');
ok((await call('POST', `/admin/members/${one1.id}/activity`, { action: '' })).status === 400, 'it needs a description');
ok((await call('POST', `/admin/members/${one1.id}/activity`, { action: 'Called' }, '')).status === 401, 'and a signed-in admin');

server.close(); await db.close();
console.log(`members ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
