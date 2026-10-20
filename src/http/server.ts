/** Routes in src/auth/routes.ts (B1) and later modules are tried first; see ROUTES. */
/**
 * The API (B0): plain Node http, no framework – one organization per request, one transaction per database call,
 * Row Level Security underneath. Routes:
 *   GET  /health
 *   GET  /public/documents/:key               public projection of a published document (website)
 *   GET  /admin/documents/:key                the published document (admin), + ?versions=1 for the history
 *   PUT  /admin/documents/:key                publish: validated with the shared zod schema; needs the document's permission
 *   GET  /admin/members?q=&view=&zone=&masjid= list in the actor's scope (masjid/zone roles never see outside it)
 *   GET  /admin/members/:id                   one record (in scope)
 *   POST /admin/members/:id/approve           Board approval; refused (409) by the approval rule when dues or ID are missing
 *   /admin/tickets*                           410 Gone – the help desk (/admin/helpdesk/tickets) and team tasks (/admin/tasks)
 *   GET  /admin/audit                         the audit log (admins.manage)
 * Tenant: header `x-org` (slug) – live: the host name. Actor: header `x-admin` (admin id from the admin-access
 * document) – B1 replaces this with the session cookie; until then the server only runs behind the preview password.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { openDb, one, rows, type Db } from '../db/sql.js';
import { DOC_KEYS, PUBLIC, REGISTRY, isDocKey, permissionToPublish } from '../registry.js';
import { inScope, roleOf } from '@/lib/community/access';
import { OrgStructureSchema, mockOrgStructure } from '@/lib/community/org-structure';
import { MembershipSettingsSchema, mockMembershipSettings } from '@/lib/content/membership';
import { approvalBlockers, eligibility, statusOf, YEAR, type Member } from '@/lib/members/members';

import { HttpError, audit, clientIp, context, document, need, setRoutes, todayCT, tzStore, type Ctx, type Req, type Res, type Route } from './core.js';
import { AUTH_ROUTES } from '../auth/routes.js';
import { project } from '../modules/projections.js';
import { MEMBER_SQL, toMember, type MemberRow } from '../modules/member-shape.js';
import { MEMBER_ROUTES } from '../modules/members.js';
import { WEBSITE_ROUTES } from '../modules/website.js';
import { JOIN_DRAFT_ROUTES } from '../modules/join-drafts.js';
import { HELPDESK_ROUTES, TASK_ROUTES } from '../modules/helpdesk.js';
import { EVENT_ROUTES } from '../modules/events.js';
import { GIVING_ROUTES } from '../modules/giving.js';
import { FINANCE_ROUTES } from '../modules/finance.js';
import { ZAKAT_ROUTES } from '../modules/zakat.js';
import { GOVERNANCE_ROUTES } from '../modules/governance.js';
import { COMMS_ROUTES } from '../modules/comms.js';
import { handleWebhook } from '../jobs/webhooks.js';
import { CHECKOUT_ROUTES, handlePayWebhook } from '../modules/checkout.js';
import { ORG_PLATFORM_ROUTES, handlePlatform } from '../platform/routes.js';
import { FILE_ROUTES, handleRaw } from '../files/routes.js';
import { SITE_ROUTES } from '../modules/site.js';
import { DOCUMENT_ROUTES } from '../modules/documents.js';
import { RECORD_ROUTES } from '../modules/records-admin.js';
import { MEMBER_EXTRA_ROUTES } from '../modules/member-extras.js';
import { APP_ROUTES } from '../modules/app.js';
import { CONTACT_ROUTES } from '../modules/contacts.js';
/** Route modules (B1 onward). The legacy routes below stay until each moves into its module. */
export const ROUTES: Route[] = [...AUTH_ROUTES, ...DOCUMENT_ROUTES, ...JOIN_DRAFT_ROUTES, ...MEMBER_ROUTES, ...WEBSITE_ROUTES, ...HELPDESK_ROUTES, ...TASK_ROUTES, ...EVENT_ROUTES, ...GIVING_ROUTES, ...FINANCE_ROUTES, ...ZAKAT_ROUTES, ...GOVERNANCE_ROUTES, ...COMMS_ROUTES, ...CHECKOUT_ROUTES, ...ORG_PLATFORM_ROUTES, ...FILE_ROUTES, ...SITE_ROUTES, ...RECORD_ROUTES, ...MEMBER_EXTRA_ROUTES, ...APP_ROUTES, ...CONTACT_ROUTES];
setRoutes(ROUTES);

/* ---------------- members ---------------- */
/** MEMBERS_CACHE_SECONDS (development against a far-away database): the member list is kept in memory for that long and
 *  dropped on any change (any POST / PUT / PATCH / DELETE). Off (0) unless set. */
