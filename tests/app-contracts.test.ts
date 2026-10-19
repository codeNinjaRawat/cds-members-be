/**
 * C5 The member app's own code against the API: mobile/src/data/liveApi.ts with its HTTP client, its token manager
 * and its zod schemas (a shape the app cannot read fails here). Needs the mobile folder next to BE.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/app-contracts.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.AUTH_DEV_CODES = '1'; process.env.PAYMENTS_PROVIDER = 'fake'; process.env.FILES_DIR = mkdtempSync(join(tmpdir(), 'app-files-'));
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');
const { createClient } = await import('../../mobile/src/core/net/client.ts');
const { SessionManager } = await import('../../mobile/src/core/auth/session.ts');
const { createLiveApi, makeRefresh } = await import('../../mobile/src/data/liveApi.ts');

let pass = 0, fail = 0; const ok = (c: unknown, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`; process.env.PUBLIC_API_URL = base;
const IP = `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
const f: typeof fetch = (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), 'x-forwarded-for': IP } });

const app = () => {
  const box = new Map<string, unknown>();
  const store = { read: async () => (box.get('t') as any) ?? null, write: async (t: unknown) => { box.set('t', t); }, clear: async () => { box.delete('t'); } };
  const refresh = makeRefresh(base, 'isgh', f); const session = new SessionManager(store, refresh); let out = 0;
  const client = createClient({ baseUrl: base, org: 'isgh', fetch: f, getAccessToken: () => session.accessToken(), refresh: () => session.refresh(), onSignedOut: () => { out++; }, sleep: async () => {} });
  return { api: createLiveApi(client, refresh, f), session, out: () => out };
};
const codeFor = async (address: string) => (await one<{ body: string }>(db, OWNER, `SELECT body FROM platform.outbox WHERE to_address = $1 ORDER BY id DESC LIMIT 1`, [address]))!.body.match(/\b(\d{6})\b/)![1];
const tryIt = async <T>(label: string, fn: () => Promise<T>, okIf: (x: T) => unknown, allowNotFound = false) => {
  try { const x = await fn(); ok(okIf(x), label, x); return x; }
  catch (e: any) { if (allowNotFound && e?.failure?.kind === 'notFound') { ok(true, label); return null; } ok(false, `${label} – ${e?.message}`, e?.failure); return null; }
};

const m = await one<{ id: string; email: string }>(db, OWNER, `SELECT m.id, m.email FROM app.members m WHERE m.org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh') AND m.status IN ('active', 'life') AND m.archived IS NULL AND m.email <> '' AND m.center <> ''
  AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY random() LIMIT 1`);
await db.run(OWNER, [{ sql: 'DELETE FROM platform.login_codes WHERE address = $1', params: [m!.email] }]);

const a = app();
await tryIt('bootstrap', () => a.api.bootstrap(), (b) => b.org.slug === 'isgh');
await tryIt('startOtp', () => a.api.startOtp('email', m!.email), (r) => r.channel === 'email' && r.resendAfterSec > 0);
const v = await tryIt('verifyOtp', async () => a.api.verifyOtp('email', m!.email, await codeFor(m!.email)), (r) => r.existingMember && !!r.tokens);
await a.session.signIn(v!.tokens!);
ok(await a.session.isSignedIn(), 'signed in with the tokens');
const me = await tryIt('me', () => a.api.me(), (x) => x.memberId === m!.id && x.card.qr.length > 20);
await tryIt('notifications', () => a.api.notifications(), (x) => Array.isArray(x.items));
await tryIt('renewalOptions', () => a.api.renewalOptions(), (x) => x.plans.length === 1);
await tryIt('payments', () => a.api.payments(), (x) => Array.isArray(x.items));
await tryIt('household', () => a.api.household(), (x) => x.members[0].isSelf);
await tryIt('profile', () => a.api.profile(), (x) => x.fields.length > 3);
await tryIt('updateProfile', () => a.api.updateProfile({ preferred: 'Testy' }), (x) => x.fields.find((f2) => f2.key === 'preferred')?.value === 'Testy');
await tryIt('updateProfile (bad phone → field error)', async () => { try { await a.api.updateProfile({ phone: '1' }); return 'no'; } catch (e: any) { return e?.failure?.kind === 'validation' && e.failure.fields.phone ? 'yes' : JSON.stringify(e?.failure); } }, (x) => x === 'yes');
await tryIt('masjid', () => a.api.masjid(), (x) => x.today.times.length === 6, true);
await tryIt('events', () => a.api.events(), (x) => Array.isArray(x));
await tryIt('givingOptions', () => a.api.givingOptions(), (x) => x.funds.length > 0);
const go = await a.api.givingOptions();
await tryIt('give', () => a.api.give({ fundId: go.funds[0].id, masjidId: go.masjids[0].id, amountCents: 1500, coverFee: false, monthly: false }, 'card', `g-${Date.now()}`), (x) => x.status === 'pending' && !!x.checkoutUrl);
await tryIt('benefits', () => a.api.benefits(), (x) => Array.isArray(x.items));
await tryIt('election', () => a.api.election(), (x) => typeof x.eligible === 'boolean', true);
const pf = await tryIt('preferences', () => a.api.preferences(), (x) => typeof x.directoryListed === 'boolean');
if (pf) await tryIt('updatePreferences', () => a.api.updatePreferences({ ...pf, push: { ...pf.push, events: !pf.push.events } }), (x) => x.push.events === !pf.push.events);
await tryIt('prayerSettings', () => a.api.prayerSettings(), (x) => !!x.center);
await tryIt('family', () => a.api.family(), (x) => x.people.some((p) => p.isSelf));
await tryIt('addFamilyMember', () => a.api.addFamilyMember({ name: 'Hana Contract', relation: 'Daughter', birthYear: 2016 }, `f-${Date.now()}`), (x) => x.people.some((p) => p.name === 'Hana Contract'));
await tryIt('community', () => a.api.community(''), (x) => Array.isArray(x.groups));
await tryIt('masjids', () => a.api.masjids(), (x) => x.length > 0);
await tryIt('checkOMatic', () => a.api.checkOMatic(), (x) => x.thresholdCents > 0, true);
await tryIt('registerPushToken', () => a.api.registerPushToken('ExponentPushToken[c]', 'android'), () => true);
await tryIt('reportCrashes', () => a.api.reportCrashes([{ message: 'x', at: new Date().toISOString() } as never]), () => true);
await tryIt('uploadId', () => a.api.uploadId('data:image/jpeg;base64,/9j/2Q==', `id-${Date.now()}`), (x) => !!x.reference);
await tryIt('requestCenterChange', () => a.api.requestCenterChange('Closer to work.', `c-${Date.now()}`), (x) => !!x.reference);

/* an expired access token is refreshed by the client, once, and the call goes through */
await db.run(OWNER, [{ sql: `UPDATE platform.sessions SET revoked_at = now() WHERE member_id = $1 AND method = 'app' AND revoked_at IS NULL`, params: [m!.id] }]);
const before = (await a.session.tokens())!.refreshToken;
await tryIt('me after the access token ended (refresh on 401)', () => a.api.me(), (x) => x.memberId === m!.id);
ok((await a.session.tokens())!.refreshToken !== before && a.out() === 0, 'new tokens stored, still signed in');
await tryIt('signOut', () => a.api.signOut(false), () => true);

