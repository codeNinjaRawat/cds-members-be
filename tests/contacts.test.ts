/**
 * Contacts (0034): a visitor of a masjid leaves name, email and mobile once; the office sees the list.
 * DATABASE_URL=… tsx tests/contacts.test.ts
 */
export {};
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');
let pass = 0, fail = 0; const ok = (c: unknown, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const IP = `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
const call = async (method: string, path: string, body?: unknown, h: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-org': 'isgh', 'x-forwarded-for': IP, ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };   // eslint-disable-line @typescript-eslint/no-explicit-any
};
const admin = (method: string, path: string, body?: unknown) => call(method, path, body, { 'x-admin': 'owner' });
const email = `visitor.${Date.now()}@example.com`;
const masjid = await one<{ code: string }>(db, OWNER, `SELECT code FROM app.centers WHERE org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh') AND active ORDER BY sort, name LIMIT 1`);

const bad = await call('POST', '/app/contacts', { firstName: 'A', lastName: 'Alam', email: 'nope', phone: '123' });
ok(bad.status === 422 && bad.body.fields?.firstName && bad.body.fields?.email && bad.body.fields?.phone, 'every field is checked', bad.body);
const c1 = await call('POST', '/app/contacts', { masjidId: masjid!.code, firstName: 'Akhter', lastName: 'Alam', email: email.toUpperCase(), phone: '(713) 555-0101' });
ok(c1.status === 201 && c1.body.contactId && c1.body.masjidId === masjid!.code && c1.body.email === email && c1.body.phone === '7135550101' && c1.body.memberId === null, 'a visitor leaves name, email and mobile', c1.body);
const c2 = await call('POST', '/app/contacts', { firstName: 'Akhtar', lastName: 'Alam', email, phone: '7135550101' });
ok(c2.status === 201 && c2.body.contactId === c1.body.contactId && c2.body.firstName === 'Akhtar' && c2.body.masjidId === masjid!.code, 'the same person again = the same contact (name updated, masjid kept)', c2.body);
ok((await call('POST', '/app/contacts', { masjidId: 'no-such', firstName: 'Akhter', lastName: 'Alam', email, phone: '7135550101' })).status === 422, 'an unknown masjid is refused');
const g = await call('GET', `/app/contacts/${c1.body.contactId}`);
ok(g.status === 200 && g.body.email === email, 'the phone reads its contact back');
ok((await call('GET', '/app/contacts/00000000-0000-0000-0000-000000000000')).status === 404, 'an unknown id is 404');
const p = await call('PATCH', `/app/contacts/${c1.body.contactId}`, { phone: '713-555-0102', masjidId: '' });
ok(p.status === 200 && p.body.phone === '7135550102' && p.body.masjidId === null, 'details and the masjid can change', p.body);
ok((await call('PATCH', `/app/contacts/${c1.body.contactId}`, { email: 'x' })).status === 422, 'a bad change is refused');
ok((await call('GET', '/admin/contacts')).status === 401, 'the office list needs an admin sign-in');
const list = await admin('GET', `/admin/contacts?q=${encodeURIComponent(email)}`);
ok(list.status === 200 && list.body.contacts.length === 1 && list.body.contacts[0].contactId === c1.body.contactId, 'the office finds the contact', list.body);
const note = await admin('PATCH', `/admin/contacts/${c1.body.contactId}`, { note: 'Called back' });
ok(note.status === 200 && note.body.note === 'Called back', 'the office keeps a note');
/* a member with the same email shows the link */
const m = await one<{ email: string; id: string }>(db, OWNER, `SELECT email::text, id FROM app.members WHERE org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh') AND email <> '' AND archived IS NULL AND status = 'active' ORDER BY random() LIMIT 1`);
const c3 = await call('POST', '/app/contacts', { firstName: 'Some', lastName: 'Member', email: m!.email, phone: '7135550199' });
ok(c3.status === 201 && c3.body.memberId === m!.id, 'a contact whose email is a member\'s shows the member', c3.body);
/* visitors see public events; registering needs a contact */
const ev = await call('GET', '/app/events');
ok(ev.status === 200 && Array.isArray(ev.body), 'a visitor sees the public events', ev.body);
const open = (ev.body as any[]).find((e) => e.registration?.status === 'none' && e.canRegister);
if (open) {
  ok((await call('POST', `/app/events/${open.id}/register`, { seats: 1 })).status === 401, 'registering without a contact asks for one');
  const reg = await call('POST', `/app/events/${open.id}/register`, { seats: 1, contactId: c1.body.contactId });
  ok(reg.status === 201 && ['registered', 'waitlisted'].includes(reg.body.registration?.status) && reg.body.registration.ticket, 'a visitor registers with their contact', reg.body);
  const again = await call('GET', `/app/events/${open.id}?contactId=${c1.body.contactId}`);
  ok(again.status === 200 && again.body.registration?.status !== 'none' && again.body.canRegister === false, 'and sees it next time (no second registration)', again.body);
}
ok((await admin('DELETE', `/admin/contacts/${c3.body.contactId}`)).body?.ok === true && (await admin('DELETE', `/admin/contacts/${c1.body.contactId}`)).body?.ok === true, 'the office can remove a contact');
ok((await call('GET', `/app/contacts/${c1.body.contactId}`)).status === 404, 'and it is gone');


/* People (0036): a contact becomes a member and a donor – same person, more facts */
{
  const pe = 'people.one@example.org';
  const c = await call('POST', '/app/contacts', { masjidId: masjid!.code, firstName: 'Pia', lastName: 'People', email: pe, phone: '7135550177' });
  ok(c.status === 201, 'a contact');
  let list = await admin('GET', '/admin/people?q=people.one');
  ok(list.status === 200 && list.body.people.length === 1 && list.body.people[0].stage === 'contact' && list.body.funnel.people >= 1, 'People list: a plain contact', list.body);
  // the join form starts with the contact's name and mobile
  const st = await call('POST', '/public/join/email/start', { email: pe });
  const vr = await call('POST', '/public/join/email/verify', { email: pe, code: st.body.devCode });
  ok(vr.status === 200 && vr.body.data?.about?.firstName === 'Pia' && vr.body.data?.about?.phone === '(713) 555-0177', 'the join form is pre-filled from the contact', vr.body);
  // a gift → donor
  const gift = await admin('POST', '/admin/donations', { amountCents: 5000, platform: 'cash', fund: 'general', center: 'North Islamic Center 1', name: 'Pia People', email: pe, givenOn: '2026-10-01' });
  list = await admin('GET', '/admin/people?q=people.one');
  ok(gift.status === 201 && list.body.people[0].stage === 'donor' && list.body.people[0].giving.count === 1 && list.body.people[0].giving.cents === 5000, `gift recorded → donor (${gift.status} ${gift.body?.error ?? ''})`, list.body.people[0]);
  // becomes a member by hand (office) → member+donor
  const mem = await admin('POST', '/admin/members', { first: 'Pia', last: 'People', email: pe, phone: '7135550177', zip: '77098', plan: 'single', approved: true, force: true });
  list = await admin('GET', '/admin/people?q=people.one');
  ok(mem.status === 201 && list.body.people[0].stage === 'member+donor' && list.body.people[0].member?.id === mem.body.id, `added as a member → member+donor (${mem.status} ${mem.body?.error ?? ''})`, list.body.people[0]);
  const one = await admin('GET', `/admin/people/${c.body.contactId}`);
  ok(one.status === 200 && one.body.gifts.length === 1 && one.body.member?.id === mem.body.id, 'one person: gifts and member facts', one.body);
  const tg = await admin('PATCH', `/admin/people/${c.body.contactId}`, { tags: ['youth', 'new to Houston'] });
  ok(tg.status === 200 && tg.body.tags.length === 2, 'tags');
  const kinds = { contacts: (await admin('GET', '/admin/people?kind=contacts')).body.people.every((p: any) => p.stage === 'contact'), donors: (await admin('GET', '/admin/people?kind=donors')).body.people.every((p: any) => p.giving.count > 0) };
  ok(kinds.contacts && kinds.donors, 'filters by kind', kinds);
  const msg = await call('POST', `/admin/contacts/${c.body.contactId}/message`, { subject: 'Welcome', body: 'Assalamu alaikum' }, { 'x-admin': 'comms' });
  ok(msg.status === 200, 'an email to a contact is queued', msg.body);
}

console.log(`contacts: ${pass} passed, ${fail} failed`); server.close(); await db.close?.(); process.exit(fail ? 1 : 0);
