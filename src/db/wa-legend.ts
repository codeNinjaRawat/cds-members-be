/**
 * Wild Apricot column legend (owner, 2026-10-23) applied to the imported people – re-runnable, nothing deleted.
 *
 *   npm run wa:legend -- "C:\path\Contacts.xml" [--org isgh] [--dry-run]
 *
 *  Membership enabled = no   → NOT a member (never had a membership on file; "Suspended" and blank rows).
 *                              Their member record is archived (restorable) and they stay in People as a contact.
 *  Membership status         → Active = member · Lapsed = expired member · Pending - New = incomplete (not approved,
 *                              in the Incomplete queue) · Pending - Level change / Renewal = member with a change pending.
 *  TX DL/ID number present   → the ID check is done (the number itself is never imported).
 *  Group participation       → real groups (Admin › Groups): "Voting Members 2026", "NON VOTING MEMBERS 2026",
 *                              "Online Voting Eligible 2026", "Restricted Voting Members 2023", nominees, elected officials,
 *                              check pending, missing information, Checkomatic Family / Individual. Masjid-named groups
 *                              (Champions, HWY3 …) are skipped – Zone / Center already places the person.
 *                              Only this year's and last year's lists become groups; every year is kept on the record as
 *                              `voting: { "2026": "voting" | "non-voting" | "restricted", "online2026": "yes", … }` for the profile.
 *  Zone / Center             → already applied by the import (zone prefix + masjid name).
 */
import { readFileSync } from 'node:fs';
import { openDb, one, rows } from './sql.js';
import { readExcelXml } from './import-wildapricot.js';
import { saveDocument } from '../modules/projections.js';
import { touchPerson } from '../modules/contacts.js';
import { GroupsSchema, type Group, type GroupsDoc } from '@/lib/community/groups';

const args = process.argv.slice(2); const flag = (f: string) => args.includes(f);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--org');
const orgSlug = args.includes('--org') ? String(args[args.indexOf('--org') + 1]) : 'isgh';
const THIS_YEAR = new Date().getFullYear();
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Which Wild Apricot groups become our groups (and how the voting ones mark the record). */
const SKIP = /^(champions|hwy3|bear creek|maryam|brandlane|synott|katy|mission bend|pearland|riveroaks|woodlands|adel|cypress|spring|ayesha|baytown)$/i;
const voting = (g: string): { year: string; status: 'voting' | 'non-voting' | 'restricted' | 'online' } | null => {
  let m;
  if ((m = /^voting members (\d{4})$/i.exec(g))) return { year: m[1], status: 'voting' };
  if ((m = /^non voting members (\d{4})$/i.exec(g))) return { year: m[1], status: 'non-voting' };
  if ((m = /^restricted voting members (\d{4})$/i.exec(g))) return { year: m[1], status: 'restricted' };
  if ((m = /^online voting eligible (\d{4})$/i.exec(g))) return { year: m[1], status: 'online' };
  return null;
};

