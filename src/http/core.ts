import { AsyncLocalStorage } from 'node:async_hooks';
/**
 * Shared by every route module: errors, the request shape, the tenant (organization) of a request, the actor (who is
 * signed in and as which dashboard), permission checks and the audit log.
 *
 * Tenant: the Host header through platform.org_for_host() (live), or `x-org` (slug) behind the edge / in tests.
 * Actor:  the session cookie (B1). The old `x-admin` header is accepted ONLY when AUTH_DEV_HEADER=1 (tests, local).
 */
import type { IncomingMessage } from 'node:http';
import { one, type Db } from '../db/sql.js';
import { REGISTRY, isDocKey } from '../registry.js';
import { AccessSchema, can, roleOf, type AccessDoc, type AdminUser, type Permission } from '@/lib/community/access';
import { sha256hex } from '../auth/crypto.js';
import { timingSafeEqual } from 'node:crypto';

export type Req = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: unknown; ip?: string; raw?: string };   // raw: the body as sent (webhook signatures)
export type Res = { status: number; body: unknown; headers?: Record<string, string | string[]> };
export class HttpError extends Error { constructor(public status: number, message: string, public detail?: unknown, public code?: string) { super(message); } }
/** The organization's own clock for this request (or job): set once the tenant is known; ISGH's is the default. */
export const tzStore = new AsyncLocalStorage<{ tz: string }>();
export const orgTz = () => tzStore.getStore()?.tz ?? 'America/Chicago';
/** Today in the organization's time zone (the name stays from when every organization was in Houston). */
export const todayCT = () => new Date().toLocaleDateString('en-CA', { timeZone: orgTz() });
export const PLATFORM = { org: null, role: 'app_platform' as const };

/* ---------------- tenant ---------------- */
/**
 * Who may name the organization in a header. Our own apps (website, admin, mobile edge) call the API server-side and
 * send `x-edge-key` = EDGE_KEY with `x-org-host` (the address the visitor used) or `x-org` (a slug), plus
 * `x-client-ip`. In production (TENANT_FROM_HOST=1) those headers count only with the right key – anyone else is
 * placed by the Host header and their own address. In development (no TENANT_FROM_HOST) `x-org` works as before.
 */
