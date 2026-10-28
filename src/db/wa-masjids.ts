/**
 * Masjid check: does every member sit at the masjid they chose in Wild Apricot ("Zone / Center")?
 *
 *   npm run wa:masjids -- imports/wa-contacts-2026-10-17.xml            report only – changes nothing
 *   npm run wa:masjids -- imports/wa-contacts-2026-10-17.xml --fix      put every member back at their chosen masjid and lock it
 *
 * Why it is needed (found 2026-10-28): the import only locked the chosen masjid when it differed from the masjid that owns the
 * member's ZIP code. Everybody else was left "placed by ZIP", so the database trigger (app.place_member) and every publish of
 * Masjids and zones (projections.ts: center_id = NULL for all members not placed by hand) re-placed them by ZIP code.
 * Zone totals stay right (a ZIP sits in one zone) but masjid totals drift. --fix writes center_override
 * { reason: "Masjid chosen in Wild Apricot" } on every member that has a masjid in the export, so the ZIP map can never move them again.
 * Counts only – no names, emails or phone numbers are printed.
 */
import { readFileSync } from 'node:fs';
import { ensureExport } from './wa-file.js';
import { openDb, one, rows } from './sql.js';
import { readExcelXml, readPlace } from './import-wildapricot.js';

const args = process.argv.slice(2); const flag = (f: string) => args.includes(f);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--org');
const orgSlug = args.includes('--org') ? String(args[args.indexOf('--org') + 1]) : 'isgh';
const chunk = <T,>(l: T[], n = 1000) => Array.from({ length: Math.ceil(l.length / n) }, (_, i) => l.slice(i * n, i * n + n));

