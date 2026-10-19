/**
 * Seeds the founding organization (ISGH, client #1) with the starter documents and the fictional demo members the
 * admin ships with (help-desk tickets start empty) – so the API answers exactly what the demo admin shows. Idempotent: existing rows are
 * kept (documents already published are not overwritten). `npm run seed` (after migrate).
 */
import { openDb, one, type Db } from './sql.js';
import { REGISTRY, DOC_KEYS } from '../registry.js';
import { demoMembers, type Member } from '@/lib/members/members';
import { project, PROJECTED_KEYS } from '../modules/projections.js';

const OWNER = { org: null, role: 'owner' as const };

export async function ensureOrg(db: Db, slug: string, name: string, founding = false): Promise<string> {
  const found = await one<{ id: string }>(db, OWNER, 'SELECT id FROM platform.organizations WHERE slug = $1', [slug]);
  if (found) return found.id;
  const made = await one<{ id: string }>(db, OWNER, 'INSERT INTO platform.organizations (slug, name, founding) VALUES ($1, $2, $3) RETURNING id', [slug, name, founding]);
  // ISGH's member IDs are HOU-123456 (a setting of the organization since B6b)
  if (slug === 'isgh') await db.run(OWNER, [{ sql: `UPDATE platform.organizations SET member_prefix = 'HOU' WHERE id = $1::uuid AND member_prefix = ''`, params: [made!.id] }]);
  return made!.id;
}

export async function seedDocuments(db: Db, orgId: string) {
  // one transaction for all documents (one round trip each statement, not five)
  const res = await db.run({ org: orgId, role: 'app_platform' }, DOC_KEYS.map((key) => ({ sql: 'INSERT INTO app.documents (org_id, key, data, published_by, note) VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (org_id, key) DO NOTHING RETURNING key', params: [orgId, key, REGISTRY[key].initial, 'seed', 'Starter content'] })));
  return res.reduce((n, r) => n + r.length, 0);
}

export function memberRow(m: Member) {
  const { id, first, last, email, phone, dob, street, city, zip, zone, center, plan, joined, appliedOn, approvedOn, idCheck, standing, spouseId, commitment, source, archived, extra, prefs, payments, ...rest } = m;
  return { id, first, last, email, phone, dob, street, city, zip, zone, center, plan, joined, appliedOn, approvedOn, idCheck, standing, spouseId: spouseId ?? '', commitment, source: source ?? 'website', archived: archived ?? null, extra: extra ?? {}, prefs: prefs ?? null, record: rest, payments };
}
export async function seedMembers(db: Db, orgId: string, list = demoMembers()) {
  const actor = { org: orgId, role: 'app_platform' as const };
  const existing = Number((await one<{ n: string }>(db, actor, 'SELECT count(*)::text AS n FROM app.members'))?.n ?? 0);
  if (existing > 0) return 0;
  let n = 0;
  // many rows per INSERT: a far-away database (PC → server) costs ≈ 250 ms per statement, so 1,000+ single-row
  // inserts took minutes; the same values and casts as before, $1 = the organization for every row
  const M = `(org_id, id, first_name, last_name, email, phone, dob, street, city, zip, zone, center, plan, joined_year, applied_on, approved_on, id_check, standing, spouse_id, commitment, source, archived, extra, prefs, record)`;
  const mRow = (b: number) => `($1, $${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, NULLIF($${b + 5}, '')::date, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}::int, $${b + 13}::date, NULLIF($${b + 14}, '')::date, $${b + 15}, $${b + 16}, NULLIF($${b + 17}, ''), $${b + 18}, $${b + 19}, NULLIF($${b + 20}, '')::jsonb, $${b + 21}::jsonb, NULLIF($${b + 22}, '')::jsonb, $${b + 23}::jsonb)`;
  const pRow = (b: number) => `($1, $${b}, $${b + 1}::int, $${b + 2}::date, $${b + 3}::int, $${b + 4}, $${b + 5}, $${b + 6})`;
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100).map(memberRow);
    const mParams: unknown[] = [orgId]; const mValues: string[] = [];
    const pParams: unknown[] = [orgId]; const pValues: string[] = [];
    for (const m of batch) {
      mValues.push(mRow(mParams.length + 1));
      mParams.push(m.id, m.first, m.last, m.email, m.phone, m.dob, m.street, m.city, m.zip, m.zone, m.center, m.plan, m.joined, m.appliedOn, m.approvedOn ?? '', m.idCheck, m.standing, m.spouseId, m.commitment, m.source, m.archived ?? '', m.extra, m.prefs ?? '', m.record);
      for (const p of m.payments) { pValues.push(pRow(pParams.length + 1)); pParams.push(m.id, p.year, p.paidOn, p.amountCents, p.method, p.payer, p.ref); }
    }
    const stmts = [{ sql: `INSERT INTO app.members ${M} VALUES ${mValues.join(', ')} ON CONFLICT DO NOTHING`, params: mParams }];
    // payments in chunks (PostgreSQL allows 65,535 parameters per statement)
    for (let k = 0; k < pValues.length; k += 2000) {
      const vals = pValues.slice(k, k + 2000);
      if (!vals.length) break;
      // renumber this chunk's placeholders from $2
      const first = 1 + k * 7; const chunkParams = [orgId, ...pParams.slice(first, first + vals.length * 7)];
      stmts.push({ sql: `INSERT INTO app.payments (org_id, member_id, year, paid_on, amount_cents, method, payer, ref) VALUES ${vals.map((_, j) => pRow(2 + j * 7)).join(', ')} ON CONFLICT DO NOTHING`, params: chunkParams });
    }
    await db.run(actor, stmts);
    n += batch.length;
  }
  return n;
}
export async function seed() {
  const db = openDb();
  const org = await ensureOrg(db, 'isgh', 'Islamic Society of Greater Houston', true);
  const docs = await seedDocuments(db, org);
  // once real records are imported (npm run import:wa), the demo members are not added back
  const real = await one<{ n: number }>(db, { org, role: 'app_platform' }, `SELECT count(*)::int AS n FROM app.members WHERE external_ids ? 'wildapricot' OR source = 'import'`);
  const members = real?.n ? 0 : await seedMembers(db, org);
  // B2: copy the documents into their tables (zones, masjids, plans, roles, funds) and place everyone
  for (const key of PROJECTED_KEYS) { const d = await one<{ data: unknown }>(db, { org, role: 'app_platform' }, 'SELECT data FROM app.documents WHERE key = $1', [key]); if (d) await project(db, org, key, d.data); }
  await db.close();
  return { org, docs, members };
}
if (process.argv[1] && /seed\.ts$/.test(process.argv[1])) seed().then((r) => console.log(`seed: org ${r.org} · ${r.docs} documents · ${r.members} members`)).catch((e) => { console.error(e.message); process.exit(1); });