const MEMBER_CACHE = new Map<string, { rows: unknown[]; until: number }>();
const CACHE_MS = () => Number(process.env.MEMBERS_CACHE_SECONDS ?? 60) * 1000;   // the rows of a large organization take seconds to build; every write through the API drops the cache
export const dropMemberCache = () => MEMBER_CACHE.clear();
/** The list leaves out what no list screen shows – the raw import record (wildapricot) is a third of every row; GET /admin/members/:id still has it. */
const lean = (m: Member): Member => { const { wildapricot: _w, ...rest } = m as Member & { wildapricot?: unknown }; void _w; return rest as Member; };
async function listMembers(ctx: Ctx, q: URLSearchParams): Promise<Member[]> {
  need(ctx, 'members.view');
  const search = (q.get('q') ?? '').trim().toLowerCase();
  const key = `${ctx.orgId}|${search}`; const hit = MEMBER_CACHE.get(key);
  const raw = hit && hit.until > Date.now() ? hit.rows : await rows(ctx.db, { org: ctx.orgId, role: 'app_api' }, `${MEMBER_SQL} WHERE ($1 = '' OR lower(m.first_name || ' ' || m.last_name || ' ' || m.email || ' ' || m.id || ' ' || m.zip) LIKE '%' || $1 || '%')
    ORDER BY (SELECT c.sort FROM app.centers c WHERE c.org_id = m.org_id AND c.id = m.center_id) NULLS LAST, m.center, (SELECT z.sort FROM app.zones z WHERE z.org_id = m.org_id AND z.id = m.zone_id) NULLS LAST,
      CASE m.status WHEN 'active' THEN 1 WHEN 'life' THEN 2 WHEN 'pending' THEN 3 WHEN 'expired' THEN 4 ELSE 5 END, m.sort_name, m.member_no` /* the primary sort */, [search]);
  if (CACHE_MS() > 0 && !(hit && hit.until > Date.now())) MEMBER_CACHE.set(key, { rows: raw, until: Date.now() + CACHE_MS() });
  const all = (raw as MemberRow[]).map(toMember).filter((m) => inScope(ctx.access, ctx.me, m.zone, m.center, m.zip));
  const zone = q.get('zone') ?? ''; const masjid = q.get('masjid') ?? ''; const view = q.get('view') ?? 'all';
  return all.filter((m) => (!zone || m.zone === zone) && (!masjid || m.center === masjid) && (view === 'any' || (view === 'archived' ? !!m.archived : !m.archived && (view === 'all' || (view === 'pending' ? statusOf(m) === 'pending' : view === 'voters' ? eligibility(m).eligible : view === 'expired' ? statusOf(m) === 'expired' : true)))));   // any = archived too (the admin's own views)
}
async function getMember(ctx: Ctx, id: string): Promise<Member> {
  need(ctx, 'members.view');
  const r = await one<MemberRow>(ctx.db, { org: ctx.orgId, role: 'app_api' }, `${MEMBER_SQL} WHERE m.id = $1`, [id.toUpperCase()]);
  if (!r) throw new HttpError(404, `No member ${id}.`);
  const m = toMember(r);
  if (!inScope(ctx.access, ctx.me, m.zone, m.center, m.zip)) throw new HttpError(403, 'Not in your zones.');
  return m;
}

