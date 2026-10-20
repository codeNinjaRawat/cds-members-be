/**
 * B4f Groups and communication – black-box over HTTP on a migrated + seeded database.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/comms.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 600))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`; process.env.PUBLIC_API_URL = base; process.env.FILES_DIR = `/tmp/files-comms-${process.pid}`;
const call = async (method: string, path: string, body?: unknown, who: string | { cookie: string } = 'owner') => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof who === 'string') { if (who) h['x-admin'] = who; } else h.cookie = who.cookie;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(db, OWNER, sql, p))!.n;
const signIn = async (offset: number) => {
  const m = (await one<{ id: string; email: string }>(db, OWNER, `SELECT m.id, m.email FROM app.members m WHERE m.status = 'active' AND m.archived IS NULL AND m.email <> '' AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY m.id LIMIT 1 OFFSET ${offset}`))!;
  const st = await call('POST', '/auth/code/start', { address: m.email }, '');
  const vr = await fetch(base + '/auth/code/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: m.email, code: st.body.devCode }) });
  return { ...m, jar: { cookie: (vr.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)![0] } };
};

/* groups: projection, sizes, automatic members */
ok(await n(`SELECT count(*)::int AS n FROM app.groups`) >= 10, 'groups projected from the document');
const gl = await call('GET', '/admin/groups');
const vote = gl.body.groups.find((g: any) => g.id === 'voting-2026');
ok(gl.status === 200 && vote.size > 0 && vote.memberIds === undefined, `automatic group “Can vote” has ${vote?.size} people`);
ok(gl.body.groups.find((g: any) => g.id === 'nominee-orientation-2026') === undefined && gl.body.groups.find((g: any) => g.id === 'nominees-2026').usedBy.length >= 1, 'where a group is used (events)');
const rf = await call('POST', '/admin/groups/refresh', {});
ok(rf.status === 200 && rf.body.groups >= 5, 'automatic groups recomputed');
ok(await n(`SELECT count(*)::int AS n FROM app.group_members WHERE group_id = 'voting-2026' AND how = 'rule'`) === vote.size, 'and kept as rows (events and pages read them)');
ok((await call('POST', '/admin/groups/refresh', {}, 'web-editor')).status === 403, 'refresh needs groups.manage');
const gm = await call('GET', '/admin/groups/voting-2026/members');
ok(gm.body.count === vote.size && !JSON.stringify(gm.body).includes('@'), 'member list without emails');

/* manual groups: the office adds, members join, ask, leave */
ok((await call('POST', '/admin/groups/nominees-2026/members', { add: ['HOU-000000'] })).status === 422, 'only real members');
const a = await signIn(3); const b = await signIn(4);
ok((await call('POST', '/admin/groups/nominees-2026/members', { add: [a.id] })).status === 200, 'office adds to a manual group');
ok(await n(`SELECT count(*)::int AS n FROM app.group_members WHERE group_id = 'nominees-2026' AND member_id = $1 AND how = 'added'`, [a.id]) === 1, 'projected');
const mg = await call('GET', '/member/groups', undefined, a.jar);
ok(mg.status === 200 && mg.body.groups.some((g: any) => g.id === 'volunteers' && g.action === 'join'), 'member sees groups they may join', mg.body);
ok((await call('POST', '/member/groups/elected-2026/join', {}, a.jar)).status === 409, 'office-kept groups cannot be joined');
ok((await call('POST', '/member/groups/volunteers/join', {}, a.jar)).status === 200, 'joins an open group');
ok(await n(`SELECT count(*)::int AS n FROM app.group_members WHERE group_id = 'volunteers' AND member_id = $1 AND how = 'joined'`, [a.id]) === 1, 'kept as joined');
ok((await call('POST', '/member/groups/volunteers/join', {}, a.jar)).status === 409, 'not twice');
ok((await call('POST', '/member/groups/sisters-quran-sw/request', {}, b.jar)).status === 200, 'asks to join a circle');
ok((await call('POST', '/member/groups/sisters-quran-sw/request', {}, b.jar)).status === 409, 'one request at a time');
const rq = await call('GET', '/admin/groups/requests');
ok(rq.body.requests.some((r: any) => r.memberId === b.id && r.groupId === 'sisters-quran-sw'), 'the request waits for the office');
ok((await call('POST', `/admin/groups/sisters-quran-sw/requests/${b.id}`, { decision: 'approve' })).status === 200, 'approved');
ok((await call('GET', '/member/groups', undefined, b.jar)).body.groups.find((g: any) => g.id === 'sisters-quran-sw')?.isIn === true, 'now in the circle');
ok((await call('POST', '/member/groups/volunteers/leave', {}, a.jar)).status === 200, 'leaves');
ok(await n(`SELECT count(*)::int AS n FROM app.group_members WHERE group_id = 'volunteers' AND member_id = $1`, [a.id]) === 0, 'gone from the rows too');
await call('POST', '/member/groups/volunteers/join', {}, a.jar);