async function main() {
  if (!file) throw new Error('Give the Wild Apricot export file.');
  const db = openDb(); const dry = flag('--dry-run');
  const org = await one<{ id: string }>(db, { org: null, role: 'owner' }, 'SELECT id FROM platform.organizations WHERE slug = $1', [orgSlug]); if (!org) throw new Error(`No organization "${orgSlug}".`);
  const A = { org: org.id, role: 'app_api' as const };
  const table = readExcelXml(readFileSync(file, 'utf8')); const [head, ...body] = table;
  const col = (n: string) => head.findIndex((h) => h.trim().toLowerCase() === n.toLowerCase()); const get = (r: string[], n: string) => { const i = col(n); return i < 0 ? '' : (r[i] ?? '').trim(); };
  for (const n of ['User ID', 'Membership enabled', 'Membership status', 'TX DL/ID Number', 'Group participation']) if (col(n) < 0) throw new Error(`Column "${n}" is missing.`);
  const members = (await rows(db, A, `SELECT id, external_ids->>'wildapricot' AS ext, first_name, last_name, email::text AS email, phone, center_id::text AS center_id, archived IS NOT NULL AS archived, approved_on IS NOT NULL AS approved, id_check, coalesce(record->>'joinStage', '') AS stage FROM app.members WHERE external_ids ? 'wildapricot'`)) as
    { id: string; ext: string; first_name: string; last_name: string; email: string; phone: string; center_id: string | null; archived: boolean; approved: boolean; id_check: string; stage: string }[];
  const byExt = new Map(members.map((m) => [m.ext, m]));
  const notMembers: string[] = [], contacts: typeof members = [], incomplete: string[] = [], idOnFile: string[] = [];
  const groupMembers = new Map<string, { name: string; ids: string[] }>(); const votingOf = new Map<string, Record<string, string>>();
  let unknown = 0;
  for (const r of body) {
    const ext = get(r, 'User ID'); const m = byExt.get(ext); if (!ext) continue; if (!m) { unknown++; continue; }
    const enabled = get(r, 'Membership enabled').toLowerCase(); const status = get(r, 'Membership status');
    if (enabled === 'no') { if (!m.archived) notMembers.push(m.id); contacts.push(m); }
    else if (/^pending - new$/i.test(status) && m.stage !== 'incomplete') incomplete.push(m.id);
    if (get(r, 'TX DL/ID Number') && m.id_check !== 'verified') idOnFile.push(m.id);
    if (enabled !== 'no') for (const g of get(r, 'Group participation').split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean)) {
      if (SKIP.test(g)) continue;
      const v = voting(g); if (v) { const cur = votingOf.get(m.id) ?? {}; cur[v.status === 'online' ? `online${v.year}` : v.year] = v.status === 'online' ? 'yes' : v.status; votingOf.set(m.id, cur); }
      // real groups: this year's and last year's lists (older years stay on the record as history – they would only bloat the groups document)
      const yr = /(\d{4})/.exec(g)?.[1]; if (yr && Number(yr) < THIS_YEAR - 1) continue;
      const id = `${slug(g)}-wa`; const e = groupMembers.get(id) ?? { name: `${g} (Wild Apricot)`, ids: [] }; e.ids.push(m.id); groupMembers.set(id, e);   // kept apart from our own rule-based groups
    }
  }
  console.log(`${body.length} rows in the file · ${members.length} imported people matched · ${unknown} rows not imported (skipped by the import)`);
  console.log(`Not members (Membership enabled = no): ${contacts.length} – ${notMembers.length} member records to archive · Pending - New → incomplete: ${incomplete.length} · ID number on file → ID check done: ${idOnFile.length}`);
  console.log(`Groups: ${[...groupMembers.values()].map((g) => `${g.name} (${g.ids.length})`).join(' · ')}`);
  if (dry) { console.log('Dry run – nothing changed.'); await db.close(); return; }

  const batches = <T,>(a: T[], n = 500) => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
  // 1. not members → archived (restorable) + a contact row
  for (const part of batches(notMembers)) await db.run(A, [{ sql: `UPDATE app.members SET archived = jsonb_build_object('on', current_date::text, 'by', 'Import', 'reason', 'Wild Apricot: Membership enabled = no – never a member (' || coalesce(record->'wildapricot'->>'status', 'no status') || ')') WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb))) AND archived IS NULL`, params: [JSON.stringify(part)] }]);
  for (const m of contacts) await touchPerson({ db, orgId: org.id }, { firstName: m.first_name, lastName: m.last_name, email: m.email, phone: m.phone, source: 'import', centerId: m.center_id });
  // 2. Pending - New → incomplete, not approved, imported terms set aside
  for (const part of batches(incomplete)) await db.run(A, [
    { sql: `UPDATE app.members SET record = record || '{"joinStage":"incomplete"}'::jsonb, approved_on = NULL WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`, params: [JSON.stringify(part)] },
    { sql: `UPDATE app.memberships SET status = 'cancelled' WHERE member_id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb))) AND how = 'imported' AND status = 'active'`, params: [JSON.stringify(part)] }]);
  // 3. ID number on file → ID check done (no number kept)
  for (const part of batches(idOnFile)) await db.run(A, [
    { sql: `UPDATE app.members SET id_check = 'verified', record = record || '{"idNumberOnFile":true}'::jsonb WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`, params: [JSON.stringify(part)] },
    { sql: `INSERT INTO app.id_checks (org_id, member_id, doc_type, status, reason, checked_by, checked_at, purge_after) SELECT $1::uuid, x, 'other', 'verified', 'ID number on file in Wild Apricot (TX DL/ID)', 'Import', now(), current_date + 30 FROM jsonb_array_elements_text($2::jsonb) AS x ON CONFLICT DO NOTHING`, params: [org.id, JSON.stringify(part)] }]);
  // 4. voting marks on the record
  const vEntries = [...votingOf.entries()].map(([id, v]) => ({ id, v }));
  for (const part of batches(vEntries)) await db.run(A, [{ sql: `UPDATE app.members m SET record = record || jsonb_build_object('voting', x.v) FROM jsonb_to_recordset($1::jsonb) AS x(id text, v jsonb) WHERE m.id = x.id`, params: [JSON.stringify(part)] }]);
  // 5. groups document: import-managed groups get their members replaced; everything else is left alone
  const curDoc = await one<{ data: unknown }>(db, A, `SELECT data FROM app.documents WHERE key = 'groups'`);
  const parsed = GroupsSchema.safeParse(curDoc?.data ?? { enabled: true, groups: [] }); const doc: GroupsDoc = parsed.success ? parsed.data : { enabled: true, groups: [] };
  for (const [id, g] of groupMembers) {
    const ids = Array.from(new Set(g.ids)).slice(0, Number(process.env.WA_LEGEND_MAX_IDS ?? 20_000));   // WA_LEGEND_MAX_IDS: test runs on the psql adapter (its arguments cannot carry a large document)
    const i = doc.groups.findIndex((x) => x.id === id);
    const base: Group = i >= 0 ? doc.groups[i] : { id, name: g.name, description: 'From Wild Apricot (Group participation).', kind: 'manual', rules: [], match: 'all', include: [], exclude: [], memberIds: [], joinPolicy: 'admins', showInProfile: false, leaders: [], leadersCanEmail: false, pageAccess: false, archived: false } as Group;
    const next = { ...base, kind: 'manual' as const, memberIds: ids };
    if (i >= 0) doc.groups[i] = next; else doc.groups.push(next);
  }
  await saveDocument(db, org.id, 'groups', GroupsSchema.parse(doc), 'Import', 'Wild Apricot group participation');
  await db.run(A, [{ sql: 'SELECT app.refresh_status($1::uuid)', params: [org.id] }]);
  const sum = (await rows(db, A, `SELECT status, count(*)::int AS n FROM app.members GROUP BY status ORDER BY 2 DESC`)) as { status: string; n: number }[];
  console.log(`Done. Members now: ${sum.map((s) => `${s.n} ${s.status}`).join(' · ')}. Groups: ${groupMembers.size}.`);
  await db.close();
}
main().catch((e) => { console.error(`Legend pass stopped: ${String(e?.message ?? e)}`, process.env.IMPORT_DEBUG ? e : ""); process.exit(1); });
