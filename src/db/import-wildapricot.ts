/**
 * Real records for review: a Wild Apricot "Contacts" export (Excel XML, .xml – or the same columns as CSV) into one
 * organization. Re-runnable: a contact already imported (same Wild Apricot User ID) is skipped.
 *
 *   npm run import:wa -- "C:\path\Contacts.xml" [--org isgh] [--dry-run] [--keep-demo] [--keep-structure]
 *
 *  1. Masjids and zones: built from the export's "Zone / Center" column (NO- / NW- / SW- / SE- / SO- …). Each ZIP code
 *     goes to the masjid most of its members chose; people who chose another masjid keep their choice (a recorded
 *     exception). Published as the org-structure document (Admin › Masjids and zones shows it). --keep-structure skips it.
 *  2. The demo members (fictional, from the seed) are removed unless --keep-demo.
 *  3. Members: name, email, phone, birth date, gender, address, masjid, plan (from the membership level), status and
 *     renewal date (as a membership term), email / text choices, households (bundle coordinator + one member = spouses),
 *     notes (staff-only member notes). The Wild Apricot level, status, role and groups are kept on the record.
 *     Never imported: driver-license / ID numbers, pictures and file links, passwords, balances.
 */
import { readFileSync } from 'node:fs';
import { ensureExport } from './wa-file.js';
import { openDb, one, rows, type Db, type Statement } from './sql.js';
import { saveDocument } from '../modules/projections.js';
import { demoMembers } from '@/lib/members/members';
import { MembershipSettingsSchema, PLAN_PRESETS, ISGH_WILDAPRICOT_LEVELS, type Plan } from '@/lib/content/membership';

/* ---------------- reading the file ---------------- */
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** Excel 2003 XML (what Wild Apricot's "Export to Excel" gives) – rows of cells, with ss:Index for skipped cells. */
export function readExcelXml(text: string): string[][] {
  const out: string[][] = [];
  for (const row of text.matchAll(/<Row\b[^>]*?(?:\/>|>([\s\S]*?)<\/Row>)/g)) {
    const cells: string[] = [];
    for (const c of (row[1] ?? '').matchAll(/<Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Cell>)/g)) {
      const idx = /ss:Index="(\d+)"/.exec(c[1]); if (idx) while (cells.length < Number(idx[1]) - 1) cells.push('');
      const d = /<(?:ss:)?Data\b[^>]*>([\s\S]*?)<\/(?:ss:)?Data>/.exec(c[2] ?? '');
      cells.push(d ? decode(d[1].replace(/<[^>]+>/g, '')) : '');
    }
    out.push(cells);
  }
  return out;
}
function readCsv(text: string): string[][] {
  const out: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); out.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}

/* ---------------- what each column means here ---------------- */
type Contact = Record<string, string>;
const ZONES: Record<string, { id: string; name: string }> = { NO: { id: 'n', name: 'North' }, NW: { id: 'nw', name: 'Northwest' }, SW: { id: 'sw', name: 'Southwest' }, SE: { id: 'se', name: 'Southeast' }, SO: { id: 's', name: 'South' } };
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
/** "NO- Masjid Al-Salam - Champions" → zone NO, masjid "Masjid Al-Salam - Champions". */
export function readPlace(v: string): { zone: string; center: string } | null {
  const m = /^\s*([A-Z]{2})\s*-\s*(.+?)\s*$/.exec(v); if (!m || !ZONES[m[1]]) return null;
  return { zone: m[1], center: m[2].replace(/\s+/g, ' ') };
}
const day = (v: string) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim()); if (m) return m[1]; const u = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v.trim()); return u ? `${u[3]}-${u[1].padStart(2, '0')}-${u[2].padStart(2, '0')}` : ''; };
const realDay = (d: string, min = '1900-01-01', max = '2100-12-31') => (d && d >= min && d <= max && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) ? d : '');
const phone = (v: string) => { let d = v.replace(/\D/g, ''); if (d.length === 11 && d.startsWith('1')) d = d.slice(1); return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : ''; };
const yes = (v: string) => /^(yes|y|true|1)$/i.test(v.trim());
const STATES: Record<string, string> = { texas: 'TX', taxas: 'TX', tx: 'TX', california: 'CA', virginia: 'VA', 'new york': 'NY', louisiana: 'LA', oklahoma: 'OK', florida: 'FL', georgia: 'GA', illinois: 'IL' };
const state = (v: string) => { const t = v.trim().toLowerCase(); if (STATES[t]) return STATES[t]; return /^[a-z]{2}$/.test(t) ? t.toUpperCase() : ''; };
/** Wild Apricot level → plan id (the level's own name: individual, family, life-individual, life-family, checkomatic).
 *  The organization's published plans must contain them – ensurePlans() adds any that are missing (hidden). */
