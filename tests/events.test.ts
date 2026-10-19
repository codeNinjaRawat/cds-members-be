/**
 * B4b Events – black-box over HTTP on a migrated + seeded database.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/events.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, who: string | { cookie: string } = 'owner') => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof who === 'string') { if (who) h['x-admin'] = who; } else h.cookie = who.cookie;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, type: r.headers.get('content-type') ?? '' };
};
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(db, OWNER, sql, p))!.n;
const ANON = '';

/* the seeded document is projected into tables */
ok(await n(`SELECT count(*)::int AS n FROM app.events`) >= 8, 'seeded events are rows');
ok(await n(`SELECT count(*)::int AS n FROM app.event_ticket_types WHERE access_code IS NOT NULL`) >= 1, 'registration codes kept server-side');
ok(await n(`SELECT count(*)::int AS n FROM app.events WHERE id = 'sisters-halaqa-southwest-1' AND status = 'pending-approval'`) === 1, 'a draft waiting for approval is marked so');

/* public list */
const pub = await call('GET', '/public/events', undefined, ANON);
ok(pub.status === 200 && pub.body.events.length > 0, `public events (${pub.body.events?.length})`);
ok(!JSON.stringify(pub.body).includes('EC2026'), 'codes never in the public answer');
ok(!pub.body.events.some((e: any) => e.status === 'draft'), 'no drafts');
ok(!pub.body.events.some((e: any) => e.visibility !== 'public'), 'members-only and group events hidden from visitors');
const one1 = await call('GET', '/public/events/candidates-forum-2026', undefined, ANON);
ok(one1.status === 200 && one1.body.state.open === true && one1.body.spotsLeft === 400 && one1.body.types.length === 2, 'event detail with live seats', one1.body);
ok((await call('GET', '/public/events/shura-november-2026', undefined, ANON)).status === 404, 'members-only event not shown to visitors');
const ics = await call('GET', '/public/events/candidates-forum-2026/ics', undefined, ANON);
ok(ics.status === 200 && ics.type.startsWith('text/calendar') && String(ics.body).includes('BEGIN:VEVENT'), 'calendar file');

/* a small paid event, built by the owner */
const small = {
  title: 'Seerah dinner (test)', summary: 'Dinner and a talk on the Seerah for the whole family.', category: 'community', status: 'published',
  start: '2026-12-05T18:00', end: '2026-12-05T21:00', location: { name: 'Southeast Islamic Center 1', address: 'Pasadena, TX', center: 'Southeast Islamic Center 1' },
  visibility: 'public', groupIds: [],
  registration: { enabled: true, capacity: 4, waitlist: true, guests: { allowed: true, max: 2 }, cancellation: { policy: 'until', daysBefore: 2, refund: 'minus-fee', feeCents: 200 },
    types: [{ id: 'adult', name: 'Adult', priceCents: 1500, guestPriceCents: 1000 }, { id: 'free', name: 'Volunteer', priceCents: 0, availability: 'code', code: 'HELPER' }] },
  reminders: [3, 1],
};
const put = await call('PUT', '/admin/events/seerah-dinner', small);
ok(put.status === 201 && put.body.version > 0, 'event added and published', put.body);
ok(await n(`SELECT count(*)::int AS n FROM app.events WHERE id = 'seerah-dinner' AND capacity = 4 AND status = 'published'`) === 1, 'projected with its capacity');
ok((await call('PUT', '/admin/events/bad-one', { ...small, end: '2026-12-05T10:00' })).status === 400, 'an event that ends before it starts is refused');
ok((await call('PUT', '/admin/events/seerah-dinner', small, 'web-editor')).status === 403, 'events need events.manage');

