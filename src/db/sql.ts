/**
 * The database door. One interface, two adapters:
 *  - pg (production, `npm install`): a pool; every call runs in its own transaction as role app_api with
 *    `SET LOCAL app.org_id` – Row Level Security does the tenant isolation, not the code.
 *  - psql (development / CI without npm): the same statements through the psql command line, parameters passed as
 *    psql variables (`:'p1'`), rows read back as JSON. Slower, but no dependency – it is what the sandbox tests use.
 * SQL uses $1…$n placeholders in both adapters. Statements that return rows must be SELECT, or DML with RETURNING.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type Row = Record<string, unknown>;
export type Statement = { sql: string; params?: unknown[] };
export type Actor = { org: string | null; role: 'app_api' | 'app_platform' | 'owner' };
export interface Db {
  /** Run statements in ONE transaction as the actor; returns the rows of each statement (empty for non-returning ones). */
  run(actor: Actor, statements: Statement[]): Promise<Row[][]>;
  /** DDL / migrations as the database owner, outside RLS. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
export const rows = async (db: Db, actor: Actor, sql: string, params: unknown[] = []) => (await db.run(actor, [{ sql, params }]))[0] ?? [];
export const one = async <T = Row>(db: Db, actor: Actor, sql: string, params: unknown[] = []) => ((await rows(db, actor, sql, params))[0] as T | undefined) ?? null;

const isReturning = (sql: string) => /^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
const toParam = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));


/* ---------------- connection settings (both adapters) ----------------
 * DATABASE_SSL (or sslmode= in DATABASE_URL; the variable wins): disable (default; same machine) · require (encrypted,
 * certificate not checked – the server's own self-signed certificate; "no-verify" means the same) · verify-full
 * (+ DATABASE_SSL_CA). One meaning for both adapters: pg alone treats sslmode=require as "check the certificate"
 * (fails on self-signed) and psql does not know "no-verify". memory/database-environments.md.
 */
type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';
const SSL_WORDS: Record<string, SslMode> = {
  '': 'disable', disable: 'disable', off: 'disable', false: 'disable', '0': 'disable', allow: 'disable',
  require: 'require', prefer: 'require', 'no-verify': 'require', on: 'require', true: 'require', '1': 'require',
  'verify-ca': 'verify-ca', verify: 'verify-full', 'verify-full': 'verify-full',
};
export function sslSettings(url: string, env: NodeJS.ProcessEnv = process.env): { mode: SslMode; ca?: string; cleanUrl: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { mode: 'disable', cleanUrl: url }; }
  const word = (env.DATABASE_SSL ?? u.searchParams.get('sslmode') ?? '').trim().toLowerCase();
  const mode = SSL_WORDS[word];
  if (!mode) throw new Error(`DATABASE_SSL / sslmode "${word}" is not known – use disable, require or verify-full`);
  const ca = env.DATABASE_SSL_CA || u.searchParams.get('sslrootcert') || undefined;
  for (const k of ['sslmode', 'sslrootcert', 'uselibpqcompat']) u.searchParams.delete(k);
  return { mode, ca, cleanUrl: u.toString() };
}
/** Pool options for the pg driver: ssl translated, a connect timeout so a far-away database fails fast, a name for pgAdmin. */
export function pgConfig(url: string, env: NodeJS.ProcessEnv = process.env) {
  const { mode, ca, cleanUrl } = sslSettings(url, env);
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const ssl = mode === 'disable' ? false
    : mode === 'require' ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true, ...(ca ? { ca: readFileSync(ca, 'utf8') } : {}), ...(mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}) };
  return {
    connectionString: cleanUrl, ssl,
    max: num(env.DATABASE_POOL_MAX, 10),
    connectionTimeoutMillis: num(env.DATABASE_CONNECT_TIMEOUT_MS ?? env.DB_CONNECT_TIMEOUT_MS, 10_000),
    idleTimeoutMillis: num(env.DATABASE_IDLE_MS, 30_000),   // a far-away DEV database: keep connections open longer (each new one costs seconds)
    keepAlive: true,
    application_name: env.DATABASE_APP_NAME || 'membership-api',   // shows in pgAdmin → Dashboard → Sessions
  };
}
/** The same address for psql (libpq words: no-verify → require, verify → verify-full). */
export function psqlUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const { mode, ca, cleanUrl } = sslSettings(url, env);
  if (mode === 'disable' && !env.DATABASE_SSL && !/[?&]sslmode=/.test(url)) return cleanUrl;
  const u = new URL(cleanUrl); u.searchParams.set('sslmode', mode); if (ca) u.searchParams.set('sslrootcert', ca);
  return u.toString();
}

