/**
 * One admin per masjid – an "Associate Director" account that sees only its own masjid (members, dues, events,
 * donations, Zakat cases, the masjid's website section). The reach is enforced in SQL (app.in_scope), the admin
 * app picks the masjid automatically (locked filter), and the Masajid and zones page shows only that masjid.
 *
 *   npm run admins:masjid -- --password "Shared-Pass-2026"          create/refresh the accounts, all with this password
 *   npm run admins:masjid -- --password "…" --role center-admin     another center-limited role
 *   npm run admins:masjid -- --dry-run                              list what would be made
 *
 * Accounts: <masjid-id>@example.org (test addresses – change them in Admins and roles when real people take over),
 * status active, two-step on (the role sees contact details). Re-runnable: existing masjid accounts keep their id and
 * get the new password; nothing else in Admins and roles is touched. Refused on a production database unless --yes.
 */
import { openDb, one, rows } from './sql.js';
import { saveDocument } from '../modules/projections.js';
import { hashPassword, passwordProblem } from '../auth/crypto.js';
import { AccessSchema, type AccessDoc } from '@/lib/community/access';

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? String(args[args.indexOf(k) + 1] ?? '') : '');
const slug = opt('--org') || process.env.DEFAULT_ORG || 'isgh';
const roleId = opt('--role') || 'associate-director';
const password = opt('--password');
const dry = args.includes('--dry-run');
const OWNER = { org: null, role: 'owner' as const };

async function main() {
  if (!dry && !password) { console.log('Usage: npm run admins:masjid -- --password "a password of 10+ characters" [--role associate-director] [--dry-run]'); process.exit(1); }
  const dbn = (() => { try { return decodeURIComponent(new URL(process.env.DATABASE_URL ?? '').pathname.slice(1)); } catch { return ''; } })();
  if (!dry && process.env.NODE_ENV === 'production' && !/_(dev|test|staging)$/i.test(dbn) && !args.includes('--yes')) { console.error(`"${dbn}" looks like a production database – add --yes if these test accounts really belong there.`); process.exit(1); }
  const db = openDb();
  const org = await one<{ id: string; name: string }>(db, OWNER, 'SELECT id::text, name FROM platform.organizations WHERE slug = $1', [slug]);
  if (!org) throw new Error(`No organization "${slug}".`);
  const A = { org: org.id, role: 'app_api' as const };
  const cur = await one<{ data: unknown }>(db, A, `SELECT data FROM app.documents WHERE key = 'admin-access'`);
  if (!cur) throw new Error('No Admins and roles document yet – open Admins and roles in the admin once and publish.');
  const parsed = AccessSchema.safeParse(cur.data);
  if (!parsed.success) throw new Error(`Admins and roles document does not validate: ${parsed.error.issues[0]?.message}`);
  const doc: AccessDoc = parsed.data;
  const role = doc.roles.find((r) => r.id === roleId);
  if (!role) throw new Error(`No role "${roleId}". Roles: ${doc.roles.map((r) => r.id).join(', ')}`);
  if (!role.centerScoped) throw new Error(`"${role.name}" is not limited to a masjid – pick a center-limited role (associate-director, center-admin, membership-secretary …).`);
  const struct = await one<{ data: { centers: { id: string; name: string; zone: string; zips: string[]; active: boolean }[] } }>(db, A, `SELECT data FROM app.documents WHERE key = 'org-structure'`);
  const centers = (struct?.data.centers ?? []).filter((c) => c.active !== false);
  if (!centers.length) throw new Error('No masjids in Masjids and zones.');

  const made: { masjid: string; email: string; existed: boolean }[] = [];
  for (const c of centers) {
    const id = `masjid-${c.id}`.slice(0, 40); const email = `${c.id}@example.org`;
    const i = doc.admins.findIndex((a) => a.id === id);
    const base = i >= 0 ? doc.admins[i] : { id, name: `${c.name} – admin`, email, roleId, zones: [], centers: [c.name], zips: [], more: [], memberId: '', homeZip: c.zips?.[0] ?? '', givenBy: 'Setup', holderId: '', reviewedOn: '', status: 'active' as const, twoStep: true };
    const next = { ...base, roleId, centers: [c.name], zones: [], zips: [], status: 'active' as const, twoStep: true };
    if (i >= 0) doc.admins[i] = next; else doc.admins.push(next);
    if (password && passwordProblem(password, next.email)) throw new Error(`Password: ${passwordProblem(password, next.email)}`);
    made.push({ masjid: c.name, email: next.email, existed: i >= 0 });
  }
  console.table(made);
  if (dry) { console.log('Dry run – nothing changed.'); await db.close(); return; }
  const check = AccessSchema.safeParse(doc);
  if (!check.success) throw new Error(`The result would not validate: ${check.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join(' · ')}`);
  const version = await saveDocument(db, org.id, 'admin-access', check.data, 'Setup', `One admin per masjid (${role.name})`);
  for (const m of made) {
    await db.run(OWNER, [
      { sql: `INSERT INTO platform.users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`, params: [m.email, `${m.masjid} – admin`] },
      { sql: `INSERT INTO platform.passwords (user_id, hash) SELECT id, $2 FROM platform.users WHERE email = $1 ON CONFLICT (user_id) DO UPDATE SET hash = EXCLUDED.hash, changed_at = now()`, params: [m.email, hashPassword(password)] }]);
  }
  const n = await rows(db, A, `SELECT count(*)::int AS n FROM app.admin_assignments x WHERE x.role_id = $1 AND cardinality(x.center_ids) = 1`, [roleId]);
  console.log(`Done. Admins and roles version ${version}: ${made.length} masjid admins (${made.filter((m) => m.existed).length} refreshed) · ${(n[0] as { n: number }).n} assignments reach exactly one masjid. Sign in with the address above and the password you gave; the two-step code is emailed (development: the fixed code).`);
  await db.close();
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
