/**
 * B1 Sign-in – one door for members and every kind of admin (web/src/lib/community/sign-in.ts: dashboardsFor).
 *   GET  /auth/methods                    which ways to sign in this organization offers (the `sign-in` document)
 *   POST /auth/code/start {address}        email or text code (6 digits, 10 minutes, 5 tries); always answers the same,
 *                                          so nobody can find out who is registered
 *   POST /auth/code/verify {address, code} → session cookie + the dashboards this person may open
 *   POST /auth/password {email, password}  optional, when the organization allows passwords
 *   POST /auth/password/set {password}     signed in: set or change one
 *   POST /auth/google {idToken}            Google sign-in (token checked with Google; tests use AUTH_GOOGLE_FAKE=1)
 *   GET  /auth/me                          who am I, which dashboard, the list to switch to, two-step state
 *   POST /auth/dashboard {index}           switch dashboard (re-checked against the current roles)
 *   POST /auth/two-step/start | verify     second step for roles with sensitive permissions (code by email or text)
 *   POST /auth/sign-out, /auth/sign-out-everywhere
 * Limits: 5 codes per address and 20 per IP per 15 minutes; 10 failed attempts per address per 15 minutes → locked.
 */
import { one, rows, type Db } from '../db/sql.js';
import { COOKIE, HttpError, PLATFORM, context, document, fromEdge, route, sessionOf, tenant, todayCT, twoStepRequired, type Ctx, type Req, type Res, type Route } from '../http/core.js';
import { codeHash, e164, hashPassword, newCode, newToken, passwordProblem, sha256hex, verifyPassword } from './crypto.js';
import { SignInSchema, dashboardsFor, mockSignIn, type Dashboard, type SignInSettings } from '@/lib/community/sign-in';
import { OrgStructureSchema, mockOrgStructure } from '@/lib/community/org-structure';
import type { AccessDoc } from '@/lib/community/access';
/** Codes per IP address in 15 minutes (a shared office or mosque Wi-Fi counts as one). Dev / test mode (AUTH_DEV_CODES=1) allows many. */
const IP_CODES = () => (process.env.AUTH_DEV_CODES === '1' ? 1000 : Number(process.env.AUTH_CODES_PER_IP ?? 20));

const DEV = () => process.env.AUTH_DEV_CODES === '1' && process.env.NODE_ENV !== 'production';
/** AUTH_DEV_NO_LIMITS=1 (development on a PC only): no 5-codes-per-15-minutes limit and no lock-out after failed tries. */
const NO_LIMITS = () => DEV() && process.env.AUTH_DEV_NO_LIMITS === '1';
/**
 * AUTH_DEV_CODES=admin-app – a shared DEV / preview server with no email provider yet: the sign-in code is shown on the
 * ADMIN sign-in page only. The request must come through our own admin app (edge key + an address that belongs to an
 * admin app). The public website, the member app and direct API callers never get a code. Never in production.
 */
async function showCodeHere(ctx: Ctx): Promise<boolean> {
  if (DEV()) return true;
  if (process.env.AUTH_DEV_CODES !== 'admin-app' || process.env.NODE_ENV === 'production') return false;
  if (!fromEdge(ctx.req)) return false;
  const host = String(ctx.req.headers['x-org-host'] ?? '').split(':')[0].toLowerCase();
  if (!host) return false;
  const r = await one<{ app: string }>(ctx.db, PLATFORM, 'SELECT app FROM platform.org_for_host($1, $2)', [host, process.env.BASE_DOMAIN ?? 'nextgrow.pro']);
  return r?.app === 'admin';
}
const SESSION_HOURS = 12;
type Who = { email: string; memberId: string | null; admin: boolean };

async function settingsOf(db: Db, orgId: string): Promise<SignInSettings> {
  const p = SignInSchema.safeParse(await document(db, orgId, 'sign-in')); return p.success ? p.data : mockSignIn;
}
const API = (orgId: string) => ({ org: orgId, role: 'app_api' as const });

