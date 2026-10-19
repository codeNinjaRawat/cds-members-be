/**
 * Object storage for uploads. FILES_STORAGE = local | s3.
 *   local – files under FILES_DIR (default ./data/files); the signed addresses are this API's own /files/raw/… routes.
 *           For development and tests (and a single small server).
 *   s3    – any S3-compatible store (AWS S3, Cloudflare R2, Backblaze B2, MinIO): S3_ENDPOINT (https://…), S3_REGION,
 *           S3_BUCKET, S3_KEY, S3_SECRET. Addresses are presigned with AWS Signature V4 (query string) – no SDK.
 * Browsers upload and download directly with the short-lived address; the API never streams big files.
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { signLink } from '../auth/crypto.js';

export type Signed = { url: string; method: 'PUT' | 'GET'; headers: Record<string, string>; expiresIn: number };
export interface Storage {
  name: 'local' | 's3';
  uploadUrl(key: string, mime: string, seconds?: number): Promise<Signed>;
  downloadUrl(key: string, filename: string, seconds?: number): Promise<Signed>;
  head(key: string): Promise<{ bytes: number; sha256?: string } | null>;
  remove(key: string): Promise<void>;
}

/* ---------------- AWS Signature V4, query-string presign ---------------- */
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** Presigned URL for one S3 request (path-style when an endpoint is given, virtual-host style for AWS). */
export function presign(o: { method: string; endpoint?: string; region: string; bucket: string; key: string; accessKey: string; secret: string; expires: number; now?: Date; query?: Record<string, string> }) {
  const now = o.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); const day = amzDate.slice(0, 8);
  const host = o.endpoint ? new URL(o.endpoint).host : `${o.bucket}.s3.amazonaws.com`;
  const path = `${o.endpoint ? `/${o.bucket}` : ''}/${o.key.split('/').map(enc).join('/')}`;
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const q: Record<string, string> = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${o.accessKey}/${scope}`, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(o.expires), 'X-Amz-SignedHeaders': 'host', ...(o.query ?? {}) };
  const qs = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonical = [o.method, path, qs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secret}`, day), o.region), 's3'), 'aws4_request');
  const sig = createHmac('sha256', key).update(toSign).digest('hex');
  return `${o.endpoint ? new URL(o.endpoint).origin : `https://${host}`}${path}?${qs}&X-Amz-Signature=${sig}`;
}

function s3(): Storage {
  const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
  const base = () => ({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION ?? 'auto', bucket: env('S3_BUCKET'), accessKey: env('S3_KEY'), secret: env('S3_SECRET') });
  return {
    name: 's3',
    async uploadUrl(key, mime, seconds = 600) { return { url: presign({ ...base(), method: 'PUT', key, expires: seconds }), method: 'PUT', headers: { 'content-type': mime }, expiresIn: seconds }; },
    async downloadUrl(key, filename, seconds = 300) { return { url: presign({ ...base(), method: 'GET', key, expires: seconds, query: { 'response-content-disposition': `attachment; filename="${filename.replace(/[^\w.-]+/g, '_')}"` } }), method: 'GET', headers: {}, expiresIn: seconds }; },
    async head(key) { const r = await fetch(presign({ ...base(), method: 'HEAD', key, expires: 60 }), { method: 'HEAD' }); if (!r.ok) return null; return { bytes: Number(r.headers.get('content-length') ?? 0) }; },
    async remove(key) { await fetch(presign({ ...base(), method: 'DELETE', key, expires: 60 }), { method: 'DELETE' }); },
  };
}

/* ---------------- local disk (signed links to this API) ---------------- */
const root = () => normalize(process.env.FILES_DIR ?? join(process.cwd(), 'data', 'files'));
const safe = (key: string) => { const p = normalize(join(root(), key)); if (!p.startsWith(root())) throw new Error('bad key'); return p; };
/** token = base64url({k, m, e}) + "." + signature – only this server can make one, and it stops working at e. */
export const linkToken = (key: string, method: 'PUT' | 'GET', seconds: number, name = '') => { const b = Buffer.from(JSON.stringify({ k: key, m: method, e: Math.floor(Date.now() / 1000) + seconds, n: name })).toString('base64url'); return `${b}.${signLink(`file|${b}`)}`; };
export function readToken(token: string): { k: string; m: 'PUT' | 'GET'; e: number; n: string } | null {
  const [b, sig] = token.split('.'); if (!b || !sig || signLink(`file|${b}`) !== sig) return null;
  const t = JSON.parse(Buffer.from(b, 'base64url').toString()) as { k: string; m: 'PUT' | 'GET'; e: number; n: string };
  return t.e >= Math.floor(Date.now() / 1000) ? t : null;
}
export const localPut = async (key: string, data: Buffer) => { const p = safe(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, data); };
export const localGet = async (key: string) => readFile(safe(key));
function local(): Storage {
  const api = () => process.env.PUBLIC_API_URL ?? '';
  return {
    name: 'local',
    async uploadUrl(key, mime, seconds = 600) { return { url: `${api()}/files/raw/${linkToken(key, 'PUT', seconds)}`, method: 'PUT', headers: { 'content-type': mime }, expiresIn: seconds }; },
    async downloadUrl(key, filename, seconds = 300) { return { url: `${api()}/files/raw/${linkToken(key, 'GET', seconds, filename)}`, method: 'GET', headers: {}, expiresIn: seconds }; },
    async head(key) { try { const s = await stat(safe(key)); const buf = await readFile(safe(key)); return { bytes: s.size, sha256: createHash('sha256').update(buf).digest('hex') }; } catch { return null; } },
    async remove(key) { await rm(safe(key), { force: true }); },
  };
}
export const storage = (): Storage => (process.env.FILES_STORAGE === 's3' ? s3() : local());
