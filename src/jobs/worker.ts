/**
 * The worker process: `npm run worker` (every minute) or `npm run worker -- --once` (one tick, for cron or a test).
 * Runs beside the API with the same DATABASE_URL; any number of workers may run – claims keep them apart.
 */
import { openDb } from '../db/sql.js';
import { tick } from './runner.js';

const db = openDb(); const once = process.argv.includes('--once');
const every = Number(process.env.WORKER_EVERY_SECONDS ?? 60) * 1000;
async function loop() {
  const started = Date.now();
  try { const r = await tick(db); if (process.env.WORKER_LOG !== '0') console.log(new Date().toISOString(), JSON.stringify(r).slice(0, 2000)); }
  catch (e) { console.error(new Date().toISOString(), 'tick failed:', e); }
  if (once) { await db.close(); return; }
  setTimeout(loop, Math.max(5_000, every - (Date.now() - started)));
}
void loop();