/** Who an address belongs to in this organization (an admin by email, a member by email or phone). */
async function lookup(ctx: Ctx, channel: 'email' | 'sms', address: string): Promise<Who | null> {
  if (channel === 'email') {
    const admin = ctx.access.admins.some((a) => a.email.toLowerCase() === address && a.status === 'active');
    const m = await one<{ id: string }>(ctx.db, API(ctx.orgId), 'SELECT id FROM app.members WHERE lower(email) = $1 AND archived IS NULL ORDER BY approved_on NULLS LAST LIMIT 1', [address]);
    return admin || m ? { email: address, memberId: m?.id ?? null, admin } : null;
  }
  const digits = address.replace(/\D/g, '').slice(-10);
  const m = await one<{ id: string; email: string }>(ctx.db, API(ctx.orgId), `SELECT id, lower(email) AS email FROM app.members WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1 AND archived IS NULL LIMIT 1`, [digits]);
  if (!m) return null;
  return { email: m.email, memberId: m.id, admin: ctx.access.admins.some((a) => a.email.toLowerCase() === m.email && a.status === 'active') };
}

async function event(db: Db, p: { orgId: string; address: string; method: string; ok: boolean; reason?: string; userId?: string | null; ip?: string }) {
  await db.run(PLATFORM, [{ sql: 'INSERT INTO platform.sign_in_events (org_id, address, method, ok, reason, user_id, ip) VALUES ($1, $2, $3, $4::boolean, $5, NULLIF($6, \'\')::uuid, NULLIF($7, \'\')::inet)', params: [p.orgId, p.address, p.method, p.ok, p.reason ?? '', p.userId ?? '', p.ip ?? ''] }]);
}
async function locked(db: Db, address: string): Promise<boolean> {
  const r = await one<{ n: number }>(db, PLATFORM, `SELECT count(*)::int AS n FROM platform.sign_in_events WHERE address = $1 AND NOT ok AND at > now() - interval '15 minutes'`, [address]);
  return !NO_LIMITS() && (r?.n ?? 0) >= 10;   // AUTH_DEV_NO_LIMITS=1 on a PC: no lock-out
}

/** The dashboards this person may open now (membership first, then organization → zone → masjid → area). */
async function dashboards(ctx: Ctx, email: string, memberId: string | null, s: SignInSettings): Promise<Dashboard[]> {
  const mp = OrgStructureSchema.safeParse(await document(ctx.db, ctx.orgId, 'org-structure')); const map = mp.success ? mp.data : mockOrgStructure;
  return dashboardsFor(ctx.access as AccessDoc, email, !!memberId, s, todayCT(), (id) => map.zones.find((z) => z.id === id)?.name ?? id);
}
function pick(list: Dashboard[], s: SignInSettings, asked?: number): number {
  if (asked !== undefined && list.some((d) => d.index === asked)) return asked;
  if (s.chooser === 'main') { const main = list.find((d) => d.kind !== 'member'); if (main) return main.index; }
  return list[0]?.index ?? 0;
}
const actsAs = (d: Dashboard | undefined, memberId: string | null) => ({ member_id: d?.kind === 'member' ? memberId : memberId, admin_id: d && d.kind !== 'member' ? d.adminId : null });