/* ---------------- routes ---------------- */
async function route(db: Db, req: Req): Promise<Res> {
  const { method, path } = req;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') dropMemberCache();
  if (method === 'GET' && path === '/health') {
    // the database too: 503 when it cannot be reached (load balancers and the container health check see it)
    const { dbStatus } = await import('../db/check.js'); const st = await dbStatus(db, Number(process.env.DB_HEALTH_TIMEOUT_MS) || 10_000);   // a far-away database (PC → server) needs more than 3 s for the first encrypted connection
    const detail = process.env.NODE_ENV === 'production' ? {} : st.connected ? { database: st.database, server: st.server, migrations: st.migrations, organizations: st.organizations, members: st.members } : { problem: st.problem, fix: st.fix };
    return { status: st.connected ? 200 : 503, body: { ok: st.connected, at: new Date().toISOString(), db: { connected: st.connected, ms: st.ms, ...detail } } };
  }
  if (path.startsWith('/files/raw/')) return handleRaw(db, req);   // local storage's signed upload / download
  if (path.startsWith('/webhooks/pay/')) return handlePayWebhook(db, req);
  if (path.startsWith('/webhooks/')) return handleWebhook(db, req);   // providers: no organization in the address
  if (path.startsWith('/platform/')) return handlePlatform(db, req);   // the SaaS panel: platform staff, no organization
  const ctx = await context(db, req);
  tzStore.enterWith({ tz: ctx.tz ?? 'America/Chicago' });   // every date and time in this request is the organization's
  if (ctx.readOnly && method !== 'GET' && !path.startsWith('/auth/sign-out')) throw new HttpError(403, 'Read-only support sign-in – nothing can be changed.');
  for (const r of ROUTES) { const mm = r.method === method ? path.match(r.re) : null; if (mm) return r.handler(ctx, mm); }
  const today = todayCT();
  let m: RegExpMatchArray | null;

  // public documents
  if ((m = path.match(/^\/public\/documents\/([a-z0-9-]+)$/)) && method === 'GET') {
    const key = m[1]; if (!isDocKey(key) || !PUBLIC[key]) throw new HttpError(404, 'Not a public document.');
    const map = OrgStructureSchema.safeParse(await document(db, ctx.orgId, 'org-structure')); const mapDoc = map.success ? map.data : mockOrgStructure;
    const out = PUBLIC[key]!(await document(db, ctx.orgId, key), { today, zoneName: (id) => mapDoc.zones.find((z) => z.id === id)?.name ?? id });
    if (out === null) throw new HttpError(404, 'Not published.');
    return { status: 200, body: { key, data: out } };
  }
  // members
  if (path === '/admin/members' && method === 'GET') { const list = (await listMembers(ctx, req.query)).map(lean); return { status: 200, body: { count: list.length, members: req.query.get('limit') === 'all' ? list : list.slice(0, Math.min(20_000, Number(req.query.get('limit') ?? 200) || 200)) } }; }   // ?limit=all: the admin's whole scope (its screens filter in the browser)
  if ((m = path.match(/^\/admin\/members\/([A-Za-z0-9-]+)$/)) && method === 'GET') { const mem = await getMember(ctx, m[1]); const sp = MembershipSettingsSchema.safeParse(await document(db, ctx.orgId, 'membership-settings')); const ms = sp.success ? sp.data : mockMembershipSettings; return { status: 200, body: { member: mem, status: statusOf(mem), eligibility: eligibility(mem, YEAR, ms.plans, ms.rules) } }; }
  if ((m = path.match(/^\/admin\/members\/([A-Za-z0-9-]+)\/approve$/)) && method === 'POST') {
    const mem = await getMember(ctx, m[1]); need(ctx, 'members.approve');
    const settings = MembershipSettingsSchema.safeParse(await document(db, ctx.orgId, 'membership-settings'));
    const ms = settings.success ? settings.data : mockMembershipSettings;
    const blockers = approvalBlockers(mem, ms.rules, ms.year, ms.plans);   // the organization's plans and the year being sold
    if (blockers.length) throw new HttpError(409, 'The approval rule asks for this first.', blockers);
    if (mem.approvedOn) throw new HttpError(409, 'Already approved.');
    if (mem.joinStage === 'incomplete') throw new HttpError(409, 'This application is not finished yet – send them the link to finish it (Work queues › Incomplete applications).');
    const ref = String((req.body as { ref?: string })?.ref ?? '').slice(0, 120);
    await db.run({ org: ctx.orgId, role: 'app_api' }, [{ sql: `UPDATE app.members SET approved_on = $2::date, record = jsonb_set(record, '{audit}', coalesce(record->'audit', '[]'::jsonb) || $3::jsonb) WHERE id = $1`, params: [mem.id, today, [{ at: new Date().toISOString(), by: ctx.me!.name, action: 'Approved', detail: ref || `${ms.rules.approval.by || 'Board'} approval` }]] }]);
    await db.run({ org: ctx.orgId, role: 'app_api' }, [{ sql: 'SELECT app.refresh_status($1::uuid, $2)', params: [ctx.orgId, mem.id] }, { sql: `UPDATE app.applications SET status = 'approved', decided_at = now(), decided_by = $2 WHERE member_id = $1 AND status NOT IN ('approved', 'rejected', 'withdrawn')`, params: [mem.id, ctx.me!.name] }]);
    await audit(ctx, 'members', 'Approved', ref, mem.id);
    return { status: 200, body: { id: mem.id, approvedOn: today } };
  }
  // v0 tickets were replaced by the help desk and team tasks (B4a); /public/tickets is an alias in helpdesk.ts
  if (path === '/admin/tickets' || path.startsWith('/admin/tickets/')) throw new HttpError(410, 'Tickets moved: use /admin/helpdesk/tickets for requests and /admin/tasks for team tasks.');
  if (path === '/admin/audit' && method === 'GET') {
    need(ctx, 'admins.manage');
    return { status: 200, body: { entries: await rows(db, { org: ctx.orgId, role: 'app_api' }, 'SELECT at, actor, area, action, detail, target FROM app.audit_log ORDER BY at DESC LIMIT 200') } };
  }
  throw new HttpError(404, `No route ${method} ${path}.`);
}

