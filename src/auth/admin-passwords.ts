/**
 * Development / staging only: every admin's password in ONE file, so the team can find them.
 *   npm run admin:passwords                 → BE/admin-passwords.json: every active admin gets a password (kept if
 *                                              already in the file, a new random one otherwise) and the database is
 *                                              updated to match. Edit a password in the file and run it again to apply.
 *   npm run admin:passwords -- --reset      → new random passwords for everyone
 *   npm run server-dev:admin-passwords      → the same against the DEV database (the file stays on this PC)
 * The file is git-ignored and never leaves the machine it is made on. The database keeps only scrypt hashes.
 * Refused when NODE_ENV=production – real people set their own password. Delete the file when that time comes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { openDb, rows, type Db } from '../db/sql.js';
import { hashPassword, passwordProblem } from './crypto.js';
import { randomPassword } from './set-password.js';

const FILE = new URL('../../admin-passwords.json', import.meta.url);
const OWNER = { org: null, role: 'owner' as const };
type Entry = { password: string; name: string; organization: string; roles: string[]; status: string };
type Book = { note: string; updated: string; database: string; admins: Record<string, Entry> };

function readBook(): Book | null {
  if (!existsSync(FILE)) return null;
  try { return JSON.parse(readFileSync(FILE, 'utf8')) as Book; } catch { throw new Error('admin-passwords.json is not valid JSON – fix it (or delete it to start over).'); }
}

export async function syncAdminPasswords(db: Db, opts: { reset?: boolean } = {}) {
  const book = readBook();
  const list = await rows(db, OWNER, `
    SELECT lower(a.email::text) AS email, a.name, a.status, o.slug AS org,
      coalesce((SELECT array_agg(DISTINCT coalesce(r.name, x.role_id) ORDER BY coalesce(r.name, x.role_id)) FROM app.admin_assignments x
        LEFT JOIN app.admin_roles r ON r.org_id = x.org_id AND r.id = x.role_id WHERE x.org_id = a.org_id AND x.admin_id = a.id), '{}') AS roles
    FROM app.admins a JOIN platform.organizations o ON o.id = a.org_id ORDER BY o.slug, lower(a.email::text)`) as { email: string; name: string; status: string; org: string; roles: string[] }[];
  const admins: Record<string, Entry> = {};
  let made = 0, kept = 0, changed = 0;
  for (const a of list) {
    const before = book?.admins?.[a.email]?.password;
    let pw = !opts.reset && before ? before : '';
    if (pw && passwordProblem(pw, a.email)) { console.log(`  ${a.email}: "${passwordProblem(pw, a.email)}" – a new one was made`); pw = ''; }
    if (!pw) { do pw = randomPassword(14); while (passwordProblem(pw, a.email)); made++; } else if (before === pw) kept++;
    const prev = admins[a.email];
    admins[a.email] = { password: pw, name: prev?.name || a.name, organization: prev ? `${prev.organization}, ${a.org}` : a.org, roles: [...new Set([...(prev?.roles ?? []), ...a.roles])], status: a.status };
  }
  // the database: one platform user per email, its password hash = the file
  for (const [email, e] of Object.entries(admins)) {
    await db.run(OWNER, [
      { sql: `INSERT INTO platform.users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`, params: [email, e.name] },
      { sql: `INSERT INTO platform.passwords (user_id, hash) SELECT id, $2 FROM platform.users WHERE email = $1
              ON CONFLICT (user_id) DO UPDATE SET hash = EXCLUDED.hash, changed_at = now()`, params: [email, hashPassword(e.password)] }]);
    changed++;
  }
  const out: Book = {
    note: 'Development/staging admin passwords – NOT in git, never on a production server. Edit a password and run npm run admin:passwords again to apply. Delete this file when people set their own.',
    updated: new Date().toISOString(), database: dbName(), admins,
  };
  writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  return { total: Object.keys(admins).length, made, kept, applied: changed, file: FILE.pathname };
}
const dbName = () => { try { const u = new URL(process.env.DATABASE_URL ?? ''); return `${decodeURIComponent(u.pathname.slice(1))} on ${u.hostname || 'localhost'}`; } catch { return ''; } };

if (process.argv[1] && /admin-passwords\.ts$/.test(process.argv[1])) {
  if (process.env.NODE_ENV === 'production') { console.error('Not on a production server – people set their own passwords there (npm run admin:password -- email for one person).'); process.exit(1); }
  const db = openDb();
  syncAdminPasswords(db, { reset: process.argv.includes('--reset') })
    .then((r) => { console.log(`Admin passwords: ${r.total} admins · ${r.made} new · ${r.kept} kept from the file · ${r.applied} applied to ${dbName()}.`); console.log(`Open BE/admin-passwords.json to see them (git-ignored – never commit or share it).`); })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => db.close());
}