async function startSession(ctx: Ctx, who: Who, method: string): Promise<Res> {
  const s = await settingsOf(ctx.db, ctx.orgId);
  const list = await dashboards(ctx, who.email, who.memberId, s);
  if (!list.length) throw new HttpError(403, 'This address has no membership or admin access here.');
  const user = await one<{ id: string }>(ctx.db, PLATFORM, `INSERT INTO platform.users (email, last_login_at) VALUES ($1, now())
    ON CONFLICT (email) DO UPDATE SET last_login_at = now() RETURNING id`, [who.email]);
  const index = pick(list, s); const d = list.find((x) => x.index === index);
  const token = newToken();
  const acts = actsAs(d, who.memberId);
  const admin = d?.adminId ? ctx.access.admins.find((a) => a.id === d.adminId) : undefined;
  await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.sessions (id, user_id, org_id, kind, dashboard, member_id, admin_id, method, two_step_ok, idle_minutes, expires_at, ip, user_agent)
      VALUES (decode($1, 'hex'), $2::uuid, $3::uuid, $4, $5::smallint, NULLIF($6, ''), NULLIF($7, ''), $8, false, $9::int, now() + make_interval(hours => $10::int), NULLIF($11, '')::inet, $12)`,
    params: [sha256hex(token), user!.id, ctx.orgId, d && d.kind !== 'member' ? 'admin' : 'member', index, acts.member_id ?? '', acts.admin_id ?? '', method, admin ? 30 : 120, SESSION_HOURS, ctx.req.ip ?? '', String(ctx.req.headers['user-agent'] ?? '').slice(0, 300)] }]);
  await event(ctx.db, { orgId: ctx.orgId, address: who.email, method, ok: true, userId: user!.id, ip: ctx.req.ip });
  return { status: 200, headers: { 'set-cookie': cookie(token, SESSION_HOURS * 3600) }, body: {
    signedIn: true, email: who.email, dashboards: list, current: index,
    chooseDashboard: s.chooser === 'ask' && list.length > 1,
    twoStep: admin ? { required: twoStepRequired(ctx.access, admin), ok: false } : { required: false, ok: false },
  } };
}
export const cookie = (token: string, maxAge: number) => `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;

async function sendCode(ctx: Ctx, channel: 'email' | 'sms', to: string, purpose: string): Promise<string> {
  // development only: AUTH_DEV_FIXED_CODE=123456 in BE/.env → every code is that number (never in production)
  const fixed = process.env.AUTH_DEV_FIXED_CODE ?? '';
  const code = DEV() && /^\d{6}$/.test(fixed) ? fixed : newCode();
  const org = await one<{ name: string }>(ctx.db, PLATFORM, 'SELECT name FROM platform.organizations WHERE id = $1', [ctx.orgId]);
  await ctx.db.run(PLATFORM, [
    { sql: `INSERT INTO platform.login_codes (org_id, channel, address, purpose, code_hash, ip) VALUES ($1, $2, $3, $4, decode($5, 'hex'), NULLIF($6, '')::inet)`, params: [ctx.orgId, channel, to, purpose, codeHash(to, code), ctx.req.ip ?? ''] },
    { sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, $2, $3, $4, $5, 'sign-in-code')`, params: [ctx.orgId, channel, to,
      channel === 'email' ? `${code} is your ${org?.name ?? ''} sign-in code` : '',
      channel === 'email' ? `Assalamu alaikum,\n\nYour sign-in code is ${code}. It works for 10 minutes. If you did not ask for it, you can ignore this email.\n\n${org?.name ?? ''}` : `${code} is your ${org?.name ?? ''} sign-in code. It works for 10 minutes.`] },
  ]);
  if (DEV()) console.log(`[sign-in code] ${to} → ${code}  (development: AUTH_DEV_CODES=1)`);
  return code;
}
async function checkCode(ctx: Ctx, address: string, code: string, purpose: string): Promise<void> {
  const c = await one<{ id: string; attempts: number; ok: boolean }>(ctx.db, PLATFORM, `SELECT id, attempts, (code_hash = decode($3, 'hex')) AS ok FROM platform.login_codes
    WHERE address = $1 AND purpose = $2 AND org_id = $4 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [address, purpose, codeHash(address, code), ctx.orgId]);
  if (!c) { await event(ctx.db, { orgId: ctx.orgId, address, method: purpose === 'two-step' ? 'two-step' : address.includes('@') ? 'email-code' : 'sms-code', ok: false, reason: 'no live code', ip: ctx.req.ip }); throw new HttpError(400, 'That code has expired. Ask for a new one.', undefined, 'expired'); }
  if (c.attempts >= 5) throw new HttpError(429, 'Too many tries. Ask for a new code.', undefined, 'too-many');
  if (!c.ok || !/^\d{6}$/.test(code)) {
    await ctx.db.run(PLATFORM, [{ sql: 'UPDATE platform.login_codes SET attempts = attempts + 1 WHERE id = $1::uuid', params: [c.id] }]);
    await event(ctx.db, { orgId: ctx.orgId, address, method: purpose === 'two-step' ? 'two-step' : address.includes('@') ? 'email-code' : 'sms-code', ok: false, reason: 'wrong code', ip: ctx.req.ip });
    throw new HttpError(400, `That code is not right. ${Math.max(0, 4 - c.attempts)} tries left.`, { left: Math.max(0, 4 - c.attempts) }, 'wrong-code');
  }
  await ctx.db.run(PLATFORM, [{ sql: 'UPDATE platform.login_codes SET used_at = now() WHERE id = $1::uuid', params: [c.id] }]);
}
function normalize(raw: unknown): { channel: 'email' | 'sms'; address: string } {
  const a = String(raw ?? '').trim().toLowerCase();
  if (a.includes('@')) { if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a) || a.length > 254) throw new HttpError(400, 'Enter a valid email address.'); return { channel: 'email', address: a }; }
  const p = e164(a); if (!p) throw new HttpError(400, 'Enter a valid email or a 10-digit US mobile number.');
  return { channel: 'sms', address: p };
}

