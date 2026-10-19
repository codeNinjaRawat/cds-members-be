/**
 * Is the database there, and is it ready? Used when the API starts (it prints the answer), by GET /health, and by
 * `npm run db:check` (prints the answer and exits 1 when something is wrong).
 */
import { readdirSync } from 'node:fs';
import { one, type Db } from './sql.js';

const OWNER = { org: null, role: 'owner' as const };
export type DbStatus =
  | { connected: true; database: string; user: string; server: string; version: string; migrations: { applied: number; files: number }; organizations: number; members: number; ms: number }
  | { connected: false; server: string; problem: string; fix: string; ms: number };

/** Where DATABASE_URL points, without the password. */
export function dbTarget(url = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/isgh_dev') {
  try { const u = new URL(url); return { host: u.hostname || decodeURIComponent(u.searchParams.get('host') ?? 'localhost'), port: u.port || '5432', database: decodeURIComponent(u.pathname.slice(1)) || '(default)', user: decodeURIComponent(u.username) || '(default)' }; }
  catch { return { host: '?', port: '?', database: '?', user: '?' }; }
}
const migrationFiles = () => { try { return readdirSync(new URL('../../sql/', import.meta.url)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).length; } catch { return 0; } };

/** Plain words for the usual reasons a connection fails. */
function explain(e: unknown, t: ReturnType<typeof dbTarget>): { problem: string; fix: string } {
  const code = String((e as { code?: string })?.code ?? ''); const msg = String((e as Error)?.message ?? e);
  if (code === '28P01' || /password authentication failed/i.test(msg)) return { problem: `the password for user "${t.user}" is not right`, fix: 'Put the right password in DATABASE_URL in BE/.env (postgresql://USER:PASSWORD@HOST:5432/DATABASE).' };
  if (code === '3D000' || /database .* does not exist/i.test(msg)) return { problem: `the database "${t.database}" does not exist`, fix: `Create it once: psql -U ${t.user} -c "CREATE DATABASE ${t.database};"  (empty is fine), then npm run migrate.` };
  if (code === 'ENOTFOUND' || /ENOTFOUND|could not translate host name/i.test(msg)) return { problem: `the host "${t.host}" is not known`, fix: 'Check the host in DATABASE_URL (on this PC it is localhost).' };
  if (code === 'ECONNREFUSED' || /ECONNREFUSED|could not connect|Connection refused|connection to server .* failed/i.test(msg)) return { problem: `nothing answers on ${t.host}:${t.port}`, fix: 'Start PostgreSQL (Windows: Services › postgresql-x64-16 › Start), or check the port in DATABASE_URL.' };
  if (/self.signed|certificate/i.test(msg)) return { problem: 'the server certificate could not be checked', fix: 'For the server database use DATABASE_SSL=require (encrypted, no certificate check) – the server uses PostgreSQL\'s own certificate.' };
  if (code === '28000' || /no pg_hba\.conf entry|no encryption/i.test(msg)) return { problem: `the server does not let "${t.user}" in from here`, fix: 'The server database needs encryption: set DATABASE_SSL=require (or ?sslmode=no-verify), and use the right user for that database.' };
  if (/does not support SSL/i.test(msg)) return { problem: 'the server has encryption switched off', fix: 'Set DATABASE_SSL=disable (only for a database on the same machine).' };
  if (/pg package is not installed/i.test(msg)) return { problem: 'the database driver is not installed', fix: 'Run npm install in the BE folder.' };
  if (/timeout/i.test(msg)) return { problem: `no answer from ${t.host}:${t.port} in time`, fix: 'From this PC: Test-NetConnection <host> -Port <port> must say True (AWS security group, Wi-Fi/office firewall). The API waits DB_CONNECT_TIMEOUT_MS (default 10 s) for a far-away database.' };
  return { problem: msg.split('\n')[0].slice(0, 200), fix: 'Check DATABASE_URL in BE/.env.' };
}

export async function dbStatus(db: Db, timeoutMs = 10_000): Promise<DbStatus> {
  const t = dbTarget(); const server = `${t.host}:${t.port}`; const started = Date.now();
  const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), timeoutMs).unref());
  try {
    const r = await Promise.race([one<{ database: string; user: string; version: string }>(db, OWNER, `SELECT current_database() AS database, current_user AS "user", split_part(version(), ' ', 2) AS version`), timeout]);
    const applied = await one<{ n: number }>(db, OWNER, `SELECT count(*)::int AS n FROM public.app_migrations`).catch(() => ({ n: 0 }));
    const orgs = await one<{ n: number }>(db, OWNER, `SELECT count(*)::int AS n FROM platform.organizations`).catch(() => ({ n: 0 }));
    const members = await one<{ n: number }>(db, OWNER, `SELECT count(*)::int AS n FROM app.members`).catch(() => ({ n: 0 }));
    return { connected: true, database: r!.database, user: r!.user, server, version: r!.version, migrations: { applied: applied?.n ?? 0, files: migrationFiles() }, organizations: orgs?.n ?? 0, members: members?.n ?? 0, ms: Date.now() - started };
  } catch (e) { return { connected: false, server, ...explain(e, t), ms: Date.now() - started }; }
}

/** The lines the API prints when it starts (and npm run db:check prints). */
export function describe(s: DbStatus): string[] {
  if (!s.connected) return [`Database: NOT connected – ${s.problem} (${s.server}).`, `          ${s.fix}`];
  const lines = [`Database: connected – "${s.database}" on ${s.server} as ${s.user} (PostgreSQL ${s.version}, ${s.ms} ms)`];
  if (s.migrations.applied < s.migrations.files) lines.push(`          ${s.migrations.applied} of ${s.migrations.files} migrations applied – run npm run migrate (then npm run seed).`);
  else lines.push(`          ${s.migrations.applied} migrations · ${s.organizations} organization${s.organizations === 1 ? '' : 's'} · ${s.members} member records`);
  if (s.migrations.applied >= s.migrations.files && !s.organizations) lines.push('          No organization yet – run npm run seed.');
  return lines;
}

if (process.argv[1] && /check\.ts$/.test(process.argv[1])) {
  const { openDb } = await import('./sql.js');
  const db = openDb(); const s = await dbStatus(db);
  for (const l of describe(s)) console.log(l);
  await db.close().catch(() => {});
  // --connect: only the connection counts (before the first migrate); otherwise ready = connected, migrated and seeded
  process.exit(s.connected && (process.argv.includes('--connect') || (s.migrations.applied >= s.migrations.files && s.organizations > 0)) ? 0 : 1);
}
