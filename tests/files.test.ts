/**
 * B6c Files – signed uploads and downloads (local storage), areas and permissions, member photo IDs, retention, and the
 * S3 signature against AWS's published example.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/files.test.ts
 */
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1'; process.env.FILES_DIR = mkdtempSync(join(tmpdir(), 'files-'));
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');
const { presign } = await import('../src/files/storage.js');
const { purgeFiles } = await import('../src/files/routes.js');
const { systemContext } = await import('../src/jobs/runner.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`; process.env.PUBLIC_API_URL = base;
const call = async (method: string, path: string, body?: unknown, who: string | { cookie: string } = 'owner') => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof who === 'string') { if (who) h['x-admin'] = who; } else h.cookie = who.cookie;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(db, OWNER, sql, p))!.n;
const pdf = Buffer.from('%PDF-1.4\n% minutes of the Shura meeting\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

/* S3: the signature matches AWS's published example (Signature V4, query string) */
const url = presign({ method: 'GET', region: 'us-east-1', bucket: 'examplebucket', key: 'test.txt', accessKey: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', expires: 86400, now: new Date('2013-05-24T00:00:00Z') });
ok(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404') && url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?'), 'S3 presign = AWS example', url);

/* an admin uploads minutes: ask → upload → done → download */
const nf = await call('POST', '/admin/files', { area: 'minutes', name: 'Shura minutes October.pdf', mime: 'application/pdf', bytes: pdf.length, visibility: 'members', ref: 'shura-2026-10' });
ok(nf.status === 201 && nf.body.upload.method === 'PUT' && nf.body.upload.url.includes('/files/raw/'), 'upload address given', nf.body);
ok((await call('POST', `/admin/files/${nf.body.id}/complete`, {})).status === 409, 'not done before the bytes arrive');
const put = await fetch(nf.body.upload.url, { method: 'PUT', headers: nf.body.upload.headers, body: pdf });
ok(put.status === 200, 'bytes stored');
const done = await call('POST', `/admin/files/${nf.body.id}/complete`, {});
ok(done.status === 200 && done.body.status === 'ready' && done.body.bytes === pdf.length, 'ready');
ok(await n(`SELECT count(*)::int AS n FROM app.files WHERE id = $1::uuid AND sha256 IS NOT NULL AND storage_key LIKE 'org/%/minutes/%.pdf'`, [nf.body.id]) === 1, 'fingerprint and a key inside the organization’s folder');
const get = await call('GET', `/admin/files/${nf.body.id}`);
const dl = await fetch(get.body.download.url);
ok(dl.status === 200 && Buffer.from(await dl.arrayBuffer()).equals(pdf) && (dl.headers.get('content-disposition') ?? '').includes('Shura_minutes_October.pdf'), 'download address gives the same bytes');
ok((await fetch(nf.body.upload.url.replace(/.$/, (c: string) => (c === 'a' ? 'b' : 'a')), { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdf })).status === 403, 'a changed address does not work');
ok((await fetch(get.body.download.url.replace('/files/raw/', '/files/raw/x'))).status === 403, 'nor a made-up one');
ok((await fetch(get.body.download.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdf })).status === 405, 'a download address cannot upload');
const list = await call('GET', '/admin/files?ref=shura-2026-10');
ok(list.body.files.length === 1 && list.body.files[0].name === 'Shura minutes October.pdf', 'files by what they belong to');

/* areas decide what is allowed */
ok((await call('POST', '/admin/files', { area: 'minutes', name: 'x.exe', mime: 'application/x-msdownload', bytes: 100 })).status === 415, 'no programs');
ok((await call('POST', '/admin/files', { area: 'event', name: 'flyer.pdf', mime: 'application/pdf', bytes: 100 })).status === 415, 'event pictures are images');
ok((await call('POST', '/admin/files', { area: 'brand', name: 'logo.png', mime: 'image/png', bytes: 6 * 1_048_576 })).status === 413, 'size limit per area');
ok((await call('POST', '/admin/files', { area: 'id-check', name: 'id.jpg', mime: 'image/jpeg', bytes: 1000, visibility: 'public' })).status === 400, 'a photo ID is always private');
ok((await call('POST', '/admin/files', { area: 'id-check', name: 'id.jpg', mime: 'image/jpeg', bytes: 1000 }, 'web-editor')).status === 403, 'website editors do not handle IDs');
ok((await call('POST', '/admin/files', { area: 'zakat', name: 'lease.pdf', mime: 'application/pdf', bytes: 1000 }, 'web-editor')).status === 403, 'nor Zakat papers');
ok((await call('GET', '/admin/files', undefined, 'katy-door')).body.files.length === 0, 'lists show only the areas one may see');

/* a member sends a photo of their ID */
const mem = await one<{ id: string; email: string }>(db, OWNER, `SELECT m.id, m.email FROM app.members m WHERE m.org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh') AND m.status = 'pending' AND m.archived IS NULL AND m.email <> '' AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY m.id LIMIT 1`);
const st = await call('POST', '/auth/code/start', { address: mem!.email }, '');
const vr = await fetch(base + '/auth/code/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: mem!.email, code: st.body.devCode }) });
const jar = { cookie: (vr.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)![0] };
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 0xff, 0xd9]);
const mf = await call('POST', '/member/files', { name: 'my-id.jpg', mime: 'image/jpeg', bytes: jpg.length, area: 'record', visibility: 'public' }, jar);
ok(mf.status === 201, 'the member may upload their ID', mf.body);
await fetch(mf.body.upload.url, { method: 'PUT', headers: mf.body.upload.headers, body: jpg });
ok((await call('POST', `/member/files/${mf.body.id}/complete`, {}, jar)).body.status === 'ready', 'done');
const row = await one<{ area: string; visibility: string; member_id: string; purge_after: string }>(db, OWNER, 'SELECT area, visibility, member_id, purge_after::text FROM app.files WHERE id = $1::uuid', [mf.body.id]);
ok(row!.area === 'id-check' && row!.visibility === 'private' && row!.member_id === mem!.id && !!row!.purge_after, 'always a private photo ID of that member, with a delete date', row);
ok((await call('GET', '/member/files', undefined, jar)).body.files.some((f: any) => f.id === mf.body.id && f.deleteOn), 'the member sees it and when it goes');
const opened = await call('GET', `/admin/files/${mf.body.id}`, undefined, 'membership-office');
ok(opened.status === 200 && await n(`SELECT count(*)::int AS n FROM app.audit_log WHERE area = 'files' AND action = 'Private file opened'`) === 1, 'the office opens it – and that is logged');
ok((await call('GET', `/public/files/${mf.body.id}`, undefined, '')).status === 404, 'never public');