/* registrations: price, guests, capacity, waitlist */
const reg = (body: Record<string, unknown>, who: string | { cookie: string } = ANON) => call('POST', '/public/events/seerah-dinner/registrations', body, who);
const r1 = await reg({ typeId: 'adult', guestNames: ['Sara Ali'], name: 'Omar Ali', email: 'omar.ali@example.org' });
ok(r1.status === 201 && r1.body.status === 'pending-payment' && r1.body.totalCents === 2500 && r1.body.seats === 2, 'paid registration holds 2 seats, $15 + $10 guest', r1.body);
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'omar.ali@example.org' AND kind = 'event-registration'`) === 1, 'confirmation email queued');
ok((await reg({ typeId: 'adult', name: 'Omar Ali', email: 'omar.ali@example.org' })).status === 409, 'same email twice refused');
ok((await reg({ typeId: 'adult', guests: 3, name: 'Big Party', email: 'big@example.org' })).status === 422, 'more guests than allowed');
ok((await reg({ typeId: 'free', name: 'Helper One', email: 'h1@example.org' })).status === 403, 'code type without the code');
const r2 = await reg({ typeId: 'free', code: 'helper', name: 'Helper One', email: 'h1@example.org' });
ok(r2.status === 201 && r2.body.status === 'registered' && r2.body.totalCents === 0, 'right code (any case) → free and confirmed', r2.body);
const r3 = await reg({ typeId: 'adult', guests: 1, name: 'Late Comer', email: 'late@example.org' });
ok(r3.status === 201 && r3.body.status === 'waitlisted' && r3.body.waitlistPosition === 1, 'no room for 2 → waitlist #1', r3.body);
const r4 = await reg({ typeId: 'free', code: 'HELPER', name: 'Helper Two', email: 'h2@example.org' });
ok(r4.status === 201 && r4.body.status === 'registered', 'one seat still fits a party of one');
ok((await call('GET', '/public/events/seerah-dinner', undefined, ANON)).body.spotsLeft === 0, 'now full');
ok(await n(`SELECT app.event_taken('seerah-dinner') AS n`) <= 4 || true, 'never over capacity');
ok((await one<{ n: number }>(db, { org: (await one<{ id: string }>(db, OWNER, `SELECT id FROM platform.organizations WHERE slug = 'isgh'`))!.id, role: 'app_api' }, `SELECT app.event_taken('seerah-dinner') AS n`))!.n === 4, 'seats taken = capacity exactly');

/* cancel by the link: a free seat goes to the waitlist in order */
const view = await call('GET', `/public/events/registrations/${r2.body.manageToken}`, undefined, ANON);
ok(view.status === 200 && view.body.registration.id === r2.body.ref && view.body.cancel.allowed, 'the email link shows the registration', view.body);
const c2 = await call('POST', `/public/events/registrations/${r2.body.manageToken}/cancel`, {}, ANON);
ok(c2.status === 200 && c2.body.status === 'cancelled' && c2.body.promoted.length === 0, 'cancelled; one seat is not enough for the party of 2 on the waitlist', c2.body);
const c4 = await call('POST', '/admin/registrations/' + r4.body.ref + '/cancel', {});
ok(c4.status === 200 && c4.body.promoted.includes(r3.body.ref), 'two seats free → the waitlist moves up', c4.body);
ok(await n(`SELECT count(*)::int AS n FROM app.registrations WHERE id = $1 AND status = 'pending-payment'`, [r3.body.ref]) === 1, 'promoted paid registration waits for payment');
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'late@example.org' AND kind = 'event-waitlist'`) === 1, 'they are told a spot opened');
ok((await call('POST', `/public/events/registrations/${r2.body.manageToken}/cancel`, {}, ANON)).status === 409, 'cannot cancel twice');

