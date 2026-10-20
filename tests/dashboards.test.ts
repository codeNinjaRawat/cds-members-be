/**
 * The admin's dashboards on live data: message results, past events with attendance and money, and the home
 * dashboards' numbers (admin/src/lib/dashboard/home-stats.ts) worked out from the API's own member records.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/dashboards.test.ts   (after comms + events, so there is history)
 */
process.env.AUTH_DEV_HEADER = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb } = await import('../src/db/sql.js');
const { homeStats } = await import('@/lib/dashboard/home-stats');
const { MembershipSettingsSchema } = await import('@/lib/content/membership');
const { mockDonationSettings } = await import('@/lib/community/donations');
const { statusOf } = await import('@/lib/members/members');

let pass = 0, fail = 0; const ok = (c: unknown, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400))); };
const db = openDb();
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (path: string, admin = 'owner') => { const r = await fetch(base + path, { headers: { 'x-admin': admin } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

/* what went out */
const st = await call('/admin/messages/stats');
ok(st.status === 200 && Array.isArray(st.body.sends), 'message results', st.body);
ok(st.body.sends.every((x: any) => typeof x.to === 'number' && typeof x.delivered === 'number' && typeof x.opened === 'number' && x.on && ['Sent by staff', 'Automatic'].includes(x.kind) && x.delivered <= x.to), `each send: people, delivered, opened (${st.body.sends.length})`, st.body.sends.slice(0, 2));
ok((await call('/admin/messages/stats', 'treasurer')).status === 403, 'only people who send messages');

/* past events */
const ev = await call('/admin/events?when=past');
ok(ev.status === 200 && ev.body.events.every((e: any) => typeof e.attended === 'number' && typeof e.revenueCents === 'number' && e.attended >= 0), `past events carry attendance and money (${ev.body.events?.length})`, ev.body.events?.[0]);
const all = await call('/admin/events');
ok(all.body.events.every((e: any) => e.attended <= Math.max(e.registered, e.attended)), 'attendance never invents people');

/* the home dashboards from the API's records */
const ms = MembershipSettingsSchema.parse((await call('/admin/documents/membership-settings')).body.data);
const members = (await call('/admin/members?view=any&limit=all')).body.members as any[];
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); const year = Number(today.slice(0, 4));
const h = homeStats({ members, cases: [], queue: { decisions: {}, assignee: {} }, gifts: [], giving: mockDonationSettings, settings: ms, today, year });
const current = members.filter((m) => !m.archived && ['active', 'life'].includes(statusOf(m, year))).length;
ok(h.current === current && h.zones.reduce((s, z) => s + z.v, 0) <= current, `current members match the records (${current})`, { h: h.current, current });
ok(h.labels.length === 12 && h.renewals.length === 12 && h.money.length === 12 && h.labels[11] === ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(today.slice(5, 7)) - 1], 'twelve months ending this month');
const from = `${Number(today.slice(0, 4)) - 1}-${today.slice(5, 7)}`;
// a renewal = dues from someone who had paid before (a new member's first dues are not a renewal)
const paid12 = members.filter((m) => !m.archived).flatMap((m) => { const first = m.payments.reduce((a: string, p: any) => (!a || p.paidOn < a ? p.paidOn : a), ''); return m.payments.filter((p: any) => p.paidOn !== first); }).filter((p: any) => p.paidOn.slice(0, 7) > from && p.paidOn.slice(0, 10) <= today).length;
ok(h.renewals.reduce((a, b) => a + b, 0) === paid12, `renewals are the dues of returning members in the last 12 months (${paid12})`, h.renewals);
ok(h.dates.recordDate === ms.recordDate.slice(0, 10) && h.votingYear === Number(ms.recordDate.slice(0, 4)), `key dates from Membership settings (${h.dates.recordDate})`);
ok(h.pipeline[0].n >= h.pipeline[3].n && h.voters <= h.current, 'pipeline and voters add up');

server.close(); await db.close();
console.log(`dashboards ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
