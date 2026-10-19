/**
 * npm run admins [-- --org isgh]  (server-dev:admins for the DEV database) – who can sign in to the admin: every admin
 * email with its role and reach, so you know which address to type on the sign-in page. Development: with
 * AUTH_DEV_CODES=1 in BE/.env the 6-digit code then shows on the sign-in page (only for an address listed here).
 * npm run admins -- --code someone@example.org   prints the newest sign-in code asked for that address (development only).
 */
import { openDb, one, rows } from './sql.js';

const args = process.argv.slice(2);
const slug = args.includes('--org') ? args[args.indexOf('--org') + 1] : process.env.DEFAULT_ORG ?? 'isgh';
const db = openDb();
const org = await one<{ id: string; name: string }>(db, { org: null, role: 'owner' }, 'SELECT id::text, name FROM platform.organizations WHERE slug = $1', [slug]);
if (!org) { console.error(`No organization "${slug}" – run the seed first (npm run seed, or npm run server-dev:seed).`); process.exit(1); }
if (args.includes('--code')) {
  if (process.env.NODE_ENV === 'production') { console.error('Not on a production server.'); process.exit(1); }
  const to = String(args[args.indexOf('--code') + 1] ?? '').trim().toLowerCase();
  const O = { org: null, role: 'owner' as const };
  const m = await one<{ subject: string; age: number; slug: string }>(db, O, `SELECT x.subject, (extract(epoch FROM now() - x.created_at) / 60)::int AS age, o.slug FROM platform.outbox x
    JOIN platform.organizations o ON o.id = x.org_id WHERE x.kind = 'sign-in-code' AND lower(x.to_address) = $1 ORDER BY x.created_at DESC LIMIT 1`, [to]);
  const code = m?.subject.match(/\d{6}/)?.[0];
  if (code) console.log(`Newest code for ${to}: ${code}  (asked ${m!.age} min ago for "${m!.slug}" – codes work for 10 minutes)`);
  else {
    console.log(`No code in this database for ${to}.`);
    const ev = await rows(db, O, `SELECT to_char(e.at, 'YYYY-MM-DD HH24:MI') AS at, coalesce(o.slug, '') AS org, e.address, e.method, e.ok, e.reason FROM platform.sign_in_events e
      LEFT JOIN platform.organizations o ON o.id = e.org_id ORDER BY e.at DESC LIMIT 5`);
    if (ev.length) { console.log('Latest sign-in attempts that reached this database:'); console.table(ev); }
    else console.log('No sign-in attempt has reached this database at all – the API you are signing in through uses another database (or is not running).');
    console.log('Check: the API window shows "Database: connected – membership_dev on 3.18.46.122" and, after you press "Email me a code", a line "[sign-in code] … → 123456".');
  }
  await db.close(); process.exit(0);
}
const list = await rows(db, { org: org.id, role: 'app_api' }, `
  SELECT coalesce(r.name, x.role_id, '(no role)') AS role, a.email::text AS email, a.status,
    CASE WHEN x.admin_id IS NULL THEN '' WHEN cardinality(x.zone_ids) + cardinality(x.center_ids) + cardinality(x.zips) = 0 THEN 'whole organization'
      ELSE concat_ws(', ', nullif(cardinality(x.zone_ids), 0) || ' zone(s)', nullif(cardinality(x.center_ids), 0) || ' masjid(s)', nullif(cardinality(x.zips), 0) || ' ZIP(s)') END AS reach
  FROM app.admins a LEFT JOIN app.admin_assignments x ON x.org_id = a.org_id AND x.admin_id = a.id
  LEFT JOIN app.admin_roles r ON r.org_id = x.org_id AND r.id = x.role_id
  ORDER BY a.status, (x.role_id = 'owner') DESC NULLS LAST, 1, 2`);
console.log(`Admins – ${org.name} (${list.length} role assignments)`);
console.table(list.length ? list : [{ result: 'no admins yet – run the seed (npm run server-dev:seed)' }]);
console.log(process.env.AUTH_DEV_CODES === '1' ? 'Sign-in codes show on the sign-in page (AUTH_DEV_CODES=1). Only "active" admins can sign in.' : 'AUTH_DEV_CODES is not 1 – codes are emailed, not shown on the page.');
await db.close();
