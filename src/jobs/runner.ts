/**
 * The job runner. One tick (every minute from src/jobs/worker.ts, or POST /platform/jobs/tick):
 *   every tick, every organization: help-desk escalations + auto-close, scheduled bulk messages
 *   once a day per organization (its own date and time zone): renewal lifecycle, event reminders, automatic groups, files past their delete date
 *   once a day for the platform: old sign-in codes and sessions removed
 *   then the outbox is drained through the providers
 * A daily job is recorded in platform.job_runs (organization, kind, date): it runs once even with several workers,
 * and a failure is kept with its error and tried again on the next tick.
 */
import type { Db } from '../db/sql.js';
import { one, rows } from '../db/sql.js';
import { PLATFORM, document, tzStore, type Ctx } from '../http/core.js';
import { AccessSchema, type AccessDoc } from '@/lib/community/access';
import { runHelpdeskJobs } from '../modules/helpdesk.js';
import { runEventJobs } from '../modules/events.js';
import { runCommsJobs, refreshAutomatic } from '../modules/comms.js';
import { runRenewalJobs } from './renewals.js';
import { drainOutbox } from './outbox.js';
import { purgeFiles } from '../files/routes.js';

/** A context for work nobody clicked: no admin, no member – the jobs check nothing a person would need. */
export async function systemContext(db: Db, orgId: string, slug: string): Promise<Ctx> {
  const access = AccessSchema.parse(await document(db, orgId, 'admin-access')) as AccessDoc;
  return { db, req: { method: 'JOB', path: '/jobs', query: new URLSearchParams(), headers: {}, body: undefined }, orgId, slug, access, me: null, session: null, memberId: null, needsTwoStep: false };
}
const localDate = (tz: string, at = new Date()) => at.toLocaleDateString('en-CA', { timeZone: tz });

async function daily(db: Db, orgId: string | null, kind: string, date: string, run: () => Promise<unknown>) {
  const key = orgId ?? '00000000-0000-0000-0000-000000000000';
  const claimed = await one(db, PLATFORM, `INSERT INTO platform.job_runs (org_id, kind, run_date) SELECT $1::uuid, $2, $3::date WHERE EXISTS (SELECT 1 FROM platform.organizations WHERE id = $1::uuid)
    ON CONFLICT (org_id, kind, run_date) DO UPDATE SET started_at = now(), error = '' WHERE platform.job_runs.done_at IS NULL AND platform.job_runs.error <> '' RETURNING kind`, [key, kind, date]);
  if (!claimed) return null;
  try { const result = await run(); await db.run(PLATFORM, [{ sql: `UPDATE platform.job_runs SET done_at = now(), result = $4::jsonb WHERE org_id = $1::uuid AND kind = $2 AND run_date = $3::date`, params: [key, kind, date, JSON.stringify(result ?? {})] }]); return result; }
  catch (e) { await db.run(PLATFORM, [{ sql: `UPDATE platform.job_runs SET error = $4 WHERE org_id = $1::uuid AND kind = $2 AND run_date = $3::date`, params: [key, kind, date, String((e as Error).message).slice(0, 500)] }]); return { error: String((e as Error).message) }; }
}

export async function tick(db: Db, opts: { now?: Date; drain?: boolean } = {}) {
  const orgs = (await rows(db, PLATFORM, `SELECT id::text, slug, timezone FROM platform.organizations WHERE status IN ('trial', 'active', 'past_due') ORDER BY client_no NULLS LAST`)) as { id: string; slug: string; timezone: string }[];
  const report: Record<string, unknown> = {};
  for (const o of orgs) {
    tzStore.enterWith({ tz: o.timezone });   // the organization's clock for everything this tick does for it
    const ctx = await systemContext(db, o.id, o.slug); const today = localDate(o.timezone, opts.now);
    const r: Record<string, unknown> = {};
    try { r.helpdesk = await runHelpdeskJobs(ctx); } catch (e) { r.helpdesk = { error: String((e as Error).message) }; }
    try { r.messages = await runCommsJobs(ctx, { groups: false }); } catch (e) { r.messages = { error: String((e as Error).message) }; }
    r.renewals = await daily(db, o.id, 'renewals', today, () => runRenewalJobs(ctx, today));
    r.events = await daily(db, o.id, 'event-reminders', today, () => runEventJobs(ctx, today));
    r.groups = await daily(db, o.id, 'groups', today, () => refreshAutomatic(ctx));
    r.files = await daily(db, o.id, 'files-purge', today, () => purgeFiles(ctx, today));
    report[o.slug] = r;
  }
  // the platform's own housekeeping, on the founding organization's date
  const first = orgs[0]; if (first) report.platform = await daily(db, first.id, 'purge-auth', localDate(first.timezone, opts.now), async () => ({ removed: (await one<{ n: number }>(db, PLATFORM, 'SELECT platform.purge_auth(30) AS n'))?.n ?? 0 }));
  if (opts.drain !== false) report.outbox = await drainOutbox(db);
  return report;
}