/* preferences */
const pr = await call('GET', '/member/preferences', undefined, a.jar);
ok(pr.status === 200 && pr.body.topics.some((t: any) => t.id === 'membership' && !t.optional), 'official notices are marked as always on');
const pu = await call('PUT', '/member/preferences', { email: true, sms: false, optOut: ['newsletter', 'membership'] }, a.jar);
ok(pu.status === 200 && pu.body.prefs.optOut.includes('newsletter') && !pu.body.prefs.optOut.includes('membership'), 'newsletter off; official notices cannot be switched off', pu.body);

/* bulk email: draft → preview → send */
ok((await call('POST', '/admin/messages', { name: 'Volunteers', channel: 'email', topic: 'announcement', subject: 'Help', body: 'x', audience: { everyone: false, groupIds: [] } }, 'comms')).status === 422, 'an audience is needed');
ok((await call('POST', '/admin/messages', { name: 'X', channel: 'email', topic: 'announcement', subject: 'Hi', body: 'Hi', audience: { everyone: true } }, 'web-editor')).status === 403, 'sending needs comms.send');
const d1 = await call('POST', '/admin/messages', { name: 'Volunteer day', channel: 'email', topic: 'announcement', subject: 'Volunteer day on Saturday', body: 'Assalamu alaikum {Member.FirstName},\n\nWe need help on Saturday at {Member.Center}. Reply to this email.\n\n{Org.ShortName}', audience: { everyone: false, groupIds: ['volunteers'] } }, 'comms');
ok(d1.status === 201, 'draft saved', d1.body);
const pv = await call('POST', `/admin/messages/${d1.body.id}/preview`, {}, 'comms');
ok(pv.status === 200 && pv.body.recipients >= 1 && pv.body.problems.length === 0 && pv.body.sample.body.includes('77098') && pv.body.sample.body.includes('email-preferences?t='), 'preview: who, problems, the exact text with footer and preferences link', pv.body);
ok(!pv.body.sample.body.includes('[First name]'), 'merge fields filled');
const s1 = await call('POST', `/admin/messages/${d1.body.id}/send`, {}, 'comms');
ok(s1.status === 200 && s1.body.status === 'sent' && s1.body.sent === pv.body.recipients, `sent to ${s1.body.sent}`, s1.body);
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE kind = 'bulk' AND to_address = $1 AND subject = 'Volunteer day on Saturday'`, [a.email]) === 1, 'queued for the provider');
ok(await n(`SELECT count(*)::int AS n FROM app.deliveries WHERE message_id = $1::uuid`, [d1.body.id]) === s1.body.sent, 'one delivery row per person');
ok((await call('POST', `/admin/messages/${d1.body.id}/send`, {}, 'comms')).status === 409, 'a message goes out once');
ok((await call('PUT', `/admin/messages/${d1.body.id}`, { name: 'x', channel: 'email', topic: 'announcement', subject: 'y', body: 'z', audience: { everyone: true } }, 'comms')).status === 409, 'a sent message does not change');

/* who is skipped and why */
const d2 = await call('POST', '/admin/messages', { name: 'Newsletter', channel: 'email', topic: 'newsletter', subject: 'October newsletter', body: 'News from {Org.Name}.', audience: { everyone: false, groupIds: ['volunteers', 'sisters-quran-sw'] } }, 'comms');
const pv2 = await call('POST', `/admin/messages/${d2.body.id}/preview`, {}, 'comms');
ok(pv2.body.skipped.some((s: any) => s.reason.includes('chose not')), 'the member who left newsletters is skipped', pv2.body.skipped);
const bad = await call('POST', '/admin/messages', { name: 'Bad', channel: 'email', topic: 'announcement', subject: 'Event', body: 'Join {Event.Title} – {Member.Foo}', audience: { everyone: false, groupIds: ['volunteers'] } }, 'comms');
const sb = await call('POST', `/admin/messages/${bad.body.id}/send`, {}, 'comms');
ok(sb.status === 422 && sb.body.detail.some((p: any) => p.message.includes('Member.Foo')) && sb.body.detail.some((p: any) => p.message.includes('Event.Title')), 'unknown and one-person merge fields stop the send', sb.body);
const sms = await call('POST', '/admin/messages', { name: 'Text', channel: 'sms', topic: 'announcement', body: 'Jumuah moved to 1:30 today.', audience: { everyone: false, groupIds: ['volunteers'] } }, 'comms');
ok((await call('POST', `/admin/messages/${sms.body.id}/send`, {}, 'comms')).status === 422, 'texts are switched off in the settings');

/* scheduled sends and the job */
const later = await call('POST', '/admin/messages', { name: 'Reminder', channel: 'email', topic: 'events', subject: 'Family night', body: 'See you on Saturday.', audience: { everyone: false, groupIds: ['volunteers'] }, sendAt: '2027-01-05T10:00' }, 'comms');
const sc = await call('POST', `/admin/messages/${later.body.id}/send`, {}, 'comms');
ok(sc.body.status === 'scheduled', 'scheduled for later');
ok((await call('POST', `/admin/messages/${later.body.id}/cancel`, {}, 'comms')).body.status === 'cancelled', 'and cancelled');
const l2 = await call('POST', '/admin/messages', { name: 'Reminder 2', channel: 'email', topic: 'events', subject: 'Family night (2)', body: 'See you on Saturday.', audience: { everyone: false, groupIds: ['volunteers'] }, sendAt: '2027-01-05T10:00' }, 'comms');
await call('POST', `/admin/messages/${l2.body.id}/send`, {}, 'comms');
await db.run(OWNER, [{ sql: `UPDATE app.messages SET scheduled_for = now() - interval '1 minute' WHERE id = $1::uuid`, params: [l2.body.id] }]);
const jobs = await call('POST', '/admin/messages/run-jobs', {});
ok(jobs.status === 200 && jobs.body.messages === 1 && jobs.body.sent >= 1, 'the job sends what is due', jobs.body);

/* unsubscribe from the link in the email */
const mail = await one<{ body: string }>(db, OWNER, `SELECT body FROM platform.outbox WHERE kind = 'bulk' AND to_address = $1 ORDER BY id LIMIT 1`, [a.email]);
const token = mail!.body.match(/email-preferences\?t=([A-Za-z0-9_.-]+)/)![1];
const un = await call('GET', `/public/unsubscribe/${token}`, undefined, '');
ok(un.status === 200 && un.body.address.includes('•••') && !un.body.address.includes(a.email), 'the link shows a masked address', un.body);
ok((await call('GET', `/public/unsubscribe/${token.slice(0, -1)}0`, undefined, '')).status === 404 || token.endsWith('0'), 'a changed link does not work');
ok((await call('POST', '/public/unsubscribe', { token, topic: 'membership' }, '')).status === 400, 'official notices stay on');
ok((await call('POST', '/public/unsubscribe', { token }, '')).status === 200, 'unsubscribed from everything optional');
const d3 = await call('POST', '/admin/messages', { name: 'Events', channel: 'email', topic: 'events', subject: 'Events this week', body: 'Programs at every masjid.', audience: { everyone: false, groupIds: ['volunteers'] } }, 'comms');
const pv3 = await call('POST', `/admin/messages/${d3.body.id}/preview`, {}, 'comms');
ok(pv3.body.skipped.some((s: any) => s.reason.includes('chose not')), 'they are skipped next time');
const d4 = await call('POST', '/admin/messages', { name: 'AGM', channel: 'email', topic: 'membership', subject: 'Annual General Meeting notice', body: 'The AGM is on 14 March.', audience: { everyone: false, groupIds: ['volunteers'] } }, 'comms');
ok((await call('POST', `/admin/messages/${d4.body.id}/preview`, {}, 'comms')).body.recipients >= 1, 'but still get the official AGM notice');

/* group leaders */
ok((await call('POST', '/member/groups/volunteers/message', { subject: 'Hi', body: 'Hello' }, a.jar)).status === 403, 'only leaders may email a group (and only when allowed)');
const list = await call('GET', '/admin/messages', undefined, 'comms');
ok(list.status === 200 && list.body.messages.length >= 6, 'message list');

/* a member's groups (profile), a message to named people with a picture */
{
  const anyone = await one<{ id: string }>(db, OWNER, `SELECT id FROM app.members WHERE status = 'active' AND archived IS NULL AND email <> '' ORDER BY id LIMIT 1`);
  const mg = await call('GET', `/admin/members/${anyone!.id}/groups`);
  ok(mg.status === 200 && Array.isArray(mg.body.groups) && mg.body.groups.length > 0 && mg.body.groups.every((g: any) => typeof g.isIn === 'boolean' && ['manual', 'automatic'].includes(g.kind)), 'a member’s groups with in / out', mg.body);
  ok((await call('GET', '/admin/members/HOU-000000/groups')).status === 404, '… unknown member');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const nf = await call('POST', '/admin/files', { area: 'comms', name: 'flyer.png', mime: 'image/png', bytes: png.length }, 'comms');
  ok(nf.status === 201 && nf.body.upload?.url, 'a picture for a message can be uploaded with comms.send', nf.body);
  await fetch(nf.body.upload.url, { method: 'PUT', headers: nf.body.upload.headers, body: png });
  const done = await call('POST', `/admin/files/${nf.body.id}/complete`, {}, 'comms');
  ok(done.status === 200, 'picture stored', done.body);
  const d = await call('POST', '/admin/messages', { name: 'One person', channel: 'email', topic: 'announcement', subject: 'For you', body: 'Hello {Member.FirstName}', audience: { everyone: false, groupIds: [], memberIds: [anyone!.id] }, images: [{ fileId: nf.body.id, name: 'flyer.png' }] }, 'comms');
  ok(d.status === 201, 'a message to a named member with a picture', d.body);
  const pv = await call('POST', `/admin/messages/${d.body.id}/preview`, {}, 'comms');
  ok(pv.status === 200 && pv.body.recipients === 1, 'preview: exactly that person', pv.body);
  const s = await call('POST', `/admin/messages/${d.body.id}/send`, {}, 'comms');
  ok(s.status === 200 && s.body.sent === 1, 'sent to one', s.body);
  const ob = await one<{ body: string }>(db, OWNER, `SELECT body FROM platform.outbox WHERE ref = $1 ORDER BY id DESC LIMIT 1`, [`msg:${d.body.id}`]);
  ok(!!ob && /\[image\] http/.test(ob.body) && /files\/raw\//.test(ob.body), 'the email carries the picture link', ob?.body.slice(-200));
  ok((await call('POST', '/admin/messages', { name: 'T', channel: 'sms', topic: 'announcement', body: 'Hi', audience: { everyone: true }, images: [{ fileId: nf.body.id }] }, 'comms')).status === 422, 'no pictures by text');
}
console.log(`comms ${pass}/${pass + fail}`);

server.close(); await db.close();
console.log(`comms ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