export function planOf(level: string): string {
  const l = level.toLowerCase();
  if (l.includes('lifetime')) return l.includes('family') || l.includes('spouse') ? 'life-family' : 'life-individual';
  if (l.includes('checkomatic')) return 'checkomatic';
  if (l.includes('family') || l.includes('spouse')) return 'family';
  return 'individual';
}
const PLAN_SQL_CASE = `CASE WHEN lower(record->'wildapricot'->>'level') LIKE '%lifetime%' THEN CASE WHEN lower(record->'wildapricot'->>'level') ~ 'family|spouse' THEN 'life-family' ELSE 'life-individual' END
  WHEN lower(record->'wildapricot'->>'level') LIKE '%checkomatic%' THEN 'checkomatic' WHEN lower(record->'wildapricot'->>'level') ~ 'family|spouse' THEN 'family' ELSE 'individual' END`;

/** The published Membership settings must hold every plan the members use. --plan-preset <id> first replaces the plans
 *  and rules with that preset (Membership rules › Plans › "Start from a preset"); plans still missing after that are
 *  added hidden from the Wild Apricot levels as "… (Wild Apricot)", so nobody can join them but existing members keep them. */
async function ensurePlans(db: Db, orgId: string, needed: string[], preset: string) {
  const A = API(orgId);
  const cur = await one<{ data: Record<string, unknown> }>(db, A, `SELECT data FROM app.documents WHERE key = 'membership-settings'`);
  if (!cur) throw new Error('No published Membership settings – run npm run seed first.');
  const doc = { ...cur.data } as { plans: Plan[]; rules: unknown };
  let changed = false;
  if (preset) {
    const p = PLAN_PRESETS.find((x) => x.id === preset);
    if (!p) throw new Error(`Unknown plan preset "${preset}" – one of: ${PLAN_PRESETS.map((x) => x.id).join(', ')}`);
    doc.plans = structuredClone(p.plans); doc.rules = structuredClone(p.rules); changed = true;
  }
  for (const id of needed) {
    if (doc.plans.some((x) => x.id === id)) continue;
    const src = ISGH_WILDAPRICOT_LEVELS.find((x) => x.id === id) ?? ISGH_WILDAPRICOT_LEVELS.find((x) => x.id === 'individual')!;
    doc.plans.push({ ...structuredClone(src), id, name: `${src.name} (Wild Apricot)`, visible: false, featured: false });
    changed = true;
  }
  if (!changed) return [];
  const parsed = MembershipSettingsSchema.parse(doc);
  await saveDocument(db, orgId, 'membership-settings', parsed, 'Import', preset ? `Plans from the "${preset}" preset (Wild Apricot import)` : 'Plans used by imported members');
  return parsed.plans.map((x) => `${x.name}${x.visible === false ? ' (hidden)' : ''}`);
}

/** Wild Apricot status → approved or not (the term decides active / expired; suspended / lapsed = not renewed). */
const UNVERIFIED = /unver/i;   // Wild Apricot's own level is spelled "Unverfied Members"
const approved = (status: string) => !/^pending - new$/i.test(status.trim()) && status.trim() !== '' && !UNVERIFIED.test(status);
/** People who never became members: 'applied' = applied and waiting (Pending - New); 'incomplete' = never finished –
 *  no membership at all, or never verified. Shown in the admin's Applications / Not finished queues. */
const joinStage = (level: string, status: string) => (!level.trim() && !status.trim()) || UNVERIFIED.test(level) || UNVERIFIED.test(status) ? 'incomplete' : /^pending - new$/i.test(status.trim()) ? 'applied' : '';