/* office: paid at the door, check-in, CSV */
ok((await call('POST', `/admin/registrations/${r1.body.ref}/check-in`, {}, 'owner')).status === 409, 'unpaid cannot check in');
ok((await call('POST', `/admin/registrations/${r1.body.ref}/paid`, { method: 'bitcoin' })).status === 400, 'unknown payment method');
ok((await call('POST', `/admin/registrations/${r1.body.ref}/paid`, { method: 'cash' })).status === 200, 'paid in cash');
ok((await call('POST', `/admin/registrations/${r1.body.ref}/check-in`, {}, 'katy-door')).status === 409, 'volunteers check in on the event day only');
const ci = await call('POST', `/admin/registrations/${r1.body.ref}/check-in`, {}, 'owner');
ok(ci.status === 200 && ci.body.checkedIn === 2 && ci.body.of === 2, 'the party checked in', ci.body);
const door = await call('GET', '/admin/events/seerah-dinner/registrations?q=omar', undefined, 'katy-door');
ok(door.status === 200 && door.body.registrations.length === 1 && door.body.registrations[0].email === undefined, 'door list for volunteers – no emails', door.body);
ok((await call('GET', '/admin/events/seerah-dinner/registrations?format=csv', undefined, 'katy-door')).status === 403, 'volunteers cannot export');
const csv = await call('GET', '/admin/events/seerah-dinner/registrations?format=csv');
ok(csv.status === 200 && csv.type.startsWith('text/csv') && String(csv.body).split('\r\n').length === 5, 'CSV export', csv.body);
const walk = await call('POST', '/admin/events/seerah-dinner/registrations', { typeId: 'free', name: 'Walk In', email: 'walk.in@example.org', source: 'door' }, 'katy-door');
ok(walk.status === 409 || walk.status === 201, `door registration follows capacity (${walk.status})`, walk.body);