export function fromEdge(req: Pick<Req, 'headers'>): boolean {
  const want = process.env.EDGE_KEY; const got = req.headers['x-edge-key'];
  if (!want || typeof got !== 'string' || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
const headersTrusted = (req: Req) => fromEdge(req) || process.env.TENANT_FROM_HOST !== '1';
/** The member app has no address of its own: it names its organization (`x-org`). Its tokens belong to that organization. */
const appNamesOrg = (req: Req) => typeof req.path === 'string' && req.path.startsWith('/app/');
const one1 = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
export async function tenant(db: Db, req: Req): Promise<{ orgId: string; slug: string; status: string; timezone: string }> {
  const trusted = headersTrusted(req);
  const viaHeader = trusted || appNamesOrg(req) ? one1(req.headers['x-org']) : '';
  const viaHost = trusted ? one1(req.headers['x-org-host']) : '';
  const host = (viaHost || (process.env.TENANT_FROM_HOST === '1' ? one1(req.headers.host) : '')).split(':')[0].toLowerCase();
  const BY_HOST = 'SELECT o.id, o.slug, o.status, o.timezone FROM platform.org_for_host($1, $2) h JOIN platform.organizations o ON o.id = h.org_id';
  let org: { id: string; slug: string; status: string; timezone: string } | null = null;
  if (viaHeader) org = await one(db, PLATFORM, 'SELECT id, slug, status, timezone FROM platform.organizations WHERE slug = $1', [viaHeader.toLowerCase()]);
  else if (host) org = await one(db, PLATFORM, BY_HOST, [host, process.env.BASE_DOMAIN ?? 'nextgrow.pro']);
  else org = await one(db, PLATFORM, 'SELECT id, slug, status, timezone FROM platform.organizations WHERE slug = $1', [process.env.DEFAULT_ORG ?? 'isgh']);
  // on a PC (LOCALHOST_ORG in BE/.env), plain http://localhost:3000 / :3001 opens that organization – never in production
  if (!org && !viaHeader && process.env.LOCALHOST_ORG && /^(localhost|127\.0\.0\.1)$/.test(host) && process.env.NODE_ENV !== 'production')
    org = await one(db, PLATFORM, 'SELECT id, slug, status, timezone FROM platform.organizations WHERE slug = $1', [process.env.LOCALHOST_ORG]);
  if (!org) throw new HttpError(404, `No organization “${viaHeader || host}”.`);
  if (org.status === 'suspended' || org.status === 'cancelled') throw new HttpError(423, 'This organization is paused.');
  return { orgId: org.id, slug: org.slug, status: org.status, timezone: org.timezone };
}
/** The visitor's address: from our own apps (x-client-ip with the edge key), else the last hop our proxy added
 *  (TRUST_PROXY=1, nginx in front), else the socket. Spoofed x-forwarded-for entries on the left are ignored. */
export function clientIp(headers: Req['headers'], socketIp: string): string {
  if (fromEdge({ headers }) && typeof headers['x-client-ip'] === 'string') return headers['x-client-ip'].trim().slice(0, 45);
  if (process.env.TRUST_PROXY === '1') { const hops = one1(headers['x-forwarded-for']).split(',').map((x) => x.trim()).filter(Boolean); if (hops.length) return hops[hops.length - 1]; }
  if (process.env.TENANT_FROM_HOST !== '1') { const first = one1(headers['x-forwarded-for']).split(',')[0].trim(); if (first) return first; }   // development and tests
  return socketIp.replace(/^::ffff:/, '');
}
export async function document<T>(db: Db, orgId: string, key: string): Promise<T> {
  const r = await one<{ data: T }>(db, { org: orgId, role: 'app_api' }, 'SELECT data FROM app.documents WHERE key = $1', [key]);
  if (r) return r.data;
  if (!isDocKey(key)) return null as T;
  // not published yet: ISGH (client #1) sees the built-in document; every other organization its own starter (B6b)
  const { starterFor } = await import('../platform/starter.js');
  return (await starterFor(db, orgId, key)) as T;
}

/* ---------------- session ---------------- */
export const COOKIE = process.env.SESSION_COOKIE ?? 'ms_sid';
export function cookieOf(req: Req, name = COOKIE): string {
  const raw = String(req.headers.cookie ?? '');
  for (const part of raw.split(/;\s*/)) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1)); }
  return '';
}
export type Session = { id: string; user_id: string; email: string; org_id: string | null; kind: string; dashboard: number; member_id: string | null; admin_id: string | null; two_step_ok: boolean; idle_minutes: number; support_session_id: string | null; read_only: boolean; app_family?: string | null };
/** The member app's access token (`Authorization: Bearer …`) – only for app sessions, never a browser cookie's. */
export function bearerOf(req: Pick<Req, 'headers'>): string {
  return /^Bearer ([A-Za-z0-9_-]{32,100})$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
}
export async function sessionOf(db: Db, req: Req): Promise<Session | null> {
  const cookieToken = cookieOf(req); const bearer = cookieToken ? '' : bearerOf(req);
  const token = cookieToken || bearer; if (!token || token.length < 32) return null;
  const s = await one<Session & { idle: boolean }>(db, PLATFORM, `SELECT encode(s.id, 'hex') AS id, s.user_id, u.email, s.org_id, s.kind, s.dashboard, s.member_id, s.admin_id, s.two_step_ok, s.idle_minutes, s.support_session_id::text AS support_session_id, s.read_only, s.app_family::text AS app_family,
      (s.last_seen_at < now() - make_interval(mins => s.idle_minutes)) AS idle
    FROM platform.sessions s JOIN platform.users u ON u.id = s.user_id
    WHERE s.id = decode($1, 'hex') AND s.revoked_at IS NULL AND s.expires_at > now() AND ((s.method = 'app') = $2::boolean)`, [sha256hex(token), !!bearer]);
  if (!s) return null;
  if (s.idle) { await db.run(PLATFORM, [{ sql: 'UPDATE platform.sessions SET revoked_at = now() WHERE id = decode($1, \'hex\')', params: [s.id] }]); return null; }
  await db.run(PLATFORM, [{ sql: 'UPDATE platform.sessions SET last_seen_at = now() WHERE id = decode($1, \'hex\') AND last_seen_at < now() - interval \'1 minute\'', params: [s.id] }]);
  return s;
}