/* ---------------- server ---------------- */
/** The member app reads errors as { message, fields } (mobile/src/core/net/failure.ts) – the same error, its words. */
function appError(e: HttpError) {
  const d = e.detail; const fields: Record<string, string> = {};
  if (Array.isArray(d)) for (const i of d as { path?: unknown; message?: unknown }[]) { const k = String(i?.path ?? '_') || '_'; if (!fields[k] && typeof i?.message === 'string') fields[k] = i.message; }
  else if (d && typeof d === 'object') for (const [k, v] of Object.entries(d as Record<string, unknown>)) if (typeof v === 'string') fields[k] = v;
  return { message: e.message, ...(Object.keys(fields).length ? { fields } : {}) };
}
/** JSON bodies; form posts (Twilio webhooks) become an object; anything else (a file uploaded to local storage) stays bytes.
 *  The raw text is kept for webhook signatures. 52 MB at most (the largest file the platform takes is 50 MB). */
function readBody(req: IncomingMessage): Promise<{ body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 52_500_000) { reject(new HttpError(413, 'Too large.')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      const buf = Buffer.concat(chunks); const type = String(req.headers['content-type'] ?? '');
      if (!buf.length) return resolve({ body: undefined, raw: '' });
      if (type.startsWith('application/x-www-form-urlencoded')) { const raw = buf.toString('utf8'); return resolve({ body: Object.fromEntries(new URLSearchParams(raw)), raw }); }
      if (type.startsWith('application/json') || !type) { const raw = buf.toString('utf8'); if (raw.length > 2_000_000) return reject(new HttpError(413, 'Too large.')); try { return resolve({ body: JSON.parse(raw), raw }); } catch { return reject(new HttpError(400, 'The body is not JSON.')); } }
      resolve({ body: buf, raw: '' });
    });
    req.on('error', reject);
  });
}
export function createApi(db: Db) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const send = (status: number, body: unknown, extra: Record<string, string | string[]> = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', ...extra }); res.end(Buffer.isBuffer(body) ? body : typeof body === 'string' && extra['content-type'] ? body : JSON.stringify(body)); };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '');
      // cookie sessions: a write must come from one of our own sites (CSRF); ALLOWED_ORIGINS lists them (empty = development)
      const origin = String(req.headers.origin ?? ''); const allowed = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (write && origin && allowed.length && !allowed.includes(origin)) throw new HttpError(403, 'This request did not come from our site.');
      const read = write ? await readBody(req) : { body: undefined, raw: '' };
      const ip = clientIp(req.headers, req.socket.remoteAddress ?? '');
      const out = await route(db, { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body: read.body, raw: read.raw, ip });
      send(out.status, out.body, out.headers);
    } catch (e) {
      if (e instanceof HttpError) send(e.status, { error: e.message, detail: e.detail, code: e.code, ...((req.url ?? '').startsWith('/app/') ? appError(e) : {}) });
      else { console.error(e); send(500, { error: 'Something went wrong on our side.' }); }
    } finally { if (process.env.API_LOG) console.log(`${req.method} ${req.url} ${Date.now() - started}ms`); }
  });
  // longer than the load balancer's idle timeout (60 s), so a reused connection is never closed under a request
  server.keepAliveTimeout = 65_000; server.headersTimeout = 66_000;
  return server;
}
if (process.argv[1] && /server\.ts$/.test(process.argv[1])) {
  const { assertProduction } = await import('../production.js');
  assertProduction('API');   // production: refuses development shortcuts and missing secrets
  const port = Number(process.env.PORT ?? 4330); const db = openDb();
  const server = createApi(db);
  // a restart or an update (SIGTERM from docker / pm2 / systemd): finish the requests in flight, then close the database
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return; stopping = true;
    console.log(`${sig}: finishing open requests, then stopping…`);
    server.close(() => { void db.close().catch(() => {}).finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10_000).unref();   // never hang a deploy
  };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
  const host = process.env.HOST || undefined;   // production: HOST=127.0.0.1 – only nginx and the apps on this server reach the API
  server.listen(port, host, async () => {
    console.log(`API on http://${host ?? 'localhost'}:${port} (adapter ${process.env.DB_ADAPTER || 'pg'}) – health: http://localhost:${port}/health`);
    // say right away whether the database is there (and ready), in plain words
    const { dbStatus, describe } = await import('../db/check.js');
    for (const line of describe(await dbStatus(db))) console.log(line);
    if (process.env.API_LOG) console.log('Requests are listed below as they come in (API_LOG=1).');
  });
}