/* ---------------- Google ---------------- */
async function googleEmail(idToken: string): Promise<string> {
  if (process.env.AUTH_GOOGLE_FAKE === '1' && idToken.startsWith('fake:')) return idToken.slice(5).toLowerCase();
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`).catch(() => null);
  if (!r || !r.ok) throw new HttpError(401, 'Google could not confirm this sign-in.');
  const j = await r.json() as { aud?: string; email?: string; email_verified?: string | boolean; exp?: string };
  if (!process.env.GOOGLE_CLIENT_ID || j.aud !== process.env.GOOGLE_CLIENT_ID) throw new HttpError(401, 'This Google sign-in was not made for this site.');
  if (!(j.email_verified === true || j.email_verified === 'true') || !j.email) throw new HttpError(401, 'Google has not verified this email.');
  return j.email.toLowerCase();
}

/* ---------------- routes ---------------- */
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
async function signedIn(ctx: Ctx) {
  const s = ctx.session; if (!s || s.org_id !== ctx.orgId) throw new HttpError(401, 'Sign in first.', undefined, 'sign-in');
  return s;
}

export const AUTH_ROUTES: Route[] = [
  route('GET', /^\/auth\/methods$/, async (ctx) => {
    const s = await settingsOf(ctx.db, ctx.orgId);
    return { status: 200, body: { methods: s.methods, findMasjid: s.findMasjid, staffNote: s.staffNote, google: s.methods.google ? { clientId: process.env.GOOGLE_CLIENT_ID ?? '' } : null } };
  }),
  route('POST', /^\/auth\/code\/start$/, async (ctx) => {
    const { channel, address } = normalize(body(ctx).address);
    const s = await settingsOf(ctx.db, ctx.orgId);
    if (channel === 'email' && !s.methods.emailCode) throw new HttpError(400, 'Email codes are switched off here.');
    if (channel === 'sms' && !s.methods.phoneCode) throw new HttpError(400, 'Text-message codes are switched off here.');
    if (await locked(ctx.db, address)) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.', undefined, 'locked');
    const recent = await one<{ a: number; ip: number }>(ctx.db, PLATFORM, `SELECT count(*) FILTER (WHERE address = $1)::int AS a, count(*) FILTER (WHERE ip = NULLIF($2, '')::inet)::int AS ip FROM platform.login_codes WHERE created_at > now() - interval '15 minutes'`, [address, ctx.req.ip ?? '']);
    if ((recent?.a ?? 0) >= (NO_LIMITS() ? 1000 : 5) || (recent?.ip ?? 0) >= IP_CODES()) throw new HttpError(429, 'Too many codes asked for. Wait 15 minutes and try again.', undefined, 'rate');
    const who = await lookup(ctx, channel, address);
    let devCode: string | undefined;
    if (who) devCode = await sendCode(ctx, channel, address, 'sign-in');
    else await event(ctx.db, { orgId: ctx.orgId, address, method: channel === 'email' ? 'email-code' : 'sms-code', ok: false, reason: 'unknown address', ip: ctx.req.ip });
    return { status: 202, body: { sent: true, channel, expiresInMinutes: 10, message: `If ${channel === 'email' ? 'this email' : 'this number'} belongs to a member or admin here, a 6-digit code is on its way.`, ...(devCode && await showCodeHere(ctx) ? { devCode } : {}) } };
  }),
  route('POST', /^\/auth\/code\/verify$/, async (ctx) => {
    const { channel, address } = normalize(body(ctx).address);
    if (await locked(ctx.db, address)) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.', undefined, 'locked');
    await checkCode(ctx, address, String(body(ctx).code ?? '').trim(), 'sign-in');
    const who = await lookup(ctx, channel, address);
    if (!who) throw new HttpError(403, 'This address has no membership or admin access here.');
    return startSession(ctx, who, channel === 'email' ? 'email-code' : 'sms-code');
  }),
  route('POST', /^\/auth\/password$/, async (ctx) => {
    // AUTH_PASSWORDS=on: passwords allowed even while the organization's sign-in settings have them off (a server with no email yet)
    const s = await settingsOf(ctx.db, ctx.orgId); if (!s.methods.password && process.env.AUTH_PASSWORDS !== 'on') throw new HttpError(400, 'Passwords are switched off here – use a code.');
    const { address } = normalize(body(ctx).email); const pw = String(body(ctx).password ?? '');
    if (await locked(ctx.db, address)) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.', undefined, 'locked');
    const row = await one<{ hash: string }>(ctx.db, PLATFORM, 'SELECT p.hash FROM platform.passwords p JOIN platform.users u ON u.id = p.user_id WHERE u.email = $1', [address]);
    const who = row && verifyPassword(pw, row.hash) ? await lookup(ctx, 'email', address) : null;
    if (!who) { await event(ctx.db, { orgId: ctx.orgId, address, method: 'password', ok: false, reason: 'wrong password', ip: ctx.req.ip }); throw new HttpError(401, 'That email and password do not match.'); }
    return startSession(ctx, who, 'password');
  }),
  route('POST', /^\/auth\/password\/set$/, async (ctx) => {
    const s = await signedIn(ctx); const pw = String(body(ctx).password ?? '');
    const problem = passwordProblem(pw, s.email); if (problem) throw new HttpError(400, problem);
    await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.passwords (user_id, hash) VALUES ($1::uuid, $2) ON CONFLICT (user_id) DO UPDATE SET hash = EXCLUDED.hash, changed_at = now()`, params: [s.user_id, hashPassword(pw)] }]);
    return { status: 200, body: { ok: true } };
  }),
  route('POST', /^\/auth\/google$/, async (ctx) => {
    const s = await settingsOf(ctx.db, ctx.orgId); if (!s.methods.google) throw new HttpError(400, 'Google sign-in is switched off here.');
    const email = await googleEmail(String(body(ctx).idToken ?? ''));
    const who = await lookup(ctx, 'email', email);
    if (!who) { await event(ctx.db, { orgId: ctx.orgId, address: email, method: 'google', ok: false, reason: 'unknown address', ip: ctx.req.ip }); throw new HttpError(403, 'This Google account has no membership or admin access here.'); }
    const r = await startSession(ctx, who, 'google');
    await ctx.db.run(PLATFORM, [{ sql: 'UPDATE platform.users SET name = coalesce(nullif(name, \'\'), $2) WHERE email = $1', params: [email, String(body(ctx).name ?? '').slice(0, 80)] }]);
    return r;
  }),
  route('GET', /^\/auth\/me$/, async (ctx) => {
    const s = await signedIn(ctx);
    const st = await settingsOf(ctx.db, ctx.orgId);
    const list = await dashboards(ctx, s.email, s.member_id, st);
    const admin = s.admin_id ? ctx.access.admins.find((a) => a.id === s.admin_id) : undefined;
    return { status: 200, body: { email: s.email, dashboards: list, current: s.dashboard, actingAs: s.admin_id ? { admin: s.admin_id, name: admin?.name ?? '' } : { member: s.member_id }, twoStep: { required: !!admin && twoStepRequired(ctx.access, admin), ok: s.two_step_ok } } };
  }),
  route('POST', /^\/auth\/dashboard$/, async (ctx) => {
    const s = await signedIn(ctx);
    const st = await settingsOf(ctx.db, ctx.orgId);
    const list = await dashboards(ctx, s.email, s.member_id, st);
    const index = Number(body(ctx).index); const d = list.find((x) => x.index === index);
    if (!d) throw new HttpError(403, 'That dashboard is not yours (any more).');
    const acts = actsAs(d, s.member_id);
    await ctx.db.run(PLATFORM, [{ sql: `UPDATE platform.sessions SET dashboard = $2::smallint, kind = $3, admin_id = NULLIF($4, ''), idle_minutes = $5::int WHERE id = decode($1, 'hex')`, params: [s.id, index, d.kind === 'member' ? 'member' : 'admin', acts.admin_id ?? '', d.kind === 'member' ? 120 : 30] }]);
    return { status: 200, body: { current: index, dashboard: d } };
  }),
  route('POST', /^\/auth\/two-step\/start$/, async (ctx) => {
    const s = await signedIn(ctx);
    const devCode = await sendCode(ctx, 'email', s.email, 'two-step');
    return { status: 202, body: { sent: true, channel: 'email', ...(await showCodeHere(ctx) ? { devCode } : {}) } };
  }),
  route('POST', /^\/auth\/two-step\/verify$/, async (ctx) => {
    const s = await signedIn(ctx);
    await checkCode(ctx, s.email, String(body(ctx).code ?? '').trim(), 'two-step');
    await ctx.db.run(PLATFORM, [{ sql: `UPDATE platform.sessions SET two_step_ok = true WHERE id = decode($1, 'hex')`, params: [s.id] }]);
    await event(ctx.db, { orgId: ctx.orgId, address: s.email, method: 'two-step', ok: true, userId: s.user_id, ip: ctx.req.ip });
    return { status: 200, body: { ok: true } };
  }),
  route('POST', /^\/auth\/sign-out$/, async (ctx) => {
    if (ctx.session) await ctx.db.run(PLATFORM, [{ sql: `UPDATE platform.sessions SET revoked_at = now() WHERE id = decode($1, 'hex')`, params: [ctx.session.id] }]);
    return { status: 200, headers: { 'set-cookie': cookie('', 0) }, body: { signedOut: true } };
  }),
  route('POST', /^\/auth\/sign-out-everywhere$/, async (ctx) => {
    const s = await signedIn(ctx);
    const r = await rows(ctx.db, PLATFORM, `UPDATE platform.sessions SET revoked_at = now() WHERE user_id = $1::uuid AND revoked_at IS NULL RETURNING 1`, [s.user_id]);
    return { status: 200, headers: { 'set-cookie': cookie('', 0) }, body: { signedOut: r.length } };
  }),
];
export { sessionOf, tenant, context };
/** For the member app's sign-in (src/modules/app.ts): the same codes, limits, look-up and sign-in history. */
export { sendCode, checkCode, lookup, normalize, event, locked, settingsOf as signInSettings, IP_CODES, DEV as devCodes };
export type { Req };
