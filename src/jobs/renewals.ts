/**
 * The renewal lifecycle, every day: membership status follows the paid terms (app.refresh_status), and the renewal
 * emails switched on in Communication go out on their day (reminders before the renewal date, the renewal-day notice,
 * grace and lapsed notices after it) – each one once per member and term (app.sent_notices).
 * Dates come from the organization's lifecycle (membership settings) – ISGH's are only the defaults.
 */
import { rows, type Statement } from '../db/sql.js';
import { PLATFORM, document, type Ctx } from '../http/core.js';
import { CommunicationSchema, mockCommunication, render, renewalEmailDates, type MacroKey } from '@/lib/community/communication';
import { DEFAULT_LIFECYCLE, MembershipSettingsSchema, mockMembershipSettings } from '@/lib/content/membership';
import { siteOf } from '../modules/join-drafts.js';

const fmt = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;

export async function runRenewalJobs(ctx: Ctx, today: string) {
  const API = { org: ctx.orgId, role: 'app_api' as const };
  await ctx.db.run(API, [{ sql: 'SELECT app.refresh_status($1::uuid)', params: [ctx.orgId] }]);
  const msP = MembershipSettingsSchema.safeParse(await document(ctx.db, ctx.orgId, 'membership-settings')); const ms = msP.success ? msP.data : mockMembershipSettings;
  const cP = CommunicationSchema.safeParse(await document(ctx.db, ctx.orgId, 'communication')); const comm = cP.success ? cP.data : mockCommunication;
  const lc = ms.lifecycle ?? DEFAULT_LIFECYCLE;
  const org = (await rows(ctx.db, PLATFORM, 'SELECT name, short_name FROM platform.organizations WHERE id = $1', [ctx.orgId]))[0] as { name: string; short_name: string } | undefined;
  const site = await siteOf(ctx);
  // members with a renewal date inside the window the lifecycle can reach (60 days before … overdue + 60 after)
  const list = (await rows(ctx.db, API, `SELECT m.id, m.first_name, m.last_name, m.email, m.plan, m.center, coalesce(z.name, '') AS zone, m.paid_through::text AS paid_through FROM app.members m LEFT JOIN app.zones z ON z.org_id = m.org_id AND z.id = m.zone_id
    WHERE m.archived IS NULL AND m.email <> '' AND m.paid_through IS NOT NULL AND m.status <> 'life' AND m.paid_through BETWEEN $1::date - 400 AND $1::date + 120`, [today])) as { id: string; first_name: string; last_name: string; email: string; plan: string; center: string; zone: string; paid_through: string }[];
  const already = new Set(((await rows(ctx.db, API, 'SELECT member_id, key, for_date::text AS d FROM app.sent_notices WHERE for_date >= $1::date - 400', [today])) as { member_id: string; key: string; d: string }[]).map((r) => `${r.member_id}|${r.key}|${r.d}`));
  const notes: Statement[] = []; const mail: Statement[] = []; let n = 0;
  for (const m of list) {
    for (const d of renewalEmailDates(lc, comm, m.paid_through).filter((x) => x.enabled && x.on === today)) {
      const key = `${m.id}|${d.key}|${m.paid_through}`; if (already.has(key)) continue;
      const e = comm.system[d.key]; if (!e) continue;
      const values: Partial<Record<MacroKey, string>> = { 'Member.FirstName': m.first_name, 'Member.LastName': m.last_name, 'Member.Id': m.id, 'Member.Plan': ms.plans.find((p) => p.id === m.plan)?.name ?? m.plan, 'Member.RenewalDate': fmt(m.paid_through),
        'Member.Center': m.center, 'Member.Zone': m.zone, 'Org.Name': org?.name ?? ctx.slug, 'Org.ShortName': org?.short_name || ctx.slug.toUpperCase(), 'Link.Renew': `${site}/membership/renew`, 'Link.Profile': `${site}/portal`, 'Link.Unsubscribe': `${site}/email-preferences` };
      notes.push({ sql: 'INSERT INTO app.sent_notices (org_id, member_id, key, for_date) VALUES ($1::uuid, $2, $3, $4::date) ON CONFLICT DO NOTHING', params: [ctx.orgId, m.id, d.key, m.paid_through] });
      mail.push({ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, $5)`, params: [ctx.orgId, m.email, render(e.subject, values), `${render(e.body, values)}\n\n—\n${comm.sender.footer}`, d.key] });
      already.add(key); n++;
    }
  }
  for (let i = 0; i < notes.length; i += 200) { await ctx.db.run(API, notes.slice(i, i + 200)); await ctx.db.run(PLATFORM, mail.slice(i, i + 200)); }
  return { checked: list.length, emails: n };
}
