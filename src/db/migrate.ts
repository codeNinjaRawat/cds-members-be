/** Applies sql/*.sql in name order as the database owner, once each (app_migrations remembers). `npm run migrate`. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, rows } from './sql.js';

export async function migrate(dir = join(process.cwd(), 'sql')) {
  const db = openDb();
  await db.exec('CREATE TABLE IF NOT EXISTS public.app_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await rows(db, { org: null, role: 'owner' }, 'SELECT name FROM public.app_migrations')).map((r) => String(r.name)));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    await db.exec(readFileSync(join(dir, f), 'utf8'));
    await db.run({ org: null, role: 'owner' }, [{ sql: 'INSERT INTO public.app_migrations (name) VALUES ($1)', params: [f] }]);
    applied.push(f);
  }
  await db.close();
  return { applied, skipped: files.length - applied.length };
}
if (process.argv[1] && /migrate\.ts$/.test(process.argv[1])) migrate().then((r) => { console.log(`migrations: ${r.applied.length} applied (${r.applied.join(', ') || 'none'}), ${r.skipped} already there`); }).catch((e) => { console.error(e.message); process.exit(1); });
