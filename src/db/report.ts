/**
 * npm run report:members [-- --org isgh] – runs sql/review/real-data.sql for one organization and prints each table.
 * Counts only; the queries print no personal details.
 */
import { readFileSync } from 'node:fs';
import { openDb, one, rows } from './sql.js';

const args = process.argv.slice(2);
const slug = args.includes('--org') ? args[args.indexOf('--org') + 1] : process.env.DEFAULT_ORG ?? 'isgh';
const text = readFileSync(new URL('../../sql/review/real-data.sql', import.meta.url), 'utf8');
const blocks = text.split(/^-- name: /m).slice(1).map((b) => { const [title, ...rest] = b.split('\n'); return { title: title.trim(), sql: rest.filter((l) => !l.startsWith('--')).join('\n').trim().replace(/;\s*$/, '') }; });

const db = openDb();
const org = await one<{ id: string; name: string }>(db, { org: null, role: 'owner' }, 'SELECT id::text, name FROM platform.organizations WHERE slug = $1', [slug]);
if (!org) { console.error(`No organization "${slug}".`); process.exit(1); }
console.log(`Member report – ${org.name}\n`);
for (const b of blocks) {
  try {
    const r = await rows(db, { org: org.id, role: 'app_api' }, b.sql);
    console.log(`== ${b.title}`); console.table(r.length ? r : [{ result: 'none' }]);
  } catch (e) { console.log(`== ${b.title}\n   could not run: ${String((e as Error).message).split('\n')[0]}`); }
}
await db.close();