/* join from the app */
const b = app(); const email = `contract-join-${Date.now()}@example.org`;
const jo = await tryIt('joinOptions', () => b.api.joinOptions(), (x) => x.plans.length > 0);
await b.api.startOtp('email', email);
const jv = await tryIt('verifyOtp (new address)', async () => b.api.verifyOtp('email', email, await codeFor(email)), (x) => x.tokens === null && !!x.joinToken);
const zip = (await one<{ zip: string }>(db, OWNER, `SELECT zip FROM app.center_zips WHERE org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh') LIMIT 1`))!.zip;
const address = `200 Elm St, Houston, TX ${zip}`;
const res = await tryIt('lookupResidency', () => b.api.lookupResidency(address), (x) => !!x.center);
if (jo && jv && res) {
  const plan = jo.plans.find((p) => p.category === 'household' && p.memberClass === 'natural') ?? jo.plans[0];
  await tryIt('submitApplication', () => b.api.submitApplication({ email, verified: true, about: { firstName: 'Sami', middleName: '', lastName: 'Contract', preferredName: '', dob: '1988-03-03', phone: '(713) 555-0177', address, unit: '' }, residency: res, planId: plan.id, years: 1,
    spouseEmail: `spouse-${email}`, spouseName: 'Lina Contract', commitments: jo.commitments.slice(0, 1).map((c) => c.id), signature: 'Sami Contract', pledged: true, identityConsent: true, consentEmail: true, consentSms: false, payer: 'self', payerName: '', payerRelation: '', custom: { 'spouse-same-address': true }, idPhoto: null }, 'card', `j-${Date.now()}`),
    (x) => !!x.tokens && /^APP-/.test(x.applicationId) && !!x.checkoutUrl);
}

server.close(); await db.close();
console.log(`app-contracts ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
