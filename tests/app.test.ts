/**
 * C5 The member app on the API: sign-in with tokens (rotation, reuse, sign-out), and each screen's answer in the shape
 * the app reads (mobile/src/data/contracts*.ts – checked with the app's own schemas in tests/app-contracts.test.ts).
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/app.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1'; process.env.PAYMENTS_PROVIDER = 'fake'; process.env.FILES_DIR = mkdtempSync(join(tmpdir(), 'app-files-'));
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: unknown, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`; process.env.PUBLIC_API_URL = base;
const IP = `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
let token = '';
const call = async (method: string, path: string, body?: unknown, h: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-org': 'isgh', 'x-forwarded-for': IP, ...(token ? { authorization: `Bearer ${token}` } : {}), ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const anon = (method: string, path: string, body?: unknown, h: Record<string, string> = {}) => { const t = token; token = ''; return call(method, path, body, h).finally(() => { token = t; }); };

/* a member who can renew (paid through the past, nothing waiting) with an email of their own */
const m = await one<{ id: string; email: string; first_name: string }>(db, OWNER, `SELECT m.id, m.email, m.first_name FROM app.members m WHERE m.org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh')
  AND m.status IN ('active', 'expired') AND m.archived IS NULL AND m.email <> '' AND m.plan IN ('single', 'family') AND m.paid_through < current_date AND m.center <> ''
  AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id)
  AND NOT EXISTS (SELECT 1 FROM app.payments p WHERE p.member_id = m.id AND p.kind = 'dues' AND p.status IN ('pending', 'check_pending')) ORDER BY random() LIMIT 1`);
await db.run(OWNER, [{ sql: 'DELETE FROM platform.login_codes WHERE address = $1', params: [m!.email] }]);

/* bootstrap */
const boot = await anon('GET', '/app/bootstrap');
ok(boot.status === 200 && boot.body.org.slug === 'isgh' && boot.body.otp.length === 6 && typeof boot.body.flags === 'object' && boot.body.links.join.endsWith('/join'), 'bootstrap: organization, code rules, links', boot.body);
ok((await anon('GET', '/app/me')).status === 401, 'the member screens need a token');