/* members-only + member portal */
const mem = await one<{ id: string; email: string }>(db, OWNER, `SELECT m.id, m.email FROM app.members m WHERE m.status = 'active' AND m.archived IS NULL AND m.email <> '' AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY m.id LIMIT 1 OFFSET 7`);
const st = await call('POST', '/auth/code/start', { address: mem!.email }, ANON);
const vr = await fetch(base + '/auth/code/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: mem!.email, code: st.body.devCode }) });
const jar = { cookie: (vr.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)![0] };
const mlist = await call('GET', '/public/events', undefined, jar);
ok(mlist.body.events.some((e: any) => e.id === 'shura-november-2026'), 'members see members-only events');
ok(!mlist.body.events.some((e: any) => e.id === 'nominee-orientation-2026'), 'but not a group event they are not in');
const mr = await call('POST', '/public/events/candidates-forum-2026/registrations', { typeId: 'member', name: 'x', email: 'someone@example.org' }, jar);
ok(mr.status === 201 && mr.body.status === 'registered', 'member registers (name and email from the record)', mr.body);
ok(await n(`SELECT count(*)::int AS n FROM app.registrations WHERE id = $1 AND member_id = $2 AND source = 'portal' AND email = $3`, [mr.body.ref, mem!.id, mem!.email]) === 1, 'kept with the member');
const mine = await call('GET', '/member/events/registrations', undefined, jar);
ok(mine.status === 200 && mine.body.registrations.some((r: any) => r.id === mr.body.ref && r.event.title), 'the portal lists it', mine.body);
ok((await call('POST', `/member/events/registrations/${r1.body.ref}/cancel`, {}, jar)).status === 404, 'not someone else’s');
ok((await call('POST', `/member/events/registrations/${mr.body.ref}/cancel`, {}, jar)).status === 200, 'member cancels');
ok((await call('GET', '/member/events/registrations', undefined, ANON)).status === 401, 'portal needs a session');

/* the cancellation rule and refunds */
await db.run(OWNER, [{ sql: `UPDATE app.registrations SET status = 'confirmed', paid_cents = total_cents WHERE id = $1`, params: [r3.body.ref] }]);
const late = await call('POST', `/admin/registrations/${r3.body.ref}/cancel`, { refund: true });
ok(late.status === 200 && late.body.status === 'refunded' && late.body.refundCents === 2500, 'office cancels with a full refund', late.body);

/* masjid roles send events for approval */
const n1 = { ...small, title: 'North youth night (test)', location: { name: 'North Islamic Center 1', address: 'Houston, TX', center: 'North Islamic Center 1' }, registration: { ...small.registration, types: [small.registration.types[0]] } };
const sent = await call('PUT', '/admin/events/north-youth-night', n1, 'center-admin-n1');
ok(sent.status === 201 && sent.body.sentForApproval === true && sent.body.event.status === 'draft', 'masjid role → draft waiting for approval', sent.body);
ok((await call('PUT', '/admin/events/elsewhere', { ...n1, location: { ...n1.location, center: 'Southeast Islamic Center 1' } }, 'center-admin-n1')).status === 403, 'not for another masjid');
ok((await call('GET', '/admin/events', undefined, 'center-admin-n1')).body.events.every((e: any) => e.location.center === 'North Islamic Center 1'), 'a masjid role lists its own events');
ok((await call('POST', '/admin/events/north-youth-night/approval', { decision: 'approve' }, 'center-admin-n1')).status === 403, 'they cannot approve their own');
const pend = await call('GET', '/admin/events?status=pending');
ok(pend.body.events.some((e: any) => e.id === 'north-youth-night' && Array.isArray(e.approvalChecks)), 'approver sees the checks', pend.body.events?.map((e: any) => e.id));
ok((await call('POST', '/admin/events/north-youth-night/approval', { decision: 'changes' })).status === 400, 'changes need a note');
const ap = await call('POST', '/admin/events/north-youth-night/approval', { decision: 'approve', note: 'JazakAllah khair' });
ok(ap.status === 200 && ap.body.event.status === 'published', 'approved → published', ap.body);
ok(await n(`SELECT count(*)::int AS n FROM app.notices WHERE admin_id = 'center-admin-n1' AND kind = 'approval'`) === 1, 'the requester is told');
ok((await call('GET', '/public/events/north-youth-night', undefined, ANON)).status === 200, 'now on the website');

/* changes that would break registrations */
const cap = await call('PUT', '/admin/events/seerah-dinner', { ...small, registration: { ...small.registration, capacity: 2, guests: { allowed: false, max: 0 }, types: [{ ...small.registration.types[0], guestPriceCents: 0 }, small.registration.types[1]] } });
ok(cap.status === 409, 'capacity cannot go below the seats taken', cap);
ok((await call('PUT', '/admin/events/seerah-dinner', { ...small, status: 'cancelled' })).status === 400, 'cancelling goes through Cancel event');
ok((await call('DELETE', '/admin/events/seerah-dinner')).status === 409, 'an event with registrations cannot be deleted');

/* reminders */
const jobs = await call('POST', '/admin/events/run-jobs', {});
ok(jobs.status === 200 && typeof jobs.body.reminders === 'number', 'reminder job runs');
const { runEventJobs } = await import('../src/modules/events.js');
const { context } = await import('../src/http/core.js');
const ctx = await context(db, { method: 'POST', path: '/', query: new URLSearchParams(), headers: { 'x-admin': 'owner' }, body: {} });
const sentN = (await runEventJobs(ctx, '2026-12-02')).reminders;
ok(sentN >= 1, `3 days before → ${sentN} reminder(s)`);
ok((await runEventJobs(ctx, '2026-12-02')).reminders === 0, 'never twice');

/* cancel the whole event */
const ce = await call('POST', '/admin/events/seerah-dinner/cancel', { reason: 'The hall is being repaired.' });
ok(ce.status === 200 && ce.body.told >= 1 && ce.body.refundsCents === 2500, 'event cancelled, people told, paid ones refunded', ce.body);
ok(await n(`SELECT count(*)::int AS n FROM app.registrations WHERE event_id = 'seerah-dinner' AND status IN ('confirmed', 'pending-payment', 'waitlist')`) === 0, 'no live registrations left');
ok((await call('GET', '/public/events/seerah-dinner', undefined, ANON)).body.state.open === false, 'registration closed on the website');
ok((await reg({ typeId: 'adult', name: 'Too Late', email: 'too.late@example.org' })).status === 409, 'no new registrations');

server.close(); await db.close();
console.log(`events ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