type Row = { externalId: string; first: string; middle: string; last: string; email: string; phone: string; dob: string; gender: string; street: string; city: string; state: string; zip: string;
  place: { zone: string; center: string } | null; plan: string; joined: string; approvedOn: string; termEnds: string | null; termStarts: string; lifetime: boolean; prefs: unknown; record: unknown; notes: string; bundle: string; coordinator: boolean; waStatus: string };
export function toRows(table: string[][], today: string): { rows: Row[]; skipped: { line: number; why: string }[] } {
  const [head, ...body] = table; const col = (n: string) => head.findIndex((h) => h.trim().toLowerCase() === n.toLowerCase());
  const need = ['User ID', 'First Name', 'Last Name']; const missing = need.filter((n) => col(n) < 0);
  if (missing.length) throw new Error(`This does not look like a Wild Apricot contacts export – missing ${missing.join(', ')}.`);
  const get = (r: string[], n: string) => { const i = col(n); return i < 0 ? '' : (r[i] ?? '').trim(); };
  const out: Row[] = []; const skipped: { line: number; why: string }[] = [];
  body.forEach((r, k) => {
    const c: Contact = {}; head.forEach((h, i) => { c[h.trim()] = (r[i] ?? '').trim(); });
    const externalId = get(r, 'User ID'); const first = get(r, 'First Name'); const last = get(r, 'Last Name');
    if (!externalId) { if (r.some((x) => x.trim())) skipped.push({ line: k + 2, why: 'no User ID' }); return; }
    if (!first || !last) { skipped.push({ line: k + 2, why: 'no first or last name' }); return; }
    const level = get(r, 'Membership level'); const status = get(r, 'Membership status');
    const since = realDay(day(get(r, 'Member since')) || day(get(r, 'Created on')), '1950-01-01', today) || today;
    const due = realDay(day(get(r, 'Renewal due')), '1990-01-01');
    const plan = planOf(level); const lifetime = plan.startsWith('life');
    const ok = approved(status) && !UNVERIFIED.test(level); const stage = joinStage(level, status);
    const email = get(r, 'Email Address').toLowerCase();
    const zip5 = (/^(\d{5})/.exec(get(r, 'ZIP')) ?? [])[1] ?? '';
    const optOut = [!yes(get(r, 'Event announcements')) ? 'events' : '', !yes(get(r, 'Member emails and newsletters')) ? 'newsletter' : ''].filter(Boolean);
    out.push({
      externalId, first: first.slice(0, 60), middle: get(r, 'Middle Name').slice(0, 60), last: last.slice(0, 60),
      email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email.slice(0, 254) : '',
      phone: phone(get(r, 'Phone')) || phone(get(r, 'Cell Phone')),
      dob: realDay(day(get(r, 'Date of Birth')), '1900-01-01', today),
      gender: /^m/i.test(get(r, 'Gender')) ? 'male' : /^f/i.test(get(r, 'Gender')) ? 'female' : '',
      street: [get(r, 'Street Address'), get(r, 'Apartment/Condo/Unit #')].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 160), city: get(r, 'City').slice(0, 60), state: state(get(r, 'State')), zip: zip5,
      place: readPlace(get(r, 'Zone / Center')), plan, joined: since,
      approvedOn: ok ? since : '', lifetime, termStarts: ok ? (due ? (lifetime ? since : `${Number(due.slice(0, 4)) - 1}${due.slice(4)}`) : since) : '', termEnds: ok && !lifetime ? (due || (/^active$/i.test(status) ? `${today.slice(0, 4)}-12-31` : null)) : null,   // Active with no renewal date (Checkomatic payroll members): paid through this membership year
      prefs: { email: yes(get(r, 'Subscribed to emails')), sms: yes(get(r, 'Text/SMS Consent')), optOut, directoryListed: false },
      record: { ...(stage ? { joinStage: stage } : {}), wildapricot: { userId: externalId, level, status, role: get(r, 'Role'), memberRole: get(r, 'Member role'), renewalType: get(r, 'Member renewal type'), groups: get(r, 'Group participation'), memberIdentifier: get(r, 'Member Identifier'), organization: get(r, 'Company/Corporation/Organization'), enabled: get(r, 'Membership enabled'), totalDonated: get(r, 'Total donated'), createdOn: day(get(r, 'Created on')), lastLogin: day(get(r, 'Last login')) },
        audit: [{ at: new Date().toISOString(), by: 'Import', action: 'Imported from Wild Apricot', detail: `${level || 'no level'} · ${status || 'no status'}` }] },
      notes: [get(r, 'Notes'), get(r, 'Follow up') ? `Follow up: ${get(r, 'Follow up')}` : ''].filter(Boolean).join('\n').slice(0, 3900),
      bundle: get(r, 'Member bundle ID or email').toLowerCase(), coordinator: /coordinator/i.test(get(r, 'Member role')), waStatus: status,
    });
  });
  return { rows: out, skipped };
}

