/**
 * B6a SaaS platform API – staff sign-in, organizations, actions, panel documents, invitations, support sign-ins.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/platform.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1'; process.env.DNS_FAKE = '1'; process.env.PLATFORM_OWNER_EMAIL = 'founder@masajid.test';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, h: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any, cookie: (r.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)?.[0] ?? '' };
};
const staff = { 'x-staff': 'founder@masajid.test' };
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(db, OWNER, sql, p))!.n;
const actOn = (slug: string, body: unknown, h = staff) => call('POST', `/platform/orgs/${slug}/actions`, body, h);

/* who may use the panel */
ok((await call('GET', '/platform/state')).status === 401, 'the panel needs a staff sign-in');
ok((await call('GET', '/platform/state', undefined, { 'x-staff': 'owner@example.org' })).status === 403, 'an organization’s admin is not platform staff');
const st0 = await call('GET', '/platform/state', undefined, staff);
const isgh = st0.body.tenants.find((t: any) => t.slug === 'isgh');
ok(st0.status === 200 && isgh?.clientNo === 1 && isgh.usage.members > 0 && st0.body.me.role === 'owner', 'the first owner comes from the environment; ISGH is client #1', st0.body.me);
ok(!JSON.stringify(st0.body.tenants).includes('token_hash') && !JSON.stringify(st0.body).includes('"token":"inv'), 'no invitation tokens in the state');

/* staff sign-in: an emailed code AND a password */
const c1 = await call('POST', '/platform/auth/code/start', { email: 'founder@masajid.test' });
ok(c1.status === 202 && /^\d{6}$/.test(c1.body.devCode), 'code sent');
ok((await call('POST', '/platform/auth/code/start', { email: 'stranger@example.org' })).body.devCode === undefined, 'strangers get the same answer and no code');
ok((await call('POST', '/platform/auth/code/verify', { email: 'founder@masajid.test', code: c1.body.devCode, password: 'short' })).status === 400, 'the first sign-in must choose a real password');
const v1 = await call('POST', '/platform/auth/code/verify', { email: 'founder@masajid.test', code: c1.body.devCode, password: 'Platform-Owner-2026!' });
ok(v1.status === 200 && !!v1.cookie, 'signed in with code + new password');
ok((await call('GET', '/platform/state', undefined, { cookie: v1.cookie })).status === 200, 'the session opens the panel');
const c2 = await call('POST', '/platform/auth/code/start', { email: 'founder@masajid.test' });
ok((await call('POST', '/platform/auth/code/verify', { email: 'founder@masajid.test', code: c2.body.devCode, password: 'wrong-password-123' })).status === 400, 'a right code with a wrong password is refused');

/* panel documents with versions */
const team = await call('GET', '/platform/docs/team', undefined, staff);
const nextTeam = { staff: [...team.body.data.staff, { id: 'help', name: 'Help desk', email: 'help@masajid.test', role: 'support', twoFactor: true, active: true }, { id: 'books', name: 'Books', email: 'books@masajid.test', role: 'billing', twoFactor: true, active: true }, { id: 'look', name: 'Looker', email: 'look@masajid.test', role: 'readonly', twoFactor: true, active: true }] };
ok((await call('PUT', '/platform/docs/team', { data: nextTeam, baseVersion: team.body.version }, staff)).status === 200, 'team saved');
ok((await call('PUT', '/platform/docs/team', { data: nextTeam, baseVersion: team.body.version }, staff)).status === 409, 'an old version cannot overwrite a newer one');
ok((await call('PUT', '/platform/docs/team', { data: { staff: [{ ...nextTeam.staff[1], role: 'support' }] }, baseVersion: team.body.version + 1 }, staff)).status === 400, 'the team keeps an active owner');
ok((await call('GET', '/platform/state', undefined, { 'x-staff': 'help@masajid.test' })).body.me.role === 'support', 'new support staff can sign in');
ok((await call('GET', '/platform/docs/team', undefined, { 'x-staff': 'help@masajid.test' })).status === 403, 'only the owner sees the team');
const plans = await call('GET', '/platform/docs/plans', undefined, staff);
ok((await call('PUT', '/platform/docs/plans', { data: plans.body.data, baseVersion: plans.body.version }, { 'x-staff': 'help@masajid.test' })).status === 403, 'support cannot change prices');
ok(await n(`SELECT count(*)::int AS n FROM platform.saas_plans WHERE id IN ('starter', 'growth', 'network')`) === 3, 'plans projected');