/* ---------------- actor ---------------- */
export type Ctx = { db: Db; req: Req; orgId: string; slug: string; access: AccessDoc; me: AdminUser | null; session: Session | null; memberId: string | null; needsTwoStep: boolean; readOnly?: boolean; tz?: string };
export async function context(db: Db, req: Req): Promise<Ctx> {
  const { orgId, slug, timezone } = await tenant(db, req);
  const access = AccessSchema.parse(await document(db, orgId, 'admin-access')) as AccessDoc;
  let me: AdminUser | null = null; let memberId: string | null = null; let needsTwoStep = false;
  const session = await sessionOf(db, req);
  let readOnly = false;
  if (session && session.org_id === orgId && session.support_session_id) {
    // platform support signed in with the organization's knowledge (B6): an owner-level admin, read-only unless "full"
    const sup = await one<{ name: string; mode: string }>(db, PLATFORM, `SELECT coalesce(NULLIF(u.name, ''), u.email) AS name, s.mode FROM platform.support_sessions s JOIN platform.staff st ON st.id = s.staff_id JOIN platform.users u ON u.id = st.user_id
      WHERE s.id = $1::uuid AND s.org_id = $2::uuid AND s.ended_at IS NULL AND s.ends_at > now()`, [session.support_session_id, orgId]);
    if (sup) { me = { id: 'platform-support', name: `${sup.name} (platform support)`, email: session.email, roleId: 'owner', zones: [], centers: [], zips: [], more: [], memberId: '', homeZip: '', givenBy: '', holderId: '', reviewedOn: '', status: 'active', twoStep: true } as unknown as AdminUser; readOnly = sup.mode !== 'full'; }
  } else if (session && session.org_id === orgId) {
    if (session.admin_id) {
      const a = access.admins.find((x) => x.id === session.admin_id && x.status === 'active' && x.email.toLowerCase() === session.email.toLowerCase()) ?? null;
      if (a) { if (twoStepRequired(access, a) && !session.two_step_ok) needsTwoStep = true; else me = a; }
    }
    memberId = session.member_id;
  } else if (process.env.AUTH_DEV_HEADER === '1' && req.headers['x-admin']) {
    const id = String(req.headers['x-admin']);
    me = access.admins.find((a) => a.id === id && a.status === 'active') ?? null;
  }
  return { db, req, orgId, slug, access, me, session, memberId, needsTwoStep, readOnly, tz: timezone || 'America/Chicago' };
}
/** Two-step is required for this admin by the organization's rule (sensitive permissions, everyone, or nobody). */
export function twoStepRequired(access: AccessDoc, a: AdminUser): boolean {
  if (access.requireTwoStepFor === 'none') return false;
  if (access.requireTwoStepFor === 'everyone') return true;
  const r = roleOf(access, a);
  const SENSITIVE = ['members.contact', 'members.archive', 'zakat.override', 'zakat.disburse', 'zakat.settings', 'payments.refund', 'finance.manage', 'voters.freeze', 'integrations.manage', 'admins.manage', 'billing'];
  return !!r?.permissions.some((p) => SENSITIVE.includes(p));
}
export function need(ctx: Ctx, p: Permission) {
  if (ctx.needsTwoStep) throw new HttpError(401, 'Finish the second sign-in step first.', undefined, 'two-step');
  if (!ctx.me) throw new HttpError(401, 'Sign in first.', undefined, 'sign-in');
  if (!can(ctx.access, ctx.me, p, todayCT())) throw new HttpError(403, `Your role (${roleOf(ctx.access, ctx.me)?.name ?? ctx.me.roleId}) does not include “${p}”.`);
}
export function needMember(ctx: Ctx): string {
  if (!ctx.memberId) throw new HttpError(401, 'Sign in to your membership first.', undefined, 'sign-in');
  return ctx.memberId;
}
export async function audit(ctx: Ctx, area: string, action: string, detail = '', target = '') {
  await ctx.db.run({ org: ctx.orgId, role: 'app_api' }, [{ sql: 'INSERT INTO app.audit_log (org_id, actor, area, action, detail, target) VALUES ($1, $2, $3, $4, $5, $6)', params: [ctx.orgId, ctx.me?.name ?? (ctx.memberId ? `Member ${ctx.memberId}` : 'system'), area, action, detail, target] }]);
}

/* ---------------- tiny router for route modules ---------------- */
export type Handler = (ctx: Ctx, m: RegExpMatchArray) => Promise<Res>;
export type Route = { method: string; re: RegExp; handler: Handler };
export const route = (method: string, re: RegExp, handler: Handler): Route => ({ method, re, handler });

/* ---------------- one route calling another (the app's routes reuse the website's) ---------------- */
let TABLE: Route[] = [];
export const setRoutes = (list: Route[]) => { TABLE = list; };
/** Runs another route with the same organization and person; its errors come through as they are. */
export async function inner<T = any>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const [p, qs] = path.split('?');
  const req: Req = { ...ctx.req, method, path: p, query: new URLSearchParams(qs ?? ''), body };
  for (const r of TABLE) { if (r.method !== method) continue; const mm = p.match(r.re); if (mm) return (await r.handler({ ...ctx, req }, mm)).body as T; }
  throw new HttpError(404, `No route ${method} ${p}.`);
}