/* ---------------- masjids and zones from the people ---------------- */
export function structureFrom(rows: Row[]) {
  const centers = new Map<string, { id: string; name: string; zone: string; people: number }>();
  const byZip = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.place) continue;
    const key = r.place.center; const zone = ZONES[r.place.zone].id;
    const c = centers.get(key) ?? { id: slug(key.replace(/^masjid\s+/i, '')) || slug(key), name: key, zone, people: 0 }; c.people++; centers.set(key, c);
    if (r.zip) { const m = byZip.get(r.zip) ?? new Map(); m.set(key, (m.get(key) ?? 0) + 1); byZip.set(r.zip, m); }
  }
  const zipOwner = new Map<string, string>();   // ZIP → the masjid most of its people chose
  for (const [zip, m] of byZip) zipOwner.set(zip, [...m.entries()].sort((a, b) => b[1] - a[1] || (centers.get(b[0])!.people - centers.get(a[0])!.people))[0][0]);
  const zipsOf = (name: string) => [...zipOwner.entries()].filter(([, c]) => c === name).map(([z]) => z).sort((a, b) => (byZip.get(b)!.get(name)! - byZip.get(a)!.get(name)!)).slice(0, 200).sort();
  const list = [...centers.values()].sort((a, b) => a.zone.localeCompare(b.zone) || b.people - a.people);
  const used = new Set<string>(); for (const c of list) { let id = c.id; let n = 2; while (used.has(id)) id = `${c.id}-${n++}`; c.id = id; used.add(id); }
  const doc = {
    zones: Object.values(ZONES).filter((z) => list.some((c) => c.zone === z.id)).map((z) => ({ id: z.id, name: z.name, areas: '', director: { name: '', email: '' }, termEnds: '', zips: [...new Set(list.filter((c) => c.zone === z.id).flatMap((c) => zipsOf(c.name)))].slice(0, 400).sort(), active: true })),
    centers: list.map((c) => ({ id: c.id, name: c.name, aka: '', zone: c.zone, address: { street: '', city: '', zip: '' }, phone: '', website: '', jumuah: [], services: [], zips: zipsOf(c.name), active: true })),
  };
  // a ZIP belongs to one zone: keep it in the zone of its masjid only
  const seen = new Set<string>(); for (const z of doc.zones) z.zips = z.zips.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
  return { doc, zipOwner, centers: list };
}

/* ---------------- the import ---------------- */
const API = (org: string) => ({ org, role: 'app_api' as const });
/** Split rows into batches whose JSON stays under a size (the psql test adapter passes it on the command line). */
function batches<T>(list: T[], max = process.env.DB_ADAPTER === 'psql' ? 100_000 : 2_000_000, most = 1000): T[][] {
  const out: T[][] = []; let cur: T[] = []; let size = 0;
  for (const x of list) { const n = JSON.stringify(x).length + 1; if (cur.length && (size + n > max || cur.length >= most)) { out.push(cur); cur = []; size = 0; } cur.push(x); size += n; }
  if (cur.length) out.push(cur); return out;
}

