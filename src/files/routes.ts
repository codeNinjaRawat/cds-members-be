/**
 * B6c Files. The browser asks for an upload address, sends the file straight to storage, then says "done"; the API checks
 * the size and keeps the index (app.files). Who may upload and see a file depends on its area; photo IDs and Zakat
 * papers are private, downloads of them are audited, and photo IDs are deleted after the retention days.
 *
 *   POST   /admin/files {area, name, mime, bytes, visibility?, ref?, memberId?} → {id, upload: {url, method, headers}}
 *   POST   /admin/files/:id/complete · GET /admin/files/:id (a 5-minute download address) · DELETE /admin/files/:id
 *   GET    /admin/files?area=&ref=&memberId=
 *   POST   /member/files {name, mime, bytes} (the member's own photo ID) · GET /member/files · POST /member/files/:id/complete
 *   GET    /public/files/:id                      public files only (logos, event images, public records)
 *   PUT|GET /files/raw/:token                     the local storage's signed upload / download (FILES_STORAGE=local)
 *   job: purgeFiles(ctx, today)                   photo IDs and anything past purge_after are deleted (bytes and row)
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/sql.js';
import { one, rows } from '../db/sql.js';
import { HttpError, audit, need, route, todayCT, type Ctx, type Req, type Res, type Route } from '../http/core.js';
import { can, type Permission } from '@/lib/community/access';
import { localGet, localPut, readToken, storage } from './storage.js';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
const MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
type Area = 'id-check' | 'record' | 'minutes' | 'event' | 'brand' | 'website' | 'zakat' | 'finance' | 'ticket' | 'other' | 'comms';
/** Who may upload (and see) each area. A file's area never changes. */
const AREA: Record<Area, { perms: Permission[]; maxMb: number; mime?: string[]; retentionDays?: number; sensitive?: boolean }> = {
  'id-check': { perms: ['members.edit', 'members.approve'], maxMb: 10, mime: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/pdf'], retentionDays: 30, sensitive: true },
  record: { perms: ['center.content', 'content.publish'], maxMb: 50 }, minutes: { perms: ['center.content', 'content.publish'], maxMb: 50 },
  event: { perms: ['events.manage'], maxMb: 10, mime: ['image/png', 'image/jpeg', 'image/webp'] }, brand: { perms: ['content.publish'], maxMb: 5, mime: ['image/png', 'image/jpeg', 'image/webp'] },
  website: { perms: ['content.publish'], maxMb: 20 }, zakat: { perms: ['zakat.intake', 'zakat.verify'], maxMb: 20, sensitive: true }, finance: { perms: ['finance.manage', 'payments.record'], maxMb: 20, sensitive: true },
  ticket: { perms: ['members.view'], maxMb: 20 }, other: { perms: ['members.view'], maxMb: 20 },
  comms: { perms: ['comms.send'], maxMb: 10, mime: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },   // pictures in bulk emails
};
const has = (ctx: Ctx, ps: Permission[]) => !!ctx.me && ps.some((p) => can(ctx.access, ctx.me, p, todayCT()));
const New = z.object({ area: z.enum(Object.keys(AREA) as [Area, ...Area[]]), name: z.string().trim().min(1).max(160), mime: z.string(), bytes: z.number().int().min(1), visibility: z.enum(['private', 'members', 'public']).default('private'), ref: z.string().max(80).default(''), memberId: z.string().max(20).default('') });
type FileRow = { id: string; area: Area; name: string; mime: string; bytes: number; visibility: string; status: string; storage_key: string; member_id: string | null; ref: string; uploaded_by: string; uploaded_at: string; purge_after: string | null };
const FILE_SQL = `SELECT id::text, area, name, mime, bytes::int, visibility, status, storage_key, member_id, ref, uploaded_by, uploaded_at::text, purge_after::text FROM app.files`;
const view = (f: FileRow) => ({ id: f.id, area: f.area, name: f.name, mime: f.mime, bytes: f.bytes, visibility: f.visibility, status: f.status, ref: f.ref, memberId: f.member_id, uploadedBy: f.uploaded_by, uploadedAt: f.uploaded_at, deleteOn: f.purge_after });

async function create(ctx: Ctx, raw: unknown, by: string, memberId: string | null) {
  const p = New.safeParse(raw); if (!p.success) throw new HttpError(400, 'Check the file.', issues(p.error)); const b = p.data; const a = AREA[b.area];
  if (!(a.mime ?? MIME).includes(b.mime)) throw new HttpError(415, `This kind of file is not taken here (${(a.mime ?? MIME).map((m) => m.split('/')[1]).join(', ')}).`);
  if (b.bytes > a.maxMb * 1_048_576) throw new HttpError(413, `Files here can be up to ${a.maxMb} MB.`);
  if (a.sensitive && b.visibility !== 'private') throw new HttpError(400, 'This kind of file is always private.');
  if (b.memberId && !(await one(ctx.db, API(ctx), 'SELECT 1 AS x FROM app.members WHERE id = $1', [b.memberId.toUpperCase()]))) throw new HttpError(422, `No member ${b.memberId}.`);
  const id = randomUUID(); const ext = (b.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? b.mime.split('/')[1]).toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = `org/${ctx.orgId}/${b.area}/${id}.${ext}`;
  await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.files (org_id, id, storage_key, area, name, mime, bytes, visibility, uploaded_by, member_id, ref, status, purge_after)
    VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::bigint, $8, $9, NULLIF($10, ''), $11, 'pending', NULLIF($12, '')::date)`,
    params: [ctx.orgId, id, key, b.area, b.name, b.mime, b.bytes, b.visibility, by, memberId ?? b.memberId.toUpperCase(), b.ref, a.retentionDays ? new Date(Date.now() + a.retentionDays * 86_400_000).toISOString().slice(0, 10) : ''] }]);
  return { id, upload: await storage().uploadUrl(key, b.mime) };
}
async function complete(ctx: Ctx, f: FileRow) {
  if (f.status !== 'pending') throw new HttpError(409, `This file is ${f.status}.`);
  const h = await storage().head(f.storage_key); if (!h) throw new HttpError(409, 'The file has not arrived yet – upload it first.');
  if (h.bytes > AREA[f.area].maxMb * 1_048_576) { await storage().remove(f.storage_key); throw new HttpError(413, 'The uploaded file is too big.'); }
  await ctx.db.run(API(ctx), [{ sql: `UPDATE app.files SET status = 'ready', bytes = $2::bigint, sha256 = CASE WHEN $3 = '' THEN NULL ELSE decode($3, 'hex') END WHERE id = $1::uuid`, params: [f.id, h.bytes, h.sha256 ?? ''] }]);
  return { ...view(f), status: 'ready', bytes: h.bytes };
}
async function fileOf(ctx: Ctx, id: string) { const f = await one<FileRow>(ctx.db, API(ctx), `${FILE_SQL} WHERE id = $1::uuid AND status <> 'deleted'`, [id]); if (!f) throw new HttpError(404, 'No such file.'); return f; }
const UUID = '([0-9a-f-]{36})';

export const FILE_ROUTES: Route[] = [
  route('POST', /^\/admin\/files$/, async (ctx) => {
    if (!ctx.me) need(ctx, 'members.view');
    const area = String((ctx.req.body as { area?: string })?.area ?? '') as Area; if (!AREA[area]) throw new HttpError(400, 'Which area?');
    if (!has(ctx, AREA[area].perms)) need(ctx, AREA[area].perms[0]);
    const out = await create(ctx, ctx.req.body, ctx.me!.name, null);
    return { status: 201, body: out };
  }),
  route('GET', /^\/admin\/files$/, async (ctx) => {
    if (!ctx.me) need(ctx, 'members.view');
    const q = ctx.req.query; const list = (await rows(ctx.db, API(ctx), `${FILE_SQL} WHERE status <> 'deleted' AND ($1 = '' OR area = $1) AND ($2 = '' OR ref = $2) AND ($3 = '' OR member_id = $3) ORDER BY uploaded_at DESC LIMIT 500`, [q.get('area') ?? '', q.get('ref') ?? '', (q.get('memberId') ?? '').toUpperCase()])) as FileRow[];
    return { status: 200, body: { files: list.filter((f) => has(ctx, AREA[f.area].perms)).map(view) } };
  }),
  route('POST', new RegExp(`^/admin/files/${UUID}/complete$`), async (ctx, mm) => {
    const f = await fileOf(ctx, mm[1]); if (!has(ctx, AREA[f.area].perms)) need(ctx, AREA[f.area].perms[0]);
    return { status: 200, body: await complete(ctx, f) };
  }),
  route('GET', new RegExp(`^/admin/files/${UUID}$`), async (ctx, mm) => {
    const f = await fileOf(ctx, mm[1]); if (!has(ctx, AREA[f.area].perms)) need(ctx, AREA[f.area].perms[0]);
    if (f.status !== 'ready') throw new HttpError(409, 'The upload is not finished.');
    if (AREA[f.area].sensitive) await audit(ctx, 'files', 'Private file opened', `${f.area}: ${f.name}`, f.id);
    return { status: 200, body: { ...view(f), download: await storage().downloadUrl(f.storage_key, f.name) } };
  }),
  route('DELETE', new RegExp(`^/admin/files/${UUID}$`), async (ctx, mm) => {
    const f = await fileOf(ctx, mm[1]); if (!has(ctx, AREA[f.area].perms)) need(ctx, AREA[f.area].perms[0]);
    await storage().remove(f.storage_key);
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.files SET status = 'deleted', deleted_at = now() WHERE id = $1::uuid`, params: [f.id] }]);
    await audit(ctx, 'files', 'File deleted', `${f.area}: ${f.name}`, f.id);
    return { status: 200, body: { deleted: f.id } };
  }),
  route('POST', /^\/member\/files$/, async (ctx) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const b = (ctx.req.body ?? {}) as Record<string, unknown>;
    const open = await one<{ n: number }>(ctx.db, API(ctx), `SELECT count(*)::int AS n FROM app.files WHERE member_id = $1 AND area = 'id-check' AND status <> 'deleted' AND uploaded_at > now() - interval '1 day'`, [ctx.memberId]);
    if ((open?.n ?? 0) >= 5) throw new HttpError(429, 'You uploaded several photos today – the office will look at them.');
    return { status: 201, body: await create(ctx, { ...b, area: 'id-check', visibility: 'private', memberId: '' }, `Member ${ctx.memberId}`, ctx.memberId) };
  }),
  route('GET', /^\/member\/files$/, async (ctx) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const list = (await rows(ctx.db, API(ctx), `${FILE_SQL} WHERE member_id = $1 AND status <> 'deleted' ORDER BY uploaded_at DESC`, [ctx.memberId])) as FileRow[];
    return { status: 200, body: { files: list.map((f) => ({ id: f.id, name: f.name, area: f.area, status: f.status, uploadedAt: f.uploaded_at, deleteOn: f.purge_after })) } };
  }),
  route('POST', new RegExp(`^/member/files/${UUID}/complete$`), async (ctx, mm) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const f = await fileOf(ctx, mm[1]); if (f.member_id !== ctx.memberId) throw new HttpError(404, 'No such file.');
    const done = await complete(ctx, f);
    return { status: 200, body: { id: done.id, status: done.status } };
  }),
  route('GET', new RegExp(`^/public/files/${UUID}$`), async (ctx, mm) => {
    const f = await one<FileRow>(ctx.db, API(ctx), `${FILE_SQL} WHERE id = $1::uuid AND status = 'ready' AND visibility = 'public'`, [mm[1]]); if (!f) throw new HttpError(404, 'No such file.');
    return { status: 200, body: { name: f.name, mime: f.mime, download: await storage().downloadUrl(f.storage_key, f.name, 3600) } };
  }),
];

