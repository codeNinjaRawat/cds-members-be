/**
 * `npm run db:test-sql` (or `npm run server-dev:test-sql`): the SQL white-box tests (tests/rls.sql, tests/rls_all.sql)
 * through the pg driver – so they also run on Windows without psql. Same files the psql script runs; lines starting
 * with "\" (psql commands) are skipped. A failure is an error raised by the file, a NOTICE starting with FAIL, or a
 * result row with ok = false. Refuses the LIVE database: only names ending in _dev or _test (or DATABASE_ALLOW_TESTS=1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pgConfig } from './sql.js';
import { describeDb } from '../env-file.js';

export function testsAllowed(dbName: string, env: NodeJS.ProcessEnv = process.env) { return /(_dev|_test)$/.test(dbName) || env.DATABASE_ALLOW_TESTS === '1'; }
export const stripPsql = (sql: string) => sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('\\')).join('\n');
type Result = { rows?: Record<string, unknown>[] };
export function judge(results: Result | Result[], notices: string[]) {
  const list = Array.isArray(results) ? results : [results];
  const rowsOk = list.flatMap((r) => r.rows ?? []).filter((r) => 'ok' in r);
  const failedRows = rowsOk.filter((r) => r.ok === false || r.ok === 'f');
  const failedNotices = notices.filter((n) => /^FAIL/i.test(n));
  return { passed: rowsOk.length - failedRows.length + notices.filter((n) => /^ok\b/i.test(n)).length, failed: [...failedRows.map((r) => `row: ${JSON.stringify(r)}`), ...failedNotices] };
}

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  const mod = await import('pg' as string).catch(() => null);
  if (!mod) { console.error('The pg package is not installed – run npm install.'); process.exit(1); }
  const client = new (mod.default?.Client ?? mod.Client)(pgConfig(url));
  const notices: string[] = []; client.on('notice', (n: { message: string }) => notices.push(n.message));
  await client.connect();
  const db = (await client.query('SELECT current_database() AS d')).rows[0].d as string;
  if (!testsAllowed(db)) { console.error(`Refused: "${db}" looks like the LIVE database. SQL tests run only on *_dev or *_test databases.`); await client.end(); process.exit(1); }
  console.log(`SQL tests on ${describeDb(url)}`);
  let failed = 0;
  for (const f of ['rls.sql', 'rls_all.sql']) {
    notices.length = 0;
    try {
      const res = await client.query(stripPsql(readFileSync(join(process.cwd(), 'tests', f), 'utf8')));
      const j = judge(res, notices);
      failed += j.failed.length;
      console.log(`  ${j.failed.length ? '!!' : 'ok'}  tests/${f}: ${j.passed} checks passed${j.failed.length ? `, ${j.failed.length} failed` : ''}`);
      j.failed.forEach((x) => console.log(`        ${x}`));
    } catch (e) {
      failed++; console.log(`  !!  tests/${f}: ${(e as Error).message}`);
      await client.query('ROLLBACK').catch(() => {});
    }
  }
  await client.end();
  console.log(failed ? `\n${failed} failure(s).` : '\nAll SQL tests passed.');
  process.exit(failed ? 1 : 0);
}
if (process.argv[1] && /sql-tests\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e.message); process.exit(1); });