async function main() {
  const args = process.argv.slice(2); const file = args.find((a) => !a.startsWith('--'));
  const flag = (f: string) => args.includes(f); const orgSlug = (args[args.indexOf('--org') + 1] && args.includes('--org')) ? args[args.indexOf('--org') + 1] : (process.env.DEFAULT_ORG ?? 'isgh');
  if (!file) { console.log('Usage: npm run import:wa -- "path/to/Contacts.xml" [--org isgh] [--dry-run] [--keep-demo] [--keep-structure] [--plan-preset isgh-2026]'); process.exit(1); }
  const text = readFileSync(ensureExport(file), 'utf8').replace(/^\uFEFF/, '');
  const table = text.trimStart().startsWith('<') ? readExcelXml(text) : readCsv(text);
  const today = new Date().toISOString().slice(0, 10);
  const { rows: list, skipped } = toRows(table, today);
  const st = structureFrom(list);
  console.log(`Read ${table.length - 1} contacts: ${list.length} to import, ${skipped.length} skipped (no ID or name). ${st.centers.length} masjids in ${st.doc.zones.length} zones, ${st.zipOwner.size} ZIP codes.`);
  if (flag('--dry-run')) { for (const c of st.centers) console.log(`  ${c.zone.padEnd(2)}  ${c.name}  ${c.people} people`); console.log('Dry run – nothing was saved.'); return; }

  const db: Db = openDb();
  const org = await one<{ id: string; member_prefix: string }>(db, { org: null, role: 'owner' }, 'SELECT id::text, member_prefix FROM platform.organizations WHERE slug = $1', [orgSlug]);
  if (!org) throw new Error(`No organization "${orgSlug}" – run npm run seed first.`);
  const A = API(org.id);

  if (!flag('--keep-demo')) {
    const ids = demoMembers().map((m) => m.id);
    const r = await rows(db, A, `DELETE FROM app.members WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb))) AND coalesce(external_ids->>'wildapricot', '') = '' RETURNING id`, [JSON.stringify(ids)]);
    console.log(`Removed ${r.length} demo members.`);
  }
  if (!flag('--keep-structure')) {
    await saveDocument(db, org.id, 'org-structure', st.doc, 'Import', 'Masjids and zones from the Wild Apricot export');
    console.log(`Published masjids and zones (${st.centers.length} masjids).`);
  }
  const presetArg = args.includes('--plan-preset') ? String(args[args.indexOf('--plan-preset') + 1] ?? '') : '';
  const used = await rows(db, A, `SELECT DISTINCT ${PLAN_SQL_CASE} AS id FROM app.members WHERE external_ids ? 'wildapricot'`) as { id: string }[];
  const plans = await ensurePlans(db, org.id, [...new Set([...list.map((r) => r.plan), ...used.map((u) => u.id)])], presetArg);
  if (plans.length) console.log(`Published plans: ${plans.join(' · ')}.`);
  const centerIds = new Map(((await rows(db, A, 'SELECT id::text, name FROM app.centers WHERE active')) as { id: string; name: string }[]).map((c) => [c.name, c.id]));
  const done = new Set(((await rows(db, A, `SELECT external_ids->>'wildapricot' AS x FROM app.members WHERE external_ids ? 'wildapricot'`)) as { x: string }[]).map((r) => r.x));
  const todo = list.filter((r) => !done.has(r.externalId));
  console.log(`${done.size} already imported earlier – importing ${todo.length}.`);

  // member ids: the organization's own prefix and the next free numbers
  const firstId = (await one<{ id: string }>(db, A, 'SELECT app.next_member_id($1::uuid, $2) AS id', [org.id, org.member_prefix || orgSlug.slice(0, 3).toUpperCase()]))!.id;
  const prefix = firstId.split('-')[0]; let next = Number(firstId.split('-')[1]);
  const idOf = new Map<string, string>();
  for (const r of todo) idOf.set(r.externalId, `${prefix}-${String(next++).padStart(6, '0')}`);

  let n = 0;
  const memberRows = todo.map((r) => {
      const centerId = r.place ? centerIds.get(r.place.center) ?? '' : '';
      const zipCenter = r.zip ? st.zipOwner.get(r.zip) : undefined;
      // the masjid chosen in Wild Apricot is always locked – left "placed by ZIP", the trigger and every publish of Masjids and zones would move the member by ZIP code (masjid counts drifted, 2026-10-28)
      const override = centerId && r.place ? { reason: 'Masjid chosen in Wild Apricot', by: 'Import', at: new Date().toISOString(), from: zipCenter ?? '' } : null;
      return { id: idOf.get(r.externalId), first: r.first, middle: r.middle, last: r.last, email: r.email, phone: r.phone, dob: r.dob || null, gender: r.gender, street: r.street, city: r.city, state: r.state, zip: r.zip,
        center_id: centerId || null, override, plan: r.plan, joined: Number(r.joined.slice(0, 4)), applied: r.joined, approved: r.approvedOn || null, prefs: r.prefs, record: r.record, ext: { wildapricot: r.externalId } };
  });
  for (const part of batches(memberRows, undefined, 400)) {
    const st1: Statement[] = [{ sql: `INSERT INTO app.members (org_id, id, first_name, middle_name, last_name, email, phone, dob, gender, street, city, state, zip, center_id, center_override, plan, joined_year, applied_on, approved_on, source, prefs, record, external_ids)
        SELECT $1::uuid, x.id, x.first, x.middle, x.last, x.email, x.phone, x.dob, x.gender, x.street, x.city, x.state, x.zip, x.center_id, x.override, x.plan, x.joined, x.applied, x.approved, 'import', x.prefs, x.record, x.ext
        FROM jsonb_to_recordset($2::jsonb) AS x(id text, first text, middle text, last text, email text, phone text, dob date, gender text, street text, city text, state text, zip text, center_id uuid, override jsonb, plan text, joined int, applied date, approved date, prefs jsonb, record jsonb, ext jsonb)
        ON CONFLICT DO NOTHING`, params: [org.id, JSON.stringify(part)] }];
    await db.run(A, st1);
    n += part.length; process.stdout.write(`\r  members ${n} of ${todo.length}`);
  }
  console.log('');

  // membership terms (what active / expired and the voting checks read) and staff notes
  // Suspended / Lapsed in Wild Apricot: the term is kept as history but does not count (the member shows as expired)
  const stopped = (r: (typeof todo)[number]) => /^(suspended|lapsed)$/i.test(r.waStatus.trim());
  const terms = todo.filter((r) => r.approvedOn).map((r) => ({ m: idOf.get(r.externalId), plan: r.plan, s: r.termStarts || r.joined, e: r.lifetime ? null : r.termEnds, st: stopped(r) ? 'cancelled' : 'active' }));
  let t = 0;
  for (const part of batches(terms)) {
    await db.run(A, [{ sql: `INSERT INTO app.memberships (org_id, member_id, plan_id, starts_on, ends_on, status, how, created_by)
        SELECT $1::uuid, t.m, t.plan, least(t.s, coalesce(t.e, t.s)), t.e, t.st, 'imported', 'Wild Apricot import' FROM jsonb_to_recordset($2::jsonb) AS t(m text, plan text, s date, e date, st text)
        WHERE t.e IS NOT NULL OR t.plan LIKE 'life%'`, params: [org.id, JSON.stringify(part)] }]);
    t += part.length; process.stdout.write(`\r  membership terms ${t} of ${terms.length}`);
  }
  console.log('');
  const notes = todo.filter((r) => r.notes).map((r) => ({ m: idOf.get(r.externalId), t: r.notes }));
  for (const part of batches(notes)) await db.run(A, [{ sql: `INSERT INTO app.member_notes (org_id, member_id, by, text) SELECT $1::uuid, t.m, 'Wild Apricot', t.t FROM jsonb_to_recordset($2::jsonb) AS t(m text, t text)`, params: [org.id, JSON.stringify(part)] }]);

  // households: a bundle coordinator and exactly one bundle member are spouses
  const all = ((await rows(db, A, `SELECT id, lower(email) AS email, external_ids->>'wildapricot' AS ext FROM app.members WHERE external_ids ? 'wildapricot'`)) as { id: string; email: string; ext: string }[]);
  const byExt = new Map(all.map((m) => [m.ext, m.id])); const coordByEmail = new Map<string, string>();
  for (const r of list) if (r.coordinator) { if (r.bundle) coordByEmail.set(r.bundle, r.externalId); if (r.email) coordByEmail.set(r.email, r.externalId); }
  const groups = new Map<string, string[]>();
  for (const r of list) {
    const head = r.coordinator ? r.externalId : r.bundle ? (byExt.has(r.bundle) ? r.bundle : coordByEmail.get(r.bundle)) : undefined;
    if (head) { const g = groups.get(head) ?? []; g.push(r.externalId); groups.set(head, g); }
  }
  const pairs = [...groups.values()].filter((g) => g.length === 2).map(([a, b]) => ({ a: byExt.get(a), b: byExt.get(b) })).filter((p) => p.a && p.b);
  for (const part of batches(pairs)) await db.run(A, [{ sql: `UPDATE app.members m SET spouse_id = CASE WHEN m.id = p.a THEN p.b ELSE p.a END FROM jsonb_to_recordset($1::jsonb) AS p(a text, b text) WHERE m.id IN (p.a, p.b) AND m.spouse_id IS NULL`, params: [JSON.stringify(part)] }]);

  // repair (safe to repeat): people who never became members are never approved and their imported terms do not count
  const fix = await db.run(A, [
    { sql: `UPDATE app.members SET record = record || jsonb_build_object('joinStage', CASE WHEN (coalesce(record->'wildapricot'->>'level', '') = '' AND coalesce(record->'wildapricot'->>'status', '') = '') OR record->'wildapricot'->>'level' ~* 'unver' OR record->'wildapricot'->>'status' ~* 'unver' THEN 'incomplete' ELSE 'applied' END)
        WHERE external_ids ? 'wildapricot' AND coalesce(record->>'joinStage', '') = '' AND ((coalesce(record->'wildapricot'->>'level', '') = '' AND coalesce(record->'wildapricot'->>'status', '') = '') OR record->'wildapricot'->>'level' ~* 'unver' OR record->'wildapricot'->>'status' ~* 'unver' OR record->'wildapricot'->>'status' ~* '^pending - new$') RETURNING id` },
    { sql: `UPDATE app.members SET approved_on = NULL WHERE external_ids ? 'wildapricot' AND record->>'joinStage' IN ('incomplete', 'applied') AND approved_on IS NOT NULL RETURNING id` },
    { sql: `UPDATE app.memberships x SET status = 'cancelled' FROM app.members m WHERE m.org_id = x.org_id AND m.id = x.member_id AND x.how = 'imported' AND x.status = 'active' AND m.record->>'joinStage' IN ('incomplete', 'applied') RETURNING x.id` }]);
  const moved = await db.run(A, [
    { sql: `UPDATE app.members SET plan = ${PLAN_SQL_CASE} WHERE external_ids ? 'wildapricot' AND plan <> ${PLAN_SQL_CASE} RETURNING id` },
    { sql: `UPDATE app.memberships x SET plan_id = m.plan FROM app.members m WHERE m.org_id = x.org_id AND m.id = x.member_id AND x.how = 'imported' AND x.plan_id <> m.plan RETURNING x.id` }]);
  if (moved[0].length || moved[1].length) console.log(`Plans: ${moved[0].length} members and ${moved[1].length} membership terms moved to their Wild Apricot level's plan.`);
  if (fix.some((r) => r.length)) console.log(`Repaired: ${fix[0].length} marked as never became members, ${fix[1].length} un-approved, ${fix[2].length} terms set aside.`);
  await db.run(A, [{ sql: 'SELECT app.refresh_status($1::uuid)', params: [org.id] },
    { sql: `INSERT INTO app.imports (org_id, preset, mapping, rows_total, rows_created, rows_skipped, problems, status, by) VALUES ($1::uuid, 'wildapricot', '{}'::jsonb, $2::int, $3::int, $4::int, $5::jsonb, 'done', 'Import script')`, params: [org.id, table.length - 1, todo.length, skipped.length + (list.length - todo.length), JSON.stringify(skipped.slice(0, 200))] }]);
  const sum = (await rows(db, A, `SELECT status, count(*)::int AS n FROM app.members GROUP BY status ORDER BY 2 DESC`)) as { status: string; n: number }[];
  console.log(`Done: ${todo.length} members, ${terms.length} membership terms, ${notes.length} notes, ${pairs.length} couples linked.`);
  console.log(`Members now: ${sum.map((s) => `${s.n} ${s.status}`).join(' · ')}`);
  console.log('Review queries: BE/sql/review/real-data.sql (or npm run report:members).');
  await db.close();
}
if (process.argv[1] && /import-wildapricot\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(`Import stopped: ${String(e?.message ?? e).split("\n").slice(0, 6).join("\n") || e}`, process.env.IMPORT_DEBUG ? e : ""); process.exit(1); });