/* public pictures */
const img = await call('POST', '/admin/files', { area: 'event', name: 'family-night.png', mime: 'image/png', bytes: 8, visibility: 'public' });
await fetch(img.body.upload.url, { method: 'PUT', headers: img.body.upload.headers, body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
await call('POST', `/admin/files/${img.body.id}/complete`, {});
const pub = await call('GET', `/public/files/${img.body.id}`, undefined, '');
ok(pub.status === 200 && (await fetch(pub.body.download.url)).status === 200, 'public pictures for the website');

/* retention and deleting */
const ctx = await systemContext(db, (await one<{ id: string }>(db, OWNER, `SELECT id::text FROM platform.organizations WHERE slug = 'isgh'`))!.id, 'isgh');
const before = readdirSync(join(process.env.FILES_DIR!, 'org'), { recursive: true }).length;
const pr = await purgeFiles(ctx, new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10));
ok(pr.deleted === 1, 'after 30 days the photo ID is deleted');
ok(await n(`SELECT count(*)::int AS n FROM app.files WHERE id = $1::uuid AND status = 'deleted'`, [mf.body.id]) === 1 && readdirSync(join(process.env.FILES_DIR!, 'org'), { recursive: true }).length < before, 'row marked, bytes gone');
ok((await call('DELETE', `/admin/files/${nf.body.id}`)).status === 200 && (await call('GET', `/admin/files/${nf.body.id}`)).status === 404, 'deleted on request');
ok(!existsSync(join(process.env.FILES_DIR!, (await one<{ k: string }>(db, OWNER, 'SELECT storage_key AS k FROM app.files WHERE id = $1::uuid', [nf.body.id]))!.k)), 'and gone from storage');

server.close(); await db.close();
console.log(`files ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