/* a new organization */
const org = { name: 'Crescent Valley Islamic Center', shortName: 'CVIC', type: 'masjid', city: 'Austin', state: 'TX', email: 'office@crescent.example', slug: 'crescent', template: 'simple-masjid', planId: 'growth', cycle: 'monthly', trial: true, owner: { name: 'Huda Rahman', email: 'huda@crescent.example' }, modules: { sms: 'on' } };
ok((await call('POST', '/platform/orgs', { ...org, slug: 'admin' }, staff)).status === 400 || (await call('POST', '/platform/orgs', { ...org, slug: 'admin' }, staff)).status === 409, 'reserved addresses are refused');
ok((await call('POST', '/platform/orgs', { ...org, slug: 'isgh' }, staff)).status === 409, 'an address in use is refused');
ok((await call('POST', '/platform/orgs', org, { 'x-staff': 'books@masajid.test' })).status === 403, 'billing staff do not create organizations');
const cr = await call('POST', '/platform/orgs', org, { 'x-staff': 'help@masajid.test' });
ok(cr.status === 201 && cr.body.tenant.clientNo >= 2 && cr.body.tenant.status === 'trial' && cr.body.tenant.trialEndsOn && /token=[A-Za-z0-9_-]{40,}/.test(cr.body.invite), `client #${cr.body.tenant?.clientNo} on a trial, owner invited`, cr.body);
const crId = (await one<{ id: string }>(db, OWNER, `SELECT id::text FROM platform.organizations WHERE slug = 'crescent'`))!.id;
const doc = async (key: string) => (await one<{ data: any }>(db, OWNER, 'SELECT data FROM app.documents WHERE org_id = $1::uuid AND key = $2', [crId, key]))?.data;
ok((await doc('admin-access')).admins.length === 1 && (await doc('admin-access')).admins[0].email === 'huda@crescent.example' && (await doc('org-structure')).centers.length === 0, 'starter documents: the owner only, an empty map');
ok((await doc('officials')).holders.length === 0 && (await doc('events')).events.length === 0 && (await doc('fundraising')).campaigns.length === 0, 'no ISGH officials, events or campaigns');
const pubEv = await call('GET', '/public/events', undefined, { 'x-org': 'crescent' });
ok(pubEv.status === 200 && pubEv.body.events.length === 0, 'the new website shows none of ISGH’s events');
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'huda@crescent.example' AND kind = 'invitation'`) === 1, 'the invitation email is queued');
ok(await n(`SELECT count(*)::int AS n FROM platform.org_modules WHERE org_id = $1::uuid AND module = 'sms' AND value = 'on'`, [crId]) === 1, 'add-on module recorded');

/* the invitation, accepted on the organization's own address */
const token = cr.body.invite.match(/token=([A-Za-z0-9_-]+)/)[1];
ok((await call('GET', `/auth/invitations/${token}`, undefined, { 'x-org': 'isgh' })).status === 404, 'an invitation works only on its organization’s address');
const inv = await call('GET', `/auth/invitations/${token}`, undefined, { 'x-org': 'crescent' });
ok(inv.status === 200 && inv.body.email === 'huda@crescent.example' && inv.body.needsPassword, 'invitation shown', inv.body);
ok((await call('POST', `/auth/invitations/${token}/accept`, { password: '123' }, { 'x-org': 'crescent' })).status === 400, 'a weak password is refused');
ok((await call('POST', `/auth/invitations/${token}/accept`, { password: 'Crescent-Owner-77', name: 'Huda Rahman' }, { 'x-org': 'crescent' })).status === 200, 'accepted');
ok((await call('POST', `/auth/invitations/${token}/accept`, { password: 'Crescent-Owner-77' }, { 'x-org': 'crescent' })).status === 404, 'a link works once');
ok((await doc('admin-access')).admins[0].status === 'active' && await n(`SELECT count(*)::int AS n FROM platform.org_admin_users WHERE org_id = $1::uuid AND status = 'active' AND role = 'owner'`, [crId]) === 1, 'the owner is active in both lists');
const ownerId = (await doc('admin-access')).admins[0].id;
const me = await call('GET', '/admin/platform/me', undefined, { 'x-org': 'crescent', 'x-admin': ownerId });
ok(me.status === 200 && me.body.org.name === org.name && me.body.org.trialDaysLeft > 20 && me.body.modules.includes('sms') && Array.isArray(me.body.announcements), 'the org admin sees its own platform facts', me.body);
ok((await call('GET', '/admin/platform/me', undefined, { 'x-org': 'crescent', 'x-admin': 'owner' })).status === 401, 'ISGH’s admins are nobody at Crescent');

/* actions */
ok((await actOn('crescent', { type: 'suspend', reason: 'short' })).status === 400, 'a suspension needs a reason');
ok((await actOn('crescent', { type: 'suspend', reason: 'The trial payment card was declined twice.' })).body.tenant.status === 'suspended', 'suspended');
ok((await call('GET', '/public/events', undefined, { 'x-org': 'crescent' })).status === 423, 'a suspended organization is paused');
ok((await actOn('crescent', { type: 'restore' })).body.tenant.status === 'trial', 'restored to its trial');
ok((await actOn('isgh', { type: 'cancel', reason: 'Testing the founding guard here.' })).status === 409, 'ISGH can never be cancelled');
ok((await actOn('crescent', { type: 'cancel', reason: 'Testing that support cannot cancel.' }, { 'x-staff': 'help@masajid.test' })).status === 403, 'only the platform owner cancels');
const ext = await actOn('crescent', { type: 'extendTrial', days: 14 }, { 'x-staff': 'books@masajid.test' });
ok(ext.status === 200 && ext.body.tenant.trialEndsOn > cr.body.tenant.trialEndsOn, 'trial extended');
ok((await actOn('crescent', { type: 'plan', planId: 'starter', cycle: 'annual' }, { 'x-staff': 'books@masajid.test' })).body.tenant.planId === 'starter', 'plan changed');
ok((await actOn('isgh', { type: 'plan', planId: 'starter', cycle: 'annual' }, { 'x-staff': 'books@masajid.test' })).status === 409, 'not a plan smaller than what they use');
ok((await actOn('crescent', { type: 'module', module: 'members', value: 'off' })).status === 409, 'core modules stay on');
ok((await actOn('crescent', { type: 'invite', name: 'Owner Two', email: 'two@crescent.example', role: 'owner' })).status === 409, 'one owner – invite as admin first');
const inv2 = await actOn('crescent', { type: 'invite', name: 'Bilal Admin', email: 'bilal@crescent.example', role: 'admin' });
ok(inv2.status === 200 && inv2.body.invite, 'admin invited');
ok((await actOn('crescent', { type: 'invite', name: 'Bilal Admin', email: 'bilal@crescent.example', role: 'admin' })).status === 409, 'not twice');
const bilal = inv2.body.tenant.admins.find((a: any) => a.email === 'bilal@crescent.example');
const re = await actOn('crescent', { type: 'resend', id: bilal.id });
ok(re.status === 200 && re.body.invite !== inv2.body.invite, 'invitation sent again');
ok((await call('GET', `/auth/invitations/${inv2.body.invite.match(/token=([A-Za-z0-9_-]+)/)[1]}`, undefined, { 'x-org': 'crescent' })).status === 404, 'the old link no longer works');
ok((await actOn('crescent', { type: 'role', id: bilal.id, role: 'owner' })).status === 409, 'only someone who accepted can become the owner');
ok((await actOn('crescent', { type: 'revoke', id: bilal.id })).body.tenant.admins.find((a: any) => a.id === bilal.id).status === 'revoked', 'access removed');
ok((await doc('admin-access')).admins.find((a: any) => a.email === 'bilal@crescent.example').status === 'suspended', 'and suspended in the organization’s own list');

/* own domain */
const baseDomain = process.env.BASE_DOMAIN ?? (await import('@/lib/platform/platform')).defaultSettings.baseDomain;   // the platform's own address (a setting)
ok((await actOn('crescent', { type: 'domain', host: `crescent.${baseDomain}` })).status === 400, 'not the platform’s own domain');
const dm = await actOn('crescent', { type: 'domain', host: 'members.crescent.example' });
ok(dm.status === 200 && dm.body.dns.some((r: any) => r.type === 'TXT'), 'own domain added with the DNS records to create', dm.body.dns);
ok((await actOn('isgh', { type: 'domain', host: 'members.crescent.example' })).status === 409, 'one organization per domain');
ok((await actOn('crescent', { type: 'verifyDomain' })).body.verified === true, 'verified');
process.env.TENANT_FROM_HOST = '1';
const { request } = await import('node:http');
const viaHost = await new Promise<{ status: number; body: any }>((res) => { const r = request(`${base}/public/events`, { headers: { host: 'members.crescent.example' } }, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => res({ status: x.statusCode ?? 0, body: JSON.parse(d) })); }); r.end(); });
process.env.TENANT_FROM_HOST = '';
ok(viaHost.status === 200 && viaHost.body.events.length === 0, 'the website answers on the own domain');

/* support sign-in, read-only, ended by staff */
const sup = await actOn('crescent', { type: 'support', reason: 'They asked for help with the join form.', mode: 'read-only' }, { 'x-staff': 'help@masajid.test' });
ok(sup.status === 200 && sup.body.token, 'support link');
const open = await call('POST', '/auth/support', { token: sup.body.token }, { 'x-org': 'crescent' });
ok(open.status === 200 && !!open.cookie && open.body.mode === 'read-only', 'support session opened');
ok((await call('POST', '/auth/support', { token: sup.body.token }, { 'x-org': 'crescent' })).status === 404, 'a support link works once');
ok((await call('POST', '/auth/support', { token: sup.body.token }, { 'x-org': 'isgh' })).status === 404, 'and only for its organization');
const sme = await call('GET', '/admin/platform/me', undefined, { 'x-org': 'crescent', cookie: open.cookie });
ok(sme.status === 200 && sme.body.you.support && sme.body.you.readOnly && sme.body.support?.mode === 'read-only', 'the organization sees the support banner', sme.body);
ok((await call('POST', '/admin/tasks', { title: 'Should not save' }, { 'x-org': 'crescent', cookie: open.cookie })).status === 403, 'read-only support cannot change anything');
const sid = (await call('GET', '/platform/state', undefined, staff)).body.support.find((x: any) => x.slug === 'crescent' && x.live).id;
ok((await actOn('crescent', { type: 'endSupport', id: sid })).status === 200, 'support ended');
ok((await call('GET', '/admin/platform/me', undefined, { 'x-org': 'crescent', cookie: open.cookie })).status === 401, 'the support session is gone');

/* readonly staff, invoices, audit */
ok((await actOn('crescent', { type: 'convert' }, { 'x-staff': 'look@masajid.test' })).status === 403, 'read-only staff change nothing');
await db.run(OWNER, [{ sql: `INSERT INTO platform.invoices (id, org_id, period, issued_on, amount_cents, status) VALUES ('in_test_1', $1::uuid, '2026-10', '2026-10-01', 4900, 'failed')`, params: [crId] }, { sql: `UPDATE platform.organizations SET status = 'past_due' WHERE id = $1::uuid`, params: [crId] }]);
const pay = await call('POST', '/platform/invoices/in_test_1', { status: 'paid' }, { 'x-staff': 'books@masajid.test' });
ok(pay.status === 200 && (await one<{ status: string }>(db, OWNER, 'SELECT status FROM platform.organizations WHERE id = $1::uuid', [crId]))!.status === 'active', 'a paid invoice brings the organization back');
ok((await call('POST', '/platform/invoices/in_test_1', { status: 'void' }, { 'x-staff': 'books@masajid.test' })).status === 409, 'a paid invoice is final');
ok(await n(`SELECT count(*)::int AS n FROM platform.audit WHERE org_id = $1::uuid`, [crId]) >= 15, 'every step in the platform audit');
let changed = false; try { await db.run(OWNER, [{ sql: `DELETE FROM platform.audit WHERE org_id = $1::uuid`, params: [crId] }]); changed = true; } catch { /* append-only */ }
ok(!changed, 'the platform audit is append-only');

server.close(); await db.close();
console.log(`platform ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
