/**
 * Rebuild the member records from the Wild Apricot export – MEMBERS ONLY. Admins, roles, every settings document,
 * zones and masajid, events, gifts, help desk, tasks and the audit log are not touched.
 *
 *   npm run wa:rebuild -- imports/Contacts.xml [--org isgh] --yes        (without --yes: shows what would be wiped)
 *
 *  1. Wipes, for the organization: members and everything that hangs off a member (membership terms, dues payments,
 *     applications, notes, ID checks, masjid-change requests, families, households, group memberships, message
 *     deliveries, consents, preferences, app devices and notifications, voter snapshots, duplicate pairs, import logs,
 *     contacts (People), member sessions and app tokens, join codes).
 *  2. Imports the file again (import-wildapricot: names, contact details, masjid, plan, status, terms, spouses, notes).
 *  3. Applies the column legend (wa-legend: not-members, incomplete, ID on file, groups, voting history, People rows).
 */
import { spawnSync } from 'node:child_process';
import { openDb, one, rows } from './sql.js';
import { ensureExport } from './wa-file.js';

const args = process.argv.slice(2); const flag = (f: string) => args.includes(f);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--org');
const orgSlug = args.includes('--org') ? String(args[args.indexOf('--org') + 1]) : 'isgh';

/** Member-only tables, children first. (org-scoped; admins, documents, centers, events, gifts, tickets, tasks are not here) */
const WIPE: { table: string; where?: string }[] = [
  { table: 'app.deliveries' }, { table: 'app.sent_notices' }, { table: 'app.consents', where: 'member_id IS NOT NULL' }, { table: 'app.contact_prefs' },
  { table: 'app.member_notifications' }, { table: 'app.member_devices' }, { table: 'app.member_families' }, { table: 'app.relationships' }, { table: 'app.households' },
  { table: 'app.id_checks' }, { table: 'app.center_changes' }, { table: 'app.duplicate_pairs' }, { table: 'app.group_members' },
  { table: 'app.voter_snapshot_rows' }, { table: 'app.voter_snapshots' }, { table: 'app.checkout_intents', where: "kind = 'dues'" },
  { table: 'app.payments' }, { table: 'app.applications' }, { table: 'app.member_notes' }, { table: 'app.memberships' }, { table: 'app.imports' },
  { table: 'app.contacts' }, { table: 'app.members' },
];

async function main() {
  if (!file) throw new Error('Give the Wild Apricot export file.');
  ensureExport(file);
  const db = openDb();
  const org = await one<{ id: string }>(db, { org: null, role: 'owner' }, 'SELECT id FROM platform.organizations WHERE slug = $1', [orgSlug]); if (!org) throw new Error(`No organization "${orgSlug}".`);
  const A = { org: org.id, role: 'app_api' as const }, O = { org: null, role: 'owner' as const };
  const counts: string[] = [];
  for (const w of WIPE) {
    const r = await one<{ n: number }>(db, A, `SELECT count(*)::int AS n FROM ${w.table} WHERE org_id = $1::uuid${w.where ? ` AND ${w.where}` : ''}`, [org.id]).catch(() => null);
    if (r?.n) counts.push(`${w.table.replace('app.', '')} ${r.n}`);
  }
  const admins = await one<{ n: number }>(db, A, 'SELECT count(*)::int AS n FROM app.admins WHERE org_id = $1::uuid', [org.id]);
  const docs = await one<{ n: number }>(db, A, 'SELECT count(*)::int AS n FROM app.documents WHERE org_id = $1::uuid', [org.id]);
  console.log(`Organization ${orgSlug}: would wipe → ${counts.join(' · ') || 'nothing'}`);
  console.log(`Kept: ${admins?.n ?? 0} admins, ${docs?.n ?? 0} settings documents, zones and masajid, events, gifts, help desk, tasks, audit log.`);
  if (!flag('--yes')) { console.log('Nothing changed. Add --yes to wipe and rebuild.'); await db.close(); return; }

  for (const w of WIPE) await db.run(A, [{ sql: `DELETE FROM ${w.table} WHERE org_id = $1::uuid${w.where ? ` AND ${w.where}` : ''}`, params: [org.id] }])
    .catch(() => db.run(O, [{ sql: `DELETE FROM ${w.table} WHERE org_id = $1::uuid${w.where ? ` AND ${w.where}` : ''}`, params: [org.id] }]).catch((e: Error) => console.warn(`  (${w.table}: ${e.message.split('\n')[0]})`)));   // a few tables are owner-only
  // member sessions, app tokens and join codes (platform side) – admin sessions stay
  await db.run(O, [
    { sql: `DELETE FROM platform.app_refresh_tokens WHERE org_id = $1::uuid`, params: [org.id] },
    { sql: `DELETE FROM platform.sessions WHERE org_id = $1::uuid AND kind = 'member'`, params: [org.id] },
    { sql: `DELETE FROM platform.login_codes WHERE org_id = $1::uuid AND purpose IN ('join', 'verify-email', 'join-resume')`, params: [org.id] },
  ]).catch((e: Error) => console.warn(`  (platform: ${e.message.split('\n')[0]})`));
  const left = await one<{ n: number }>(db, A, 'SELECT count(*)::int AS n FROM app.members WHERE org_id = $1::uuid', [org.id]);
  console.log(`Wiped. Members left: ${left?.n ?? 0}. Admins still here: ${(await one<{ n: number }>(db, A, 'SELECT count(*)::int AS n FROM app.admins WHERE org_id = $1::uuid', [org.id]))?.n}.`);
  await db.close();

  const step = (name: string, script: string, extra: string[]) => {
    console.log(`\n== ${name}`);
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--import', './src/load-env.ts', script, file, '--org', orgSlug, ...extra], { stdio: 'inherit', env: process.env });
    if (r.status !== 0) throw new Error(`${name} failed (see above).`);
  };
  step('Import', 'src/db/import-wildapricot.ts', ['--keep-structure', '--keep-demo', ...(args.includes('--plan-preset') ? ['--plan-preset', String(args[args.indexOf('--plan-preset') + 1])] : [])]);
  step('Column legend', 'src/db/wa-legend.ts', []);
  console.log('\nRebuild done. Numbers: npm run report:members');
}
main().catch((e) => { console.error(`Rebuild stopped: ${String(e?.message ?? e)}`); process.exit(1); });