/* sign-in */
const st = await anon('POST', '/app/auth/otp/start', { channel: 'email', value: m!.email.toUpperCase(), client: 'mobile' });
ok(st.status === 202 && st.body.channel === 'email' && st.body.sentTo.includes('•••') && st.body.devCode, 'a code is sent (address masked)', st.body);
ok((await anon('POST', '/app/auth/otp/verify', { channel: 'email', value: m!.email, code: st.body.devCode === '000000' ? '111111' : '000000' })).status === 400, 'a wrong code is refused');
const vr = await anon('POST', '/app/auth/otp/verify', { channel: 'email', value: m!.email, code: st.body.devCode });
ok(vr.status === 200 && vr.body.existingMember === true && vr.body.tokens?.accessToken && vr.body.tokens.refreshToken && vr.body.tokens.expiresAt > Date.now(), 'a member gets tokens', vr.body);
token = vr.body.tokens.accessToken; let refresh = vr.body.tokens.refreshToken;
const me = await call('GET', '/app/me');
ok(me.status === 200 && me.body.memberId === m!.id && me.body.profile.email && me.body.card.qr.startsWith('MS1.isgh.') && Array.isArray(me.body.eligibility.checks), 'me: the card, the checks', me.body);
ok((await fetch(base + '/member/portal', { headers: { cookie: `ms_sid=${token}`, 'x-org': 'isgh' } })).status === 401, 'an app token does not work as a browser cookie');
const card = await fetch(base + '/admin/member-card/check', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': 'owner', 'x-org': 'isgh' }, body: JSON.stringify({ token: me.body.card.qr }) }).then((r) => r.json()) as any;
ok(card.valid === true && card.memberId === m!.id, 'the office reads a scanned card', card);
const forged = await fetch(base + '/admin/member-card/check', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': 'owner', 'x-org': 'isgh' }, body: JSON.stringify({ token: me.body.card.qr.replace(m!.id, 'ISGH-000001') }) }).then((r) => r.json()) as any;
ok(forged.valid === false, 'and a changed card is not ours');

/* refresh: rotation, reuse ends the chain */
const r1 = await anon('POST', '/app/auth/token/refresh', { refreshToken: refresh });
ok(r1.status === 200 && r1.body.accessToken !== token && r1.body.refreshToken !== refresh, 'refresh gives a new pair', r1.body);
const r2 = await anon('POST', '/app/auth/token/refresh', { refreshToken: refresh });
ok(r2.status === 401, 'the old refresh token used again is refused');
ok((await call('GET', '/app/me', undefined, { authorization: `Bearer ${r1.body.accessToken}` })).status === 401, '… and the whole chain is signed out');
ok((await anon('POST', '/app/auth/token/refresh', { refreshToken: r1.body.refreshToken })).status === 401, '… including its newest refresh token');
ok((await anon('POST', '/app/auth/token/refresh', { refreshToken: 'x'.repeat(43) }, { 'x-org': 'cvic-austin' })).status === 401, 'a made-up token is refused');

/* sign in again for the screens */
await db.run(OWNER, [{ sql: 'DELETE FROM platform.login_codes WHERE address = $1', params: [m!.email] }]);
const st2 = await anon('POST', '/app/auth/otp/start', { channel: 'email', value: m!.email });
const vr2 = await anon('POST', '/app/auth/otp/verify', { channel: 'email', value: m!.email, code: st2.body.devCode });
token = vr2.body.tokens.accessToken; refresh = vr2.body.tokens.refreshToken;
ok((await call('POST', '/app/devices', { pushToken: 'ExponentPushToken[test]', platform: 'ios' }, { 'x-client': 'member-app/1.0' })).status === 200, 'the phone is registered');

/* renewals */
const ro = await call('GET', '/app/renewals/options');
ok(ro.status === 200 && ro.body.plans.length === 1 && ro.body.plans[0].current && ro.body.pledgeVersion && ro.body.methods.length, 'renewal options from the settings', ro.body);
const plan = ro.body.plans[0];
if (plan.eligible) {
  const q = await call('POST', '/app/renewals/quote', { planId: plan.id, years: 1, payerId: 'self', pledgeVersion: ro.body.pledgeVersion });
  ok(q.status === 200 && q.body.totalCents > 0 && q.body.lines.length, 'a quote', q.body);
  ok((await call('POST', '/app/renewals/quote', { planId: 'life', years: 1, payerId: 'self', pledgeVersion: '' })).status === 409, 'another plan is the office’s job');
  ok((await call('POST', '/app/renewals', { planId: plan.id, years: 1, payerId: 'self', pledgeVersion: 'old', method: 'card' })).status === 409, 'an old pledge is refused');
  const key = `renew-${Date.now()}`;
  const rn = await call('POST', '/app/renewals', { planId: plan.id, years: 1, payerId: 'self', pledgeVersion: ro.body.pledgeVersion, method: 'wallet' }, { 'idempotency-key': key });
  ok(rn.status === 201 && rn.body.status === 'pending' && rn.body.amountCents === q.body.totalCents && rn.body.checkoutUrl?.includes('/pay/fake'), 'renewal: pending, card page to open', rn.body);
  const again = await call('POST', '/app/renewals', { planId: plan.id, years: 1, payerId: 'self', pledgeVersion: ro.body.pledgeVersion, method: 'wallet' }, { 'idempotency-key': key });
  ok(again.status === 201 && again.body.id === rn.body.id, 'the same request again (same key) gets the same answer – no second payment', again.body);
  const n = await call('GET', '/app/notifications');
  ok(n.status === 200 && n.body.unread >= 1 && n.body.items[0].kind === 'membership', 'a notice on the bell', n.body);
  ok((await call('POST', '/app/notifications/read', { ids: 'all' })).status === 200 && (await call('GET', '/app/notifications')).body.unread === 0, 'marked read');
  const pays = await call('GET', '/app/payments');
  ok(pays.status === 200 && pays.body.items.some((p: any) => p.status === 'pending' && p.category === 'dues'), 'payments list the waiting dues', pays.body.items?.slice(0, 3));
} else console.log(`INFO renewal not open for ${m!.id}: ${plan.reason}`);

/* household, profile */
const hh = await call('GET', '/app/household');
ok(hh.status === 200 && hh.body.members[0].isSelf && typeof hh.body.canInviteSpouse === 'boolean', 'household', hh.body);
const pr = await call('GET', '/app/profile');
ok(pr.status === 200 && pr.body.fields.some((f: any) => f.key === 'email' && !f.editable) && pr.body.residency.center, 'profile: the email is the office’s', pr.body.residency);
const ph = await call('PATCH', '/app/profile', { phone: '(713) 555-0142' });
ok(ph.status === 200 && ph.body.fields.find((f: any) => f.key === 'phone').value.includes('555-0142'), 'the phone is changed', ph.body.fields);
ok((await call('PATCH', '/app/profile', { phone: '12' })).status === 422, 'a bad phone is refused');
ok((await call('PATCH', '/app/profile', { email: 'x@y.org' })).status === 422, 'the email is not changed here');
const cr = await call('POST', '/app/center-requests', { reason: 'I moved closer to another masjid.' }, { 'idempotency-key': `center-${Date.now()}` });
ok(cr.status === 201 && cr.body.reference, 'a masjid-change request goes to the office', cr.body);

/* photo ID: ask → upload → done */
const up = await call('POST', '/app/id-checks', { name: 'id.jpg', mime: 'image/jpeg', bytes: 4 });
ok(up.status === 201 && up.body.fileId && up.body.upload.method === 'PUT', 'an upload address for the photo ID', up.body);
if (up.status === 201) {
  await fetch(up.body.upload.url, { method: 'PUT', headers: up.body.upload.headers, body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  const done = await call('POST', `/app/id-checks/${up.body.fileId}/complete`);
  ok(done.status === 200 && done.body.reference && ((p) => p.id.pending === true || p.id.verified === true)((await call('GET', '/app/profile')).body), 'sent – the profile says it waits for review', done.body);
}

/* masjid, prayer times, masjids */
const mq = await call('GET', '/app/masjid');
ok(mq.status === 200 && mq.body.name && mq.body.today.times.length === 6, 'my masjid with today’s times', mq.body.today);
const pt = await call('GET', '/app/prayer-times');
ok(pt.status === 200 && pt.body.settings.method && pt.body.center, 'prayer settings for the app’s own calculation');
const ms = await anon('GET', '/app/masjids');
ok(ms.status === 200 && Array.isArray(ms.body) && ms.body.every((x: any) => typeof x.lat === 'number' && typeof x.lng === 'number'), `masjids with places (${ms.body?.length})`);

/* events */
const ev = await call('GET', '/app/events');
ok(ev.status === 200 && Array.isArray(ev.body) && ev.body.every((e: any) => e.registration && typeof e.canRegister === 'boolean'), `events (${ev.body?.length})`);
const open1 = ev.body.find((e: any) => e.canRegister && e.priceCents === 0);
if (open1) {
  const rg = await call('POST', `/app/events/${open1.id}/register`, { seats: 1 }, { 'idempotency-key': `reg-${Date.now()}` });
  ok(rg.status === 201 && rg.body.registration.status !== 'none', `registered for ${open1.id}`, rg.body.registration);
  const cn = await call('POST', `/app/events/${open1.id}/cancel`, {}, { 'idempotency-key': `cancel-${Date.now()}` });
  ok(cn.status === 200 && cn.body.registration.status === 'cancelled', 'and cancelled', cn.body.registration);
} else console.log('INFO no free open event in the data');

/* giving */
const go = await call('GET', '/app/giving/options');
ok(go.status === 200 && go.body.funds.length && go.body.masjids.length, 'giving options from Donation settings');
const gift = await call('POST', '/app/giving/donations', { fundId: go.body.funds.find((f: any) => !/zakat/i.test(f.label))?.id ?? go.body.funds[0].id, masjidId: go.body.masjids[0].id, amountCents: 2500, coverFee: true, monthly: false, method: 'card' }, { 'idempotency-key': `gift-${Date.now()}` });
ok(gift.status === 201 && gift.body.status === 'pending' && gift.body.amountCents >= 2500 && gift.body.checkoutUrl, 'a gift opens the card page', gift.body);
ok((await call('POST', '/app/giving/donations', { fundId: 'general', masjidId: go.body.masjids[0].id, amountCents: 50 })).status === 422, 'less than $1 is refused');

/* benefits, election, preferences */
const bn = await call('GET', '/app/benefits');
ok(bn.status === 200 && Array.isArray(bn.body.items) && bn.body.items.every((i: any) => i.eligible || i.code === null), 'benefits: codes only for those who may use them');
const el = await call('GET', '/app/election');
ok(el.status === 200 ? typeof el.body.eligible === 'boolean' && Array.isArray(el.body.candidates) : el.status === 404, `election (${el.status})`, el.body);
const pf = await call('GET', '/app/preferences');
ok(pf.status === 200 && typeof pf.body.email.newsletter === 'boolean' && pf.body.devices.some((d: any) => d.current), 'preferences and this phone', pf.body);
const pf2 = await call('PATCH', '/app/preferences', { ...pf.body, email: { newsletter: false, reminders: true }, push: { membership: true, masjid: false, events: true }, directoryListed: true });
ok(pf2.status === 200 && pf2.body.email.newsletter === false && pf2.body.email.reminders === true && pf2.body.push.masjid === false && pf2.body.directoryListed === true, 'preferences saved', pf2.body);
const dx = await call('POST', '/app/data-export', {}, { 'idempotency-key': `export-${Date.now()}` });
ok(dx.status === 201 && dx.body.sentTo.includes('•••'), 'my data by email');
ok((await call('POST', '/app/data-export', {})).status === 429, 'once a day');

/* family, community, check-o-matic */
const fam = await call('GET', '/app/family');
ok(fam.status === 200 && fam.body.people.some((p: any) => p.isSelf && p.memberId === m!.id) && fam.body.relations.includes('Son'), 'family tree', fam.body);
const add = await call('POST', '/app/family', { name: 'Zayd Test', relation: 'Son', birthYear: 2015 }, { 'idempotency-key': `fam-${Date.now()}` });
ok(add.status === 201 && add.body.people.some((p: any) => p.name === 'Zayd Test' && p.relation === 'Son' && p.generation === 1 && p.canJoinOn), 'a child is added (and can join at 18)', add.body.people);
const sis = await call('POST', '/app/family', { name: 'Maryam Test', relation: 'Sister', birthYear: 1990 });
ok(sis.status === 201 && sis.body.people.some((p: any) => p.name === 'Maryam Test' && p.relation === 'Sister'), 'a sister without parents in the tree', sis.body.people);
ok((await call('POST', '/app/family', { name: 'One', relation: 'Son', birthYear: 2015 })).status === 422, 'a full name is needed');
const web = await fetch(base + `/admin/members/${m!.id}/family`, { headers: { 'x-admin': 'owner', 'x-org': 'isgh' } }).then((r) => r.json()) as any;
ok(web.family && web.family.people.some((p: any) => p.first === 'Zayd'), 'the same tree the website shows');
const com = await call('GET', '/app/community?q=');
ok(com.status === 200 && Array.isArray(com.body.groups) && typeof com.body.listed === 'boolean', 'community', { listed: com.body.listed, groups: com.body.groups?.length });
const joinable = com.body.groups?.find((g: any) => !g.joined && !g.pending && g.kind !== 'automatic');
if (joinable) { const j = await call('POST', `/app/groups/${joinable.id}/join`, {}, { 'idempotency-key': `grp-${Date.now()}` }); ok(j.status === 200 && j.body.groups.find((g: any) => g.id === joinable.id && (g.joined || g.pending)), `joined ${joinable.id}`, j.body.groups); }
const co = await call('GET', '/app/check-o-matic');
ok(co.status === 200 ? co.body.thresholdCents > 0 && co.body.deadline : co.status === 404, `check-o-matic (${co.status})`, co.body);
if (co.status === 200) { const u = await call('PATCH', '/app/check-o-matic', { amountCents: co.body.minCents + 500 }); ok(u.status === 200 && u.body.amountCents === co.body.minCents + 500, 'monthly amount saved'); ok((await call('PATCH', '/app/check-o-matic', { amountCents: 1 })).status === 422, 'below the minimum is refused'); }

/* join: a new address proves its email and applies */
const email = `app-join-${Date.now()}@example.org`;
const jo = await anon('GET', '/app/join/options');
ok(jo.status === 200 && jo.body.plans.length && jo.body.pledge.version && jo.body.form, 'join options', Object.keys(jo.body ?? {}));
const js = await anon('POST', '/app/auth/otp/start', { channel: 'email', value: email });
ok(js.status === 202 && js.body.devCode && js.body.sentTo.includes('•••'), 'a new address gets a code – the same answer as a member');
const jv = await anon('POST', '/app/auth/otp/verify', { channel: 'email', value: email, code: js.body.devCode });
ok(jv.status === 200 && jv.body.tokens === null && jv.body.existingMember === false && jv.body.joinToken, 'not a member yet: a join token', jv.body);
const place = await one<{ zip: string; city: string; state: string }>(db, OWNER, `SELECT z.zip, coalesce(g.city, 'Houston') AS city, coalesce(g.state, 'TX') AS state FROM app.center_zips z LEFT JOIN geo.postal_codes g ON g.code = z.zip WHERE z.org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh') LIMIT 1`).catch(() => null)
  ?? { zip: '77036', city: 'Houston', state: 'TX' };
const address = `100 Main St, ${place.city}, ${place.state} ${place.zip}`;
const res = await anon('POST', '/app/residency', { address });
ok(res.status === 200 && res.body.center && res.body.inServiceArea, `placed by the ZIP (${place.zip} → ${res.body?.center})`, res.body);
const single = jo.body.plans.find((p: any) => p.category === 'individual' && p.memberClass === 'natural' && p.priceCents > 0) ?? jo.body.plans[0];
const draft = { email, verified: true, joinToken: jv.body.joinToken, about: { firstName: 'Amal', middleName: '', lastName: 'Tester', preferredName: '', dob: '1990-05-05', phone: '(713) 555-0199', address, unit: '' }, residency: res.body,
  planId: single.id, years: 1, spouseEmail: '', commitments: jo.body.commitments.slice(0, 1).map((c: any) => c.id), signature: 'Amal Tester', pledged: true, identityConsent: true, consentEmail: true, consentSms: false, payer: 'self', payerName: '', payerRelation: '', custom: {}, hasIdPhoto: false, method: 'card', client: 'mobile' };
ok((await anon('POST', '/app/join/applications', { ...draft, signature: 'Someone Else' })).body?.detail?.signature, 'a wrong signature is shown on the signature field');
const ap = await anon('POST', '/app/join/applications', draft, { 'idempotency-key': `join-${Date.now()}` });
ok(ap.status === 201 && /^APP-/.test(ap.body.applicationId) && ap.body.tokens?.accessToken && ap.body.checkoutUrl, 'applied: signed in as the new member, card page to open', ap.body);
if (ap.body?.tokens) { const nm = await call('GET', '/app/me', undefined, { authorization: `Bearer ${ap.body.tokens.accessToken}` }); ok(nm.status === 200 && nm.body.status === 'Pending approval', 'the new member waits for approval', nm.body.status); }
ok((await anon('POST', '/app/join/applications', draft)).status === 401, 'the join token works once');

/* crashes, tenancy, sign-out */
ok((await anon('POST', '/app/crashes', { reports: [{ message: 'TypeError: x is undefined', stack: 'at Home', appVersion: '1.0.0', platform: 'ios' }] })).status === 202, 'crash reports are kept');
process.env.TENANT_FROM_HOST = '1';
const t1 = await anon('GET', '/app/bootstrap', undefined, { host: 'api.example.net' });
ok(t1.status === 200 && t1.body.org.slug === 'isgh', 'the app names its organization even where the address decides for websites', t1.body?.org);
ok((await anon('GET', '/public/centers', undefined, { host: 'api.example.net' })).status === 404, '… but only on the app’s routes');
delete process.env.TENANT_FROM_HOST;
ok((await call('POST', '/app/auth/logout', { allDevices: false })).status === 200 && (await call('GET', '/app/me')).status === 401, 'sign out ends this phone');
ok((await anon('POST', '/app/auth/token/refresh', { refreshToken: refresh })).status === 401, '… and its refresh token');
ok(!(await one(db, OWNER, `SELECT 1 AS x FROM app.member_devices WHERE member_id = $1 AND push_token = 'ExponentPushToken[test]'`, [m!.id])), '… and no more notices go to it');

server.close(); await db.close();
console.log(`app ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
