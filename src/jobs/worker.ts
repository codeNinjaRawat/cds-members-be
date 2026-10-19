/**
 * The worker process: `npm run worker` (every minute) or `npm run worker -- --once` (one tick, for cron or a test).
 * Runs beside the API with the same DATABASE_URL; any number of workers may run – claims keep them apart.
 */
import { openDb } from '../db/sql.js';
import { tick } from './runner.js';
import { assertProduction } from '../production.js';

assertProduction('Worker');
const db = openDb(); const once = process.argv.includes('--once');
// a restart or an update: let the running tick finish, then stop (no half-sent batch)
let stopping = false; let timer: NodeJS.Timeout | undefined; let busy = false;
const stop = () => { stopping = true; if (timer) clearTimeout(timer); if (!busy) void db.close().catch(() => {}).finally(() => process.exit(0)); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
const every = Number(process.env.WORKER_EVERY_SECONDS ?? 60) * 1000;
async function loop() {
  if (stopping) return;
  const started = Date.now(); busy = true;
  try { const r = await tick(db); if (process.env.WORKER_LOG !== '0') console.log(new Date().toISOString(), JSON.stringify(r).slice(0, 2000)); }
  catch (e) { console.error(new Date().toISOString(), 'tick failed:', e); }
  busy = false;
  if (once || stopping) { await db.close().catch(() => {}); if (stopping) process.exit(0); return; }
  timer = setTimeout(loop, Math.max(5_000, every - (Date.now() - started)));
}
void loop();