/* ---------------- psql adapter ---------------- */
export class PsqlDb implements Db {
  private url: string;
  constructor(url: string) { this.url = psqlUrl(url); }
  private psql(args: string[], input?: string) {
    const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', this.url, ...args], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'psql failed').trim().split('\n').filter((l) => /ERROR|DETAIL|FATAL/.test(l)).join(' ') || r.stderr);
    return r.stdout;
  }
  async exec(sql: string) { this.psql([], sql); }
  async run(actor: Actor, statements: Statement[]): Promise<Row[][]> {
    const vars: string[] = []; let n = 0;
    const parts: string[] = ['BEGIN;'];
    if (actor.role !== 'owner') parts.push(`SET LOCAL ROLE ${actor.role};`);
    parts.push(`SET LOCAL app.org_id = ${actor.org ? `'${actor.org.replace(/'/g, '')}'` : "''"};`);
    statements.forEach((st, i) => {
      const sql = st.sql.replace(/\$(\d+)/g, (_, k) => { const name = `p${i}_${k}`; return `:'${name}'`; });
      (st.params ?? []).forEach((v, k) => { n++; const val = toParam(v); vars.push('-v', `p${i}_${k + 1}=${val === null ? '' : val}`); });
      const body = sql.replace(/;\s*$/, '');
      if (/^\s*(select|with)\b/i.test(body)) parts.push(`SELECT '@@${i}' || coalesce(json_agg(row_to_json(t)), '[]')::text FROM (${body}) t;`);
      else if (isReturning(body)) parts.push(`WITH t AS (${body}) SELECT '@@${i}' || coalesce(json_agg(row_to_json(t)), '[]')::text FROM t;`);
      else parts.push(`${body};`);
    });
    parts.push('COMMIT;');
    void n;
    // NULL parameters: psql variables cannot carry NULL, so '' arrives; SQL that needs NULL uses NULLIF($n, '')
    const out = this.psql(vars, parts.join('\n'));
    const result: Row[][] = statements.map(() => []);
    for (const line of out.split('\n')) { const m = line.match(/^@@(\d+)(.*)$/); if (m) result[Number(m[1])] = JSON.parse(m[2]) as Row[]; }
    return result;
  }
  async close() { /* nothing to close */ }
}

/* ---------------- pg adapter (lazy: only when the package is installed) ---------------- */
export class PgDb implements Db {
  private pool: { connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>; release: () => void }>; end: () => Promise<void>; on?: (ev: 'error', fn: (e: Error) => void) => void } | null = null;
  constructor(private url: string) {}
  private async getPool() {
    if (!this.pool) { const mod = await import('pg' as string).catch(() => null); if (!mod) throw new Error('The pg package is not installed – run npm install, or set DB_ADAPTER=psql.'); // DATE columns stay 'YYYY-MM-DD' text (as with psql) – never a JavaScript Date shifted by this PC's timezone
      { const types = (mod.default ?? mod).types; types?.setTypeParser?.(1082, (v: string) => v); types?.setTypeParser?.(1182, (v: string) => (v === '{}' ? [] : v.slice(1, -1).split(','))); }
      const pool = new (mod.default?.Pool ?? mod.Pool)(pgConfig(this.url));
      // a dropped idle connection (network blip to a remote database) must not crash the process – the next query reconnects
      pool.on?.('error', (e: Error) => console.error('database: idle connection lost –', e.message));
      this.pool = pool; }
    return this.pool!;
  }
  async exec(sql: string) { const c = await (await this.getPool()).connect(); try { await c.query(sql); } finally { c.release(); } }
  async run(actor: Actor, statements: Statement[]): Promise<Row[][]> {
    const c = await (await this.getPool()).connect();
    try {
      // one round trip instead of three (matters for a far-away database: PC → server ≈ 250 ms each). The role comes
      // from a fixed list; the organization id is only inlined when it is a plain uuid, otherwise sent as a parameter.
      const role = actor.role === 'app_api' || actor.role === 'app_platform' ? `SET LOCAL ROLE ${actor.role}; ` : '';
      const org = actor.org ?? '';
      if (/^[0-9a-f-]{0,36}$/i.test(org)) await c.query(`BEGIN; ${role}SELECT set_config('app.org_id', '${org}', true)`);
      else { await c.query(`BEGIN; ${role}SELECT 1`); await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]); }
      const out: Row[][] = [];
      for (const st of statements) out.push((await c.query(st.sql, (st.params ?? []).map(toParam))).rows);
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  async close() { if (this.pool) await this.pool.end(); }
}

export function openDb(): Db {
  const url = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/isgh_dev';
  return (process.env.DB_ADAPTER || 'pg') === 'psql' ? new PsqlDb(url) : new PgDb(url);
}