async function main() {
  if (!file) throw new Error('Give the Wild Apricot export file, e.g. imports/wa-contacts-2026-10-17.xml');
  const db = openDb(); const fix = flag('--fix');
  const org = await one<{ id: string }>(db, { org: null, role: 'owner' }, 'SELECT id FROM platform.organizations WHERE slug = $1', [orgSlug]); if (!org) throw new Error(`No organization "${orgSlug}".`);
  const A = { org: org.id, role: 'app_api' as const };

  // 1. the sheet: User ID → chosen masjid
  const [head, ...body] = readExcelXml(readFileSync(ensureExport(file), 'utf8'));
  const col = (n: string) => head.findIndex((h) => h.trim().toLowerCase() === n.toLowerCase());
  const cId = col('User ID'), cPlace = col('Zone / Center'), cEn = col('Membership enabled');
  if (cId < 0 || cPlace < 0) throw new Error('The file has no "User ID" or "Zone / Center" column.');
  const chosen = new Map<string, { center: string; enabled: boolean }>();
  let blank = 0;
  for (const r of body) { const id = (r[cId] ?? '').trim(); if (!id) continue; const p = readPlace(r[cPlace] ?? ''); if (!p) { blank++; continue; } chosen.set(id, { center: p.center, enabled: !/^no$/i.test((r[cEn] ?? '').trim()) }); }

  // 2. the system
  const centers = (await rows(db, A, 'SELECT id::text, name, active FROM app.centers')) as { id: string; name: string; active: boolean }[];
  const activeByName = new Map(centers.filter((c) => c.active).map((c) => [c.name, c.id]));
  const nameOf = new Map(centers.map((c) => [c.id, c.name + (c.active ? '' : ' (switched off)')]));
  const members = (await rows(db, A, `SELECT id, external_ids->>'wildapricot' AS ext, center_id::text AS center_id, center_override IS NOT NULL AS locked, archived IS NOT NULL AS archived FROM app.members`)) as
    { id: string; ext: string | null; center_id: string | null; locked: boolean; archived: boolean }[];
  const byExt = new Map(members.filter((m) => m.ext).map((m) => [m.ext!, m]));

  // 3. compare, masjid by masjid
  type Line = { sheet: number; sheetMembers: number; inSystem: number; right: number; elsewhere: number; noMasjid: number; notImported: number; systemNow: number; systemNowMembers: number; unlocked: number };
  const blankLine = (): Line => ({ sheet: 0, sheetMembers: 0, inSystem: 0, right: 0, elsewhere: 0, noMasjid: 0, notImported: 0, systemNow: 0, systemNowMembers: 0, unlocked: 0 });
  const t = new Map<string, Line>(); const line = (n: string) => { let l = t.get(n); if (!l) t.set(n, (l = blankLine())); return l; };
  const wentTo = new Map<string, Map<string, number>>();
  const repairs: { id: string; center_id: string; from: string }[] = [];
  const missingMasjid = new Map<string, number>();
  for (const [ext, c] of chosen) {
    const l = line(c.center); l.sheet++; if (c.enabled) l.sheetMembers++;
    const m = byExt.get(ext); if (!m) { l.notImported++; continue; }
    l.inSystem++;
    const want = activeByName.get(c.center);
    if (!want) { missingMasjid.set(c.center, (missingMasjid.get(c.center) ?? 0) + 1); continue; }
    if (m.center_id === want) l.right++;
    else if (!m.center_id) l.noMasjid++;
    else { l.elsewhere++; const w = wentTo.get(c.center) ?? new Map(); const to = nameOf.get(m.center_id) ?? '?'; w.set(to, (w.get(to) ?? 0) + 1); wentTo.set(c.center, w); }
    if (!m.locked) l.unlocked++;
    if (m.center_id !== want || !m.locked) repairs.push({ id: m.id, center_id: want, from: m.center_id ? nameOf.get(m.center_id) ?? '' : '' });
  }
  for (const m of members) { if (!m.center_id) continue; const n = nameOf.get(m.center_id)!.replace(/ \(switched off\)$/, ''); const l = line(n); l.systemNow++; if (!m.archived) l.systemNowMembers++; }

  const list = [...t.entries()].sort((a, b) => b[1].sheet - a[1].sheet);
  console.log(`\nMasjid check – sheet ${file} vs the database (organization ${orgSlug})`);
  console.log(`Sheet: ${chosen.size + blank} contacts with a User ID – ${chosen.size} name a masjid, ${blank} have "Zone / Center" blank (placed by ZIP, not counted below).\n`);
  console.table(list.map(([name, l]) => ({ masjid: name, 'sheet (all)': l.sheet, 'sheet (members)': l.sheetMembers, 'system now (all)': l.systemNow, 'system now (not archived)': l.systemNowMembers,
    'at right masjid': l.right, 'moved to another masjid': l.elsewhere, 'no masjid': l.noMasjid, 'not imported': l.notImported, 'not locked': l.unlocked })));
  for (const [from, w] of wentTo) console.log(`  ${from} → ${[...w.entries()].sort((a, b) => b[1] - a[1]).map(([to, n]) => `${to} ${n}`).join(', ')}`);
  if (missingMasjid.size) console.log(`\n!! Masjids in the sheet with no active masjid of the same name in Masjids and zones (fix the name there first): ${[...missingMasjid].map(([n, k]) => `${n} (${k})`).join(', ')}`);
  const totals = list.reduce((s, [, l]) => ({ right: s.right + l.right, elsewhere: s.elsewhere + l.elsewhere, none: s.none + l.noMasjid }), { right: 0, elsewhere: 0, none: 0 });
  console.log(`\nTotal: ${totals.right} at the right masjid · ${totals.elsewhere} at another masjid · ${totals.none} with no masjid · ${repairs.length} records to repair or lock.`);

  if (!fix) { console.log('\nReport only – nothing changed. Add --fix to put members back at their chosen masjid and lock it.'); await db.close(); return; }
  const at = new Date().toISOString(); let n = 0;
  for (const part of chunk(repairs)) {
    await db.run(A, [{ sql: `UPDATE app.members m SET center_id = x.center_id::uuid,
        center_override = jsonb_build_object('reason', 'Masjid chosen in Wild Apricot', 'by', 'Import', 'at', $2::text, 'from', x."from")
      FROM jsonb_to_recordset($1::jsonb) AS x(id text, center_id text, "from" text) WHERE m.id = x.id`, params: [JSON.stringify(part), at] }]);
    n += part.length; process.stdout.write(`\r  repaired ${n} of ${repairs.length}`);
  }
  console.log(`\nFixed: ${n} members are back at (and locked to) the masjid they chose in Wild Apricot. Restart the API (pm2 restart membership-api) so the admin's member cache reloads, then run this again without --fix – every masjid should show 0 moved / 0 no masjid.`);
  await db.close();
}
main().catch((e) => { console.error(`Masjid check stopped: ${String(e?.message ?? e).split('\n').slice(0, 6).join('\n')}`); process.exit(1); });