/** The local storage's signed addresses (no organization in the address – the signature is the permission). */
export async function handleRaw(_db: Db, req: Req): Promise<Res> {
  const t = readToken(req.path.split('/').pop() ?? ''); if (!t) throw new HttpError(403, 'This file address has expired.');
  if (req.method === 'PUT' && t.m === 'PUT') {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''));
    if (!data.length) throw new HttpError(400, 'Empty file.');
    await localPut(t.k, data); return { status: 200, body: { stored: data.length, sha256: createHash('sha256').update(data).digest('hex') } };
  }
  if (req.method === 'GET' && t.m === 'GET') {
    // pictures open in the page (emails show them); everything else downloads
    const img = /\.(png|jpe?g|webp|gif)$/i.exec(t.n || ''); const mime = img ? `image/${img[1].toLowerCase().replace('jpg', 'jpeg')}` : 'application/octet-stream';
    try { return { status: 200, body: await localGet(t.k), headers: { 'content-type': mime, 'content-disposition': `${img ? 'inline' : 'attachment'}; filename="${(t.n || 'file').replace(/[^\w.-]+/g, '_')}"`, ...(img ? { 'cache-control': 'public, max-age=86400' } : {}) } }; }
    catch { throw new HttpError(404, 'No such file.'); }
  }
  throw new HttpError(405, 'Not allowed.');
}

/** Daily: photo IDs (and anything else with a delete-on date) go – the bytes in storage, and the row is marked deleted. */
export async function purgeFiles(ctx: Ctx, today = todayCT()) {
  const due = (await rows(ctx.db, API(ctx), `${FILE_SQL} WHERE status <> 'deleted' AND purge_after IS NOT NULL AND purge_after <= $1::date`, [today])) as FileRow[];
  for (const f of due) { await storage().remove(f.storage_key).catch(() => undefined); await ctx.db.run(API(ctx), [{ sql: `UPDATE app.files SET status = 'deleted', deleted_at = now() WHERE id = $1::uuid`, params: [f.id] }]); }
  return { deleted: due.length };
}
