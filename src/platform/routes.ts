/**
 * B6a The SaaS platform API – for Masajid Solutions' own staff (the SaaS panel), never for an organization's admins.
 * Rules and shapes: web/src/lib/platform/platform.ts (the panel's contract; saas/src/lib/platform/actions.ts is the demo).
 *
 * Staff sign-in (two factors: an emailed code + a password; the first sign-in sets the password)
 *   POST /platform/auth/code/start {email} · POST /platform/auth/code/verify {email, code, password} · POST /platform/auth/sign-out
 * Panel (role-checked: owner · support · billing · readonly)
 *   GET  /platform/state                           organizations, plans, flags, announcements, settings, team, support, audit, invoices
 *   POST /platform/orgs                            a new organization (NewOrgSchema) + its owner's invitation link
 *   POST /platform/orgs/:slug/actions              {type: suspend | restore | cancel | reactivate | plan | extendTrial | convert | paymentFixed | module |
 *                                                    invite | resend | revoke | role | domain | verifyDomain | removeDomain | support | endSupport | profile, …}
 *   GET/PUT /platform/docs/:key                     plans | flags | announcements | settings | team  ({data, baseVersion} → 409 on a newer version)
 *   POST /platform/invoices/:id {status: paid | void | retry}
 * The organization side (ORG_PLATFORM_ROUTES, on the organization's own address)
 *   GET  /admin/platform/me                        product, organization, modules, announcements, support banner
 *   GET  /auth/invitations/:token · POST /auth/invitations/:token/accept {name?, password}
 *   POST /auth/support {token}                      a support link opens a support session (read-only unless "full")
 * Every change is written to platform.audit (append-only). ISGH, client #1, can never be cancelled (also a DB rule).
 */
import { resolveTxt } from 'node:dns/promises';
import { z } from 'zod';
import type { Db, Statement } from '../db/sql.js';
import { one, rows } from '../db/sql.js';
import { HttpError, PLATFORM, cookieOf, document, route, todayCT, type Ctx, type Req, type Res, type Route } from '../http/core.js';
import { codeHash, hashPassword, newCode, newToken, passwordProblem, sha256hex, verifyPassword } from '../auth/crypto.js';
import { cookie } from '../auth/routes.js';
import { saveDocument } from '../modules/projections.js';
import * as P from '@/lib/platform/platform';
import { AccessSchema, mockAccess } from '@/lib/community/access';

const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const API = (org: string) => ({ org, role: 'app_api' as const });

/* ---------------- the panel's documents ---------------- */
type DocKey = 'plans' | 'flags' | 'announcements' | 'settings' | 'team';
const DOCS: Record<DocKey, { schema: z.ZodTypeAny; initial: () => unknown }> = {
  plans: { schema: P.PlansDocSchema, initial: () => P.defaultPlans },
  flags: { schema: P.FlagsDocSchema, initial: () => P.defaultFlags },
  announcements: { schema: P.AnnouncementsDocSchema, initial: () => P.defaultAnnouncements },
  settings: { schema: P.PlatformSettingsSchema, initial: () => ({ ...P.defaultSettings, baseDomain: process.env.BASE_DOMAIN ?? P.defaultSettings.baseDomain }) },
  // the first platform owner comes from the server's environment – never from demo data in production
  team: { schema: P.TeamDocSchema, initial: () => ({ staff: [{ id: 'owner', name: 'Platform owner', email: process.env.PLATFORM_OWNER_EMAIL ?? (process.env.AUTH_DEV_HEADER === '1' ? 'owner@example.org' : 'nobody@invalid.example'), role: 'owner', twoFactor: true, active: true }] }) },
};
export async function panelDoc<T>(db: Db, key: DocKey): Promise<{ data: T; version: number }> {
  const r = await one<{ data: T; version: number }>(db, PLATFORM, 'SELECT data, version FROM platform.panel_docs WHERE key = $1', [key]);
  if (r) return r;
  const data = DOCS[key].initial() as T; await savePanelDoc(db, key, data, 'system', 0); return { data, version: 1 };
}
async function savePanelDoc(db: Db, key: DocKey, data: unknown, by: string, base: number) {
  const r = await one<{ version: number }>(db, PLATFORM, `INSERT INTO platform.panel_docs (key, data, version, updated_by) VALUES ($1, $2::jsonb, 1, $3)
    ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, version = platform.panel_docs.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by WHERE platform.panel_docs.version = $4::int OR $4::int = -1 RETURNING version`, [key, JSON.stringify(data), by, base]);
  if (!r) throw new HttpError(409, 'Someone saved a newer version – reload and make your change again.');
  // projections the database and sign-in need
  if (key === 'plans') {
    const d = data as P.PlansDoc;
    await db.run(PLATFORM, d.plans.map((p, i) => ({ sql: `INSERT INTO platform.saas_plans (id, name, tagline, price_monthly_cents, price_annual_cents, limit_members, limit_centers, limit_admins, limit_sms, modules, highlight, hidden, sort)
      VALUES ($1, $2, $3, $4::int, $5::int, NULLIF($6::int, 0), NULLIF($7::int, 0), NULLIF($8::int, 0), NULLIF($9::int, 0), $10::text[], $11::boolean, $12::boolean, $13::int)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tagline = EXCLUDED.tagline, price_monthly_cents = EXCLUDED.price_monthly_cents, price_annual_cents = EXCLUDED.price_annual_cents, limit_members = EXCLUDED.limit_members,
        limit_centers = EXCLUDED.limit_centers, limit_admins = EXCLUDED.limit_admins, limit_sms = EXCLUDED.limit_sms, modules = EXCLUDED.modules, highlight = EXCLUDED.highlight, hidden = EXCLUDED.hidden, sort = EXCLUDED.sort`,
      params: [p.id, p.name, p.tagline, p.priceMonthly, p.priceAnnual, p.limits.members, p.limits.centers, p.limits.admins, p.limits.sms, `{${p.modules.join(',')}}`, p.highlight, p.hidden, i] })));
  }
  if (key === 'team') {
    const d = data as { staff: P.Staff[] };
    const st: Statement[] = [{ sql: `UPDATE platform.staff SET active = false WHERE key IS NOT NULL AND key <> ALL(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`, params: [JSON.stringify(d.staff.map((x) => x.id))] }];
    for (const x of d.staff) st.push(
      { sql: `INSERT INTO platform.users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET name = coalesce(NULLIF(platform.users.name, ''), EXCLUDED.name)`, params: [x.email.toLowerCase(), x.name] },
      { sql: `INSERT INTO platform.staff (user_id, role, active, key, two_factor) SELECT id, $2, $3::boolean, $4, $5::boolean FROM platform.users WHERE email = $1
        ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active, key = EXCLUDED.key, two_factor = EXCLUDED.two_factor`, params: [x.email.toLowerCase(), x.role, x.active, x.id, x.twoFactor] });
    await db.run(PLATFORM, st);
  }
  return r.version;
}
async function audit(db: Db, actor: Staff | string, action: string, org: string | null, detail: string) {
  await db.run(PLATFORM, [{ sql: 'INSERT INTO platform.audit (actor, staff_id, action, org_id, detail) VALUES ($1, NULLIF($2, \'\')::uuid, $3, NULLIF($4, \'\')::uuid, $5)', params: [typeof actor === 'string' ? actor : actor.name, typeof actor === 'string' ? '' : actor.staffId, action, org, detail.slice(0, 1000)] }]);
}

/* ---------------- who is calling ---------------- */
type Staff = { staffId: string; userId: string; email: string; name: string; role: (typeof P.STAFF_ROLES)[number] };
async function staffOf(db: Db, req: Req): Promise<Staff> {
  await panelDoc(db, 'team');   // the first owner exists before anyone signs in
  let email = '';
  const token = cookieOf(req);
  if (token.length >= 32) {
    const s = await one<{ email: string; two_step_ok: boolean }>(db, PLATFORM, `SELECT u.email, s.two_step_ok FROM platform.sessions s JOIN platform.users u ON u.id = s.user_id WHERE s.id = decode($1, 'hex') AND s.kind = 'platform' AND s.revoked_at IS NULL AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(mins => s.idle_minutes)`, [sha256hex(token)]);
    if (s?.two_step_ok) { email = s.email; await db.run(PLATFORM, [{ sql: `UPDATE platform.sessions SET last_seen_at = now() WHERE id = decode($1, 'hex')`, params: [sha256hex(token)] }]); }
  }
  if (!email && process.env.AUTH_DEV_HEADER === '1' && req.headers['x-staff']) email = String(req.headers['x-staff']).toLowerCase();
  if (!email) throw new HttpError(401, 'Sign in to the platform panel.');
  const st = await one<{ staff_id: string; user_id: string; name: string; role: Staff['role'] }>(db, PLATFORM, `SELECT s.id::text AS staff_id, u.id::text AS user_id, coalesce(NULLIF(u.name, ''), u.email) AS name, s.role FROM platform.staff s JOIN platform.users u ON u.id = s.user_id WHERE u.email = $1 AND s.active`, [email]);
  if (!st) throw new HttpError(403, 'Not platform staff.');
  return { staffId: st.staff_id, userId: st.user_id, email, name: st.name, role: st.role };
}
const allow = (s: Staff, ...roles: Staff['role'][]) => { if (!['owner', ...roles].includes(s.role)) throw new HttpError(403, `${P.STAFF_ROLE_INFO[s.role].label} cannot do this.`); };

/* ---------------- organizations as the panel sees them ---------------- */
type OrgRow = { id: string; slug: string; client_no: number; name: string; short_name: string; type: P.Tenant['type']; city: string; state: string; address: string; phone: string; email: string; timezone: string; color: string;
  status: P.TenantStatus; plan: string; billing_cycle: 'monthly' | 'annual'; trial_ends_on: string | null; created_on: string; cancelled_on: string | null; template: P.Template; suspended_reason: string; notes: string; is_sample: boolean };
const ORG_SQL = `SELECT id::text, slug, client_no, name, short_name, type, city, state, address, phone, email::text, timezone, color, status, plan, billing_cycle, trial_ends_on::text, created_on::text, cancelled_on::text, template, suspended_reason, notes, is_sample FROM platform.organizations`;
async function tenants(db: Db, where = '', params: unknown[] = []): Promise<(P.Tenant & { id: string })[]> {
  const orgs = (await rows(db, PLATFORM, `${ORG_SQL} ${where} ORDER BY client_no`, params)) as OrgRow[];
  if (!orgs.length) return [];
  const ids = JSON.stringify(orgs.map((o) => o.id));
  const [mods, admins, domains, usage] = await Promise.all([
    rows(db, PLATFORM, `SELECT org_id::text, module, value FROM platform.org_modules WHERE org_id::text = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`, [ids]) as Promise<{ org_id: string; module: P.Module; value: 'on' | 'off' }[]>,
    rows(db, PLATFORM, `SELECT a.id::text, a.org_id::text, coalesce(NULLIF(u.name, ''), i.name, u.email) AS name, u.email::text, a.role, a.status, a.invited_on::text, a.last_active_on::text FROM platform.org_admin_users a JOIN platform.users u ON u.id = a.user_id
      LEFT JOIN LATERAL (SELECT name FROM platform.invitations x WHERE x.org_user_id = a.id ORDER BY created_at DESC LIMIT 1) i ON true WHERE a.org_id::text = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb))) ORDER BY a.invited_on`, [ids]) as Promise<any[]>,
    rows(db, PLATFORM, `SELECT org_id::text, host::text, status, verify_token, added_on::text, checked_at::text FROM platform.org_domains WHERE app = 'web' AND org_id::text = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`, [ids]) as Promise<any[]>,
    rows(db, PLATFORM, `SELECT o.id::text AS org_id, (SELECT count(*)::int FROM platform.outbox x WHERE x.org_id = o.id AND x.channel = 'sms' AND x.created_at >= date_trunc('month', now())) AS sms FROM platform.organizations o WHERE o.id::text = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`, [ids]) as Promise<{ org_id: string; sms: number }[]>,
  ]);
  const out: (P.Tenant & { id: string })[] = [];
  for (const o of orgs) {
    const counts = await one<{ members: number; centers: number }>(db, API(o.id), `SELECT (SELECT count(*)::int FROM app.members WHERE archived IS NULL) AS members, (SELECT count(*)::int FROM app.centers WHERE active) AS centers`);
    const d = domains.find((x) => x.org_id === o.id);
    out.push({ id: o.id, slug: o.slug, clientNo: o.client_no, name: o.name, shortName: o.short_name || o.slug.toUpperCase(), type: o.type, city: o.city || '–', state: o.state || 'TX', address: o.address, phone: o.phone, email: o.email || 'office@example.org',
      timezone: o.timezone, color: o.color, status: o.status, planId: o.plan, cycle: o.billing_cycle, trialEndsOn: o.trial_ends_on ?? undefined, createdOn: o.created_on, cancelledOn: o.cancelled_on ?? undefined, template: o.template,
      modules: Object.fromEntries(mods.filter((m) => m.org_id === o.id).map((m) => [m.module, m.value])),
      admins: admins.filter((a) => a.org_id === o.id).map((a) => ({ id: a.id, name: a.name, email: a.email, role: a.role, status: a.status, invitedOn: a.invited_on, lastActiveOn: a.last_active_on ?? undefined })),
      customDomain: d ? { host: d.host, status: d.status, token: d.verify_token, addedOn: d.added_on, checkedOn: d.checked_at?.slice(0, 10) } : undefined,
      usage: { members: counts?.members ?? 0, centers: counts?.centers ?? 0, sms: usage.find((u) => u.org_id === o.id)?.sms ?? 0 }, suspendedReason: o.suspended_reason || undefined, notes: o.notes || undefined, sample: o.is_sample });
  }
  return out;
}
async function tenant(db: Db, slug: string) { const t = (await tenants(db, 'WHERE slug = $1', [slug]))[0]; if (!t) throw new HttpError(404, 'No organization with that address.'); return t; }

/* ---------------- invitations and starter documents ---------------- */
const ACCESS_ROLE: Record<P.Role, string> = { owner: 'owner', admin: 'admin', editor: 'website-editor', viewer: 'viewer' };
async function adminHost(db: Db, t: Pick<P.Tenant, 'slug'>) { const s = (await panelDoc<P.PlatformSettings>(db, 'settings')).data; return process.env.ADMIN_URL_TEMPLATE ? process.env.ADMIN_URL_TEMPLATE.replace('{slug}', t.slug) : `https://${t.slug}-admin.${s.baseDomain}`; }
async function invite(db: Db, by: Staff | string, orgId: string, t: Pick<P.Tenant, 'slug' | 'name'>, who: { name: string; email: string; role: P.Role }) {
  const token = newToken(); const email = who.email.toLowerCase();
  const u = (await one<{ id: string }>(db, PLATFORM, `INSERT INTO platform.users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET name = coalesce(NULLIF(platform.users.name, ''), EXCLUDED.name) RETURNING id::text`, [email, who.name]))!;
  const ou = (await one<{ id: string }>(db, PLATFORM, `INSERT INTO platform.org_admin_users (org_id, user_id, role, status) VALUES ($1::uuid, $2::uuid, $3, 'invited')
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = CASE WHEN platform.org_admin_users.status = 'revoked' THEN 'invited' ELSE platform.org_admin_users.status END, invited_on = current_date RETURNING id::text`, [orgId, u.id, who.role]))!;
  await db.run(PLATFORM, [
    { sql: `UPDATE platform.invitations SET revoked_at = now() WHERE org_id = $1::uuid AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, params: [orgId, email] },
    { sql: `INSERT INTO platform.invitations (org_id, email, name, role, token_hash, invited_by, org_user_id) VALUES ($1::uuid, $2, $3, $4, decode($5, 'hex'), $6, $7::uuid)`, params: [orgId, email, who.name, who.role, sha256hex(token), typeof by === 'string' ? by : by.name, ou.id] }]);
  const link = `${await adminHost(db, t)}/welcome?token=${token}`;
  await db.run(PLATFORM, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1::uuid, 'email', $2, $3, $4, 'invitation')`, params: [orgId, email, `You are invited to ${t.name}`, `Assalamu alaikum ${who.name.split(' ')[0]},\n\nYou are invited to run ${t.name} on the platform as ${P.ROLE_INFO[who.role].label}.\nOpen this link within 7 days to accept: ${link}`] }]);
  // the organization's own access list knows them (invited) – they become active when they accept
  const doc = AccessSchema.parse(await document(db, orgId, 'admin-access'));
  if (!doc.admins.some((a) => a.email.toLowerCase() === email)) {
    const id = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'admin';
    const unique = doc.admins.some((a) => a.id === id) ? `${id}-${Math.random().toString(36).slice(2, 6)}` : id;
    await saveDocument(db, orgId, 'admin-access', AccessSchema.parse({ ...doc, admins: [...doc.admins, { id: unique.length >= 2 ? unique : `${unique}-a`, name: who.name, email, roleId: ACCESS_ROLE[who.role], status: 'invited', twoStep: who.role === 'owner' || who.role === 'admin' }] }), 'Platform', `Invited ${email}`);
  }
  return link;
}
/** A new organization never sees ISGH's people: its access list (the owner only), map, officials, records, events and
 *  campaigns start empty. Built and checked before the organization exists, so a bad starter never leaves half an organization. */
async function starterDocs(owner: { name: string; email: string }) {
  const id = owner.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  const empty: Record<string, unknown> = {
    'admin-access': { ...mockAccess, admins: [{ id: id.length >= 2 ? id : 'owner', name: owner.name, email: owner.email.toLowerCase(), roleId: 'owner', status: 'active', twoStep: true }] },
    'org-structure': { zones: [], centers: [] },
    officials: { holders: [], history: [], eidDates: [], website: { enabled: false, showEmail: false, findByZip: false, pastLeadership: false } },
    elections: { rules: {}, elections: [] },
    records: { items: [], website: { enabled: false } },
    events: { enabled: true, showPast: true, defaultReminderDays: 1, approval: { required: false, leadDays: 7 }, events: [] },
    fundraising: { campaigns: [], pages: [], website: { enabled: false } },
    groups: { enabled: true, groups: [] },
  };
  const { REGISTRY } = await import('../registry.js');
  const out: [string, unknown][] = [];
  for (const [key, data] of Object.entries(empty)) {
    const p = (REGISTRY as Record<string, { schema: z.ZodTypeAny }>)[key].schema.safeParse(data);
    if (!p.success) throw new HttpError(500, `Starter ${key}: ${p.error.issues[0]?.path.join('.')} ${p.error.issues[0]?.message}`);
    out.push([key, p.data]);
  }
  return out;
}

/** Member IDs look like CVIC-100001: the short name's letters (2–5), else the address name's. */
const memberPrefix = (short: string, slug: string) => { const a = short.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5); return a.length >= 2 ? a : slug.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5).padEnd(2, 'X'); };

/* ---------------- actions ---------------- */
const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('suspend'), reason: z.string().trim().min(10, 'Say why in at least 10 characters – the organization sees it.').max(300) }),
  z.object({ type: z.literal('restore') }),
  z.object({ type: z.literal('cancel'), reason: z.string().trim().min(10, 'Say why in at least 10 characters.').max(300) }),
  z.object({ type: z.literal('reactivate') }),
  z.object({ type: z.literal('plan'), planId: z.string(), cycle: z.enum(['monthly', 'annual']) }),
  z.object({ type: z.literal('extendTrial'), days: z.number().int().min(1).max(60) }),
  z.object({ type: z.literal('convert') }),
  z.object({ type: z.literal('paymentFixed') }),
  z.object({ type: z.literal('module'), module: z.enum(P.MODULES), value: z.enum(['on', 'off', 'plan']) }),
  z.object({ type: z.literal('invite'), name: z.string().trim().min(2).max(80), email: z.string().trim().email(), role: z.enum(P.ROLES) }),
  z.object({ type: z.literal('resend'), id: z.string() }),
  z.object({ type: z.literal('revoke'), id: z.string() }),
  z.object({ type: z.literal('role'), id: z.string(), role: z.enum(P.ROLES) }),
  z.object({ type: z.literal('domain'), host: z.string().trim().toLowerCase() }),
  z.object({ type: z.literal('verifyDomain') }),
  z.object({ type: z.literal('removeDomain') }),
  z.object({ type: z.literal('support'), reason: z.string().trim().min(10, 'Say why you need to sign in (at least 10 characters). The organization can see it.').max(300), mode: z.enum(['read-only', 'full']) }),
  z.object({ type: z.literal('endSupport'), id: z.string() }),
  z.object({ type: z.literal('profile'), name: z.string().trim().min(2).max(100), shortName: z.string().trim().min(2).max(20), email: z.string().trim().email(), phone: z.string().trim().max(30), city: z.string().trim().min(1).max(60), state: z.string().regex(/^[A-Z]{2}$/), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), notes: z.string().max(2000).default('') }),
]);
const WHO: Record<string, Staff['role'][]> = { plan: ['billing'], extendTrial: ['billing', 'support'], convert: ['billing'], paymentFixed: ['billing'], module: ['support'], invite: ['support'], resend: ['support'], revoke: ['support'], role: ['support'],
  domain: ['support'], verifyDomain: ['support'], removeDomain: ['support'], support: ['support'], endSupport: ['support'], profile: ['support'], suspend: ['support', 'billing'], restore: ['support', 'billing'], cancel: [], reactivate: [] };

async function act(db: Db, s: Staff, slug: string, input: unknown): Promise<Record<string, unknown>> {
  const p = ActionSchema.safeParse(input); if (!p.success) throw new HttpError(400, p.error.issues[0]?.message ?? 'Check the form.', issues(p.error));
  const a = p.data; allow(s, ...WHO[a.type]);
  const t = await tenant(db, slug); const today = todayCT(); const plans = (await panelDoc<P.PlansDoc>(db, 'plans')).data; const settings = (await panelDoc<P.PlatformSettings>(db, 'settings')).data;
  const set = async (sql: string, params: unknown[]) => db.run(PLATFORM, [{ sql: `UPDATE platform.organizations SET ${sql} WHERE id = $1::uuid`, params: [t.id, ...params] }]);
  const user = (id: string) => t.admins.find((u) => u.id === id);
  let note = ''; const extra: Record<string, unknown> = {};
  switch (a.type) {
    case 'suspend': if (t.status === 'suspended' || t.status === 'cancelled') throw new HttpError(409, `It is already ${P.STATUS_LABEL[t.status].toLowerCase()}.`); await set(`status = 'suspended', suspended_reason = $2`, [a.reason]); note = `Suspended: ${a.reason}`; break;
    case 'restore': if (t.status !== 'suspended') throw new HttpError(409, 'Only a suspended organization can be restored.'); await set(`status = $2, suspended_reason = ''`, [t.trialEndsOn && t.trialEndsOn >= today ? 'trial' : 'active']); note = 'Restored'; break;
    case 'cancel':
      if (P.isFounding(t) || t.clientNo === 1) throw new HttpError(409, `${t.shortName} is the founding client of the platform and cannot be cancelled.`);
      if (t.status === 'cancelled') throw new HttpError(409, 'It is already cancelled.');
      await set(`status = 'cancelled', cancelled_on = current_date, suspended_reason = $2`, [a.reason]); note = `Cancelled: ${a.reason}. Data kept for 30 days.`; break;
    case 'reactivate': if (t.status !== 'cancelled') throw new HttpError(409, 'Only a cancelled organization can be brought back.'); await set(`status = 'active', cancelled_on = NULL, suspended_reason = ''`, []); note = 'Reactivated'; break;
    case 'plan': {
      const pl = plans.plans.find((x) => x.id === a.planId); if (!pl) throw new HttpError(400, 'Unknown plan.');
      const over = (['members', 'centers'] as const).filter((k) => pl.limits[k] && t.usage[k] > pl.limits[k]);
      if (over.length) throw new HttpError(409, `${pl.name} allows ${over.map((k) => `${pl.limits[k].toLocaleString('en-US')} ${k}`).join(' and ')} – this organization has more. Choose a bigger plan.`);
      await set('plan = $2, billing_cycle = $3', [pl.id, a.cycle]); note = `Plan ${P.planOf(plans, t.planId).name} (${t.cycle}) → ${pl.name} (${a.cycle})`; break;
    }
    case 'extendTrial': { if (t.status !== 'trial' || !t.trialEndsOn) throw new HttpError(409, 'Only a trial can be extended.'); const to = addDays(t.trialEndsOn < today ? today : t.trialEndsOn, a.days); await set('trial_ends_on = $2::date', [to]); note = `Trial extended by ${a.days} days, to ${to}`; break; }
    case 'convert': if (t.status !== 'trial') throw new HttpError(409, 'Only a trial can be turned into a paid account.'); await set(`status = 'active', trial_ends_on = NULL`, []); note = 'Trial converted to paid'; break;
    case 'paymentFixed': if (t.status !== 'past_due') throw new HttpError(409, 'There is no failed payment.'); await set(`status = 'active'`, []); await db.run(PLATFORM, [{ sql: `UPDATE platform.invoices SET status = 'paid' WHERE org_id = $1::uuid AND status = 'failed'`, params: [t.id] }]); note = 'Payment problem marked as fixed'; break;
    case 'module':
      if (P.CORE_MODULES.includes(a.module)) throw new HttpError(409, `${P.MODULE_INFO[a.module].label} is always included.`);
      await db.run(PLATFORM, [a.value === 'plan' ? { sql: 'DELETE FROM platform.org_modules WHERE org_id = $1::uuid AND module = $2', params: [t.id, a.module] } : { sql: `INSERT INTO platform.org_modules (org_id, module, value) VALUES ($1::uuid, $2, $3) ON CONFLICT (org_id, module) DO UPDATE SET value = EXCLUDED.value`, params: [t.id, a.module, a.value] }]);
      note = `${P.MODULE_INFO[a.module].label}: ${a.value === 'plan' ? 'follow the plan' : a.value === 'on' ? 'turned on (add-on)' : 'switched off'}`; break;
    case 'invite': {
      const email = a.email.toLowerCase();
      if (t.admins.some((u) => u.email.toLowerCase() === email && u.status !== 'revoked')) throw new HttpError(409, `${email} already has access.`, [{ path: 'email', message: 'Already has access' }]);
      if (a.role === 'owner') throw new HttpError(409, 'There is one owner. Invite them as Admin, then make them the owner.');
      const lim = P.planOf(plans, t.planId).limits.admins; if (lim && t.admins.filter((u) => u.status !== 'revoked').length >= lim) throw new HttpError(409, `${P.planOf(plans, t.planId).name} allows ${lim} admin users. Remove someone or choose a bigger plan.`);
      extra.invite = await invite(db, s, t.id, t, a); note = `Invited ${a.name} <${email}> as ${P.ROLE_INFO[a.role].label}`; break;
    }
    case 'resend': { const u = user(a.id); if (!u || u.status !== 'invited') throw new HttpError(409, 'Only a waiting invitation can be sent again.'); extra.invite = await invite(db, s, t.id, t, { name: u.name, email: u.email, role: u.role }); note = `Invitation sent again to ${u.email} (old link no longer works)`; break; }
    case 'revoke': {
      const u = user(a.id); if (!u || u.status === 'revoked') throw new HttpError(404, 'No such admin user.'); if (u.role === 'owner') throw new HttpError(409, 'Make someone else the owner first.');
      await db.run(PLATFORM, [{ sql: `UPDATE platform.org_admin_users SET status = 'revoked' WHERE id = $1::uuid`, params: [u.id] }, { sql: `UPDATE platform.invitations SET revoked_at = now() WHERE org_user_id = $1::uuid AND accepted_at IS NULL`, params: [u.id] },
        { sql: `UPDATE platform.sessions SET revoked_at = now() WHERE org_id = $1::uuid AND user_id = (SELECT user_id FROM platform.org_admin_users WHERE id = $2::uuid) AND revoked_at IS NULL`, params: [t.id, u.id] }]);
      const doc = AccessSchema.parse(await document(db, t.id, 'admin-access'));
      await saveDocument(db, t.id, 'admin-access', { ...doc, admins: doc.admins.map((x) => (x.email.toLowerCase() === u.email.toLowerCase() ? { ...x, status: 'suspended' as const } : x)) }, 'Platform', `Access removed for ${u.email}`);
      note = `Access removed for ${u.email}`; break;
    }
    case 'role': {
      const u = user(a.id); if (!u || u.status === 'revoked') throw new HttpError(404, 'No such admin user.');
      if (u.role === 'owner' && a.role !== 'owner') throw new HttpError(409, 'Choose the new owner instead – the old owner becomes an Admin.');
      const st: Statement[] = [];
      if (a.role === 'owner') { if (u.status !== 'active') throw new HttpError(409, 'Only someone who accepted their invitation can become the owner.'); st.push({ sql: `UPDATE platform.org_admin_users SET role = 'admin' WHERE org_id = $1::uuid AND role = 'owner'`, params: [t.id] }); }
      st.push({ sql: 'UPDATE platform.org_admin_users SET role = $2 WHERE id = $1::uuid', params: [u.id, a.role] }); await db.run(PLATFORM, st);
      note = `${u.email}: ${P.ROLE_INFO[u.role].label} → ${P.ROLE_INFO[a.role].label}`; break;
    }
    case 'domain': {
      const d = P.DomainSchema.shape.host.safeParse(a.host); if (!d.success) throw new HttpError(400, d.error.issues[0].message);
      if (a.host.endsWith(`.${settings.baseDomain}`)) throw new HttpError(400, `Use the organization’s own domain, not ${settings.baseDomain}.`);
      if (await one(db, PLATFORM, 'SELECT 1 AS x FROM platform.org_domains WHERE host = $1 AND org_id <> $2::uuid', [a.host, t.id])) throw new HttpError(409, 'Another organization already uses this domain.');
      await db.run(PLATFORM, [{ sql: `DELETE FROM platform.org_domains WHERE org_id = $1::uuid AND app = 'web'`, params: [t.id] }, { sql: `INSERT INTO platform.org_domains (host, org_id, app) VALUES ($1, $2::uuid, 'web')`, params: [a.host, t.id] }]);
      const tok = (await one<{ tok: string }>(db, PLATFORM, 'SELECT verify_token AS tok FROM platform.org_domains WHERE host = $1', [a.host]))!.tok;
      extra.dns = [{ type: 'CNAME', name: a.host, value: `${t.slug}.${settings.baseDomain}` }, { type: 'TXT', name: `_nextgrow.${a.host}`, value: tok }];
      note = `Own domain added: ${a.host} (waiting for DNS)`; break;
    }
    case 'verifyDomain': {
      if (!t.customDomain) throw new HttpError(409, 'Add a domain first.');
      let found = false;
      if (process.env.DNS_FAKE === '1') found = !t.customDomain.host.includes('fail');
      else { try { found = (await resolveTxt(`_nextgrow.${t.customDomain.host}`)).flat().includes(t.customDomain.token); } catch { found = false; } }
      await db.run(PLATFORM, [{ sql: `UPDATE platform.org_domains SET status = $2, checked_at = now(), cert_status = CASE WHEN $2 = 'verified' THEN 'requested' ELSE cert_status END WHERE host = $1`, params: [t.customDomain.host, found ? 'verified' : 'failed'] }]);
      note = found ? `${t.customDomain.host} verified – HTTPS certificate requested` : `${t.customDomain.host}: DNS records not found`; extra.verified = found; break;
    }
    case 'removeDomain': if (!t.customDomain) throw new HttpError(409, 'There is no own domain.'); await db.run(PLATFORM, [{ sql: 'DELETE FROM platform.org_domains WHERE host = $1', params: [t.customDomain.host] }]); note = `Own domain removed: ${t.customDomain.host}`; break;
    case 'support': {
      if (t.status === 'cancelled') throw new HttpError(409, 'The organization is cancelled.');
      const token = newToken(); const hours = settings.supportHours;
      await db.run(PLATFORM, [{ sql: `UPDATE platform.support_sessions SET ended_at = now() WHERE org_id = $1::uuid AND ended_at IS NULL`, params: [t.id] },
        { sql: `INSERT INTO platform.support_sessions (org_id, staff_id, reason, mode, ends_at, token_hash) VALUES ($1::uuid, $2::uuid, $3, $4, now() + make_interval(hours => $5::int), decode($6, 'hex'))`, params: [t.id, s.staffId, a.reason, a.mode, hours, sha256hex(token)] }]);
      extra.open = `${await adminHost(db, t)}/support?token=${token}`; extra.token = token;
      note = `${a.mode === 'full' ? 'Full' : 'Read-only'} support sign-in for ${hours} h – ${a.reason}`; break;
    }
    case 'endSupport': {
      const r = await one(db, PLATFORM, `UPDATE platform.support_sessions SET ended_at = now() WHERE id = $1::uuid AND org_id = $2::uuid AND ended_at IS NULL RETURNING id`, [a.id, t.id]); if (!r) throw new HttpError(409, 'That support sign-in already ended.');
      await db.run(PLATFORM, [{ sql: `UPDATE platform.sessions SET revoked_at = now() WHERE support_session_id = $1::uuid AND revoked_at IS NULL`, params: [a.id] }]); note = 'Support sign-in ended'; break;
    }
    case 'profile': await set('name = $2, short_name = $3, email = $4, phone = $5, city = $6, state = $7, color = $8, notes = $9', [a.name, a.shortName, a.email.toLowerCase(), a.phone, a.city, a.state, a.color, a.notes]); note = 'Organization details updated'; break;
  }
  await audit(db, s, `org.${a.type}`, t.id, note);
  return { tenant: await tenant(db, slug), ...extra };
}

/* ---------------- staff sign-in ---------------- */
async function staffSignIn(db: Db, req: Req): Promise<Res> {
  const b = (req.body ?? {}) as Record<string, string>; const email = String(b.email ?? '').trim().toLowerCase();
  await panelDoc(db, 'team');
  const st = await one<{ user_id: string }>(db, PLATFORM, `SELECT u.id::text AS user_id FROM platform.staff s JOIN platform.users u ON u.id = s.user_id WHERE u.email = $1 AND s.active`, [email]);
  if (req.path.endsWith('/start')) {
    // same answer for staff and strangers (no list of who is staff)
    if (st) { const code = newCode(); await db.run(PLATFORM, [{ sql: `INSERT INTO platform.login_codes (channel, address, purpose, code_hash) VALUES ('email', $1, 'staff', decode($2, 'hex'))`, params: [email, codeHash(email, code)] },
      { sql: `INSERT INTO platform.outbox (channel, to_address, subject, body, kind) VALUES ('email', $1, $2, $3, 'sign-in-code')`, params: [email, `${code} is your platform sign-in code`, `Your platform panel sign-in code is ${code}. It works for 10 minutes.`] }]);
      return { status: 202, body: { sent: true, ...(process.env.AUTH_DEV_CODES === '1' ? { devCode: code } : {}) } }; }
    return { status: 202, body: { sent: true } };
  }
  const fail = async (why: string) => { await db.run(PLATFORM, [{ sql: `INSERT INTO platform.sign_in_events (address, method, ok, reason) VALUES ($1, 'staff', false, $2)`, params: [email, why] }]); return new HttpError(400, 'The code or the password is not right.'); };
  const recent = await one<{ n: number }>(db, PLATFORM, `SELECT count(*)::int AS n FROM platform.sign_in_events WHERE address = $1 AND method = 'staff' AND NOT ok AND at > now() - interval '15 minutes'`, [email]);
  if ((recent?.n ?? 0) >= 5) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  if (!st) throw await fail('not staff');
  const c = await one<{ id: string; ok: boolean }>(db, PLATFORM, `SELECT id::text, code_hash = decode($2, 'hex') AS ok FROM platform.login_codes WHERE address = $1 AND purpose = 'staff' AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [email, codeHash(email, String(b.code ?? ''))]);
  if (!c?.ok) throw await fail('wrong code');
  const pw = String(b.password ?? ''); const row = await one<{ hash: string }>(db, PLATFORM, 'SELECT hash FROM platform.passwords WHERE user_id = $1::uuid', [st.user_id]);
  if (row) { if (!verifyPassword(pw, row.hash)) throw await fail('wrong password'); }
  else { const why = passwordProblem(pw, email); if (why) throw new HttpError(400, `Choose your password: ${why}`); await db.run(PLATFORM, [{ sql: 'INSERT INTO platform.passwords (user_id, hash) VALUES ($1::uuid, $2)', params: [st.user_id, hashPassword(pw)] }]); }
  const token = newToken();
  await db.run(PLATFORM, [{ sql: `UPDATE platform.login_codes SET used_at = now() WHERE id = $1::uuid`, params: [c.id] },
    { sql: `INSERT INTO platform.sessions (id, user_id, org_id, kind, two_step_ok, idle_minutes, expires_at) VALUES (decode($1, 'hex'), $2::uuid, NULL, 'platform', true, 30, now() + interval '8 hours')`, params: [sha256hex(token), st.user_id] },
    { sql: `INSERT INTO platform.sign_in_events (address, method, ok, user_id) VALUES ($1, 'staff', true, $2::uuid)`, params: [email, st.user_id] }]);
  await audit(db, email, 'staff.signed-in', null, '');
  return { status: 200, headers: { 'set-cookie': cookie(token, 8 * 3600) }, body: { signedIn: true } };
}

/* ---------------- the panel's router ---------------- */
export async function handlePlatform(db: Db, req: Req): Promise<Res> {
  const { method, path } = req;
  if (method === 'POST' && /^\/platform\/auth\/code\/(start|verify)$/.test(path)) return staffSignIn(db, req);
  if (method === 'POST' && path === '/platform/auth/sign-out') { const t = cookieOf(req); if (t) await db.run(PLATFORM, [{ sql: `UPDATE platform.sessions SET revoked_at = now() WHERE id = decode($1, 'hex')`, params: [sha256hex(t)] }]); return { status: 200, headers: { 'set-cookie': cookie('', 0) }, body: { signedOut: true } }; }
  const s = await staffOf(db, req);
  if (method !== 'GET' && s.role === 'readonly') throw new HttpError(403, 'Read-only staff cannot change anything.');
  const b = req.body as Record<string, unknown>;
  let m: RegExpMatchArray | null;
  if (method === 'GET' && path === '/platform/state') {
    const [ts, plans, flags, ann, settings, team] = await Promise.all([tenants(db), panelDoc(db, 'plans'), panelDoc(db, 'flags'), panelDoc(db, 'announcements'), panelDoc(db, 'settings'), panelDoc(db, 'team')]);
    const support = await rows(db, PLATFORM, `SELECT s.id::text, o.slug, coalesce(NULLIF(u.name, ''), u.email) AS by, s.reason, s.mode, s.started_at::text AS "startedAt", s.ends_at::text AS "endsAt", s.ended_at::text AS "endedAt", (s.ended_at IS NULL AND s.ends_at > now()) AS live
      FROM platform.support_sessions s JOIN platform.organizations o ON o.id = s.org_id JOIN platform.staff st ON st.id = s.staff_id JOIN platform.users u ON u.id = st.user_id ORDER BY s.started_at DESC LIMIT 100`);
    const auditRows = await rows(db, PLATFORM, `SELECT a.id::text, a.at::text, a.actor AS by, a.action, o.slug AS target, a.detail FROM platform.audit a LEFT JOIN platform.organizations o ON o.id = a.org_id ORDER BY a.id DESC LIMIT 300`);
    const invoices = await rows(db, PLATFORM, `SELECT i.id, o.slug, i.period, i.issued_on::text AS "issuedOn", i.amount_cents AS amount, i.status, i.method FROM platform.invoices i JOIN platform.organizations o ON o.id = i.org_id ORDER BY i.issued_on DESC LIMIT 500`);
    return { status: 200, body: { today: todayCT(), me: { name: s.name, role: s.role }, tenants: ts.map(({ id: _id, ...t }) => t), plans, flags, announcements: ann, settings, team: s.role === 'owner' ? team : { data: { staff: [] }, version: team.version }, support, audit: auditRows, invoices } };
  }
  if (method === 'POST' && path === '/platform/orgs') {
    allow(s, 'support');
    const p = P.NewOrgSchema.safeParse(b); if (!p.success) throw new HttpError(400, 'Some answers need a fix.', issues(p.error)); const d = p.data;
    const taken = ((await rows(db, PLATFORM, 'SELECT slug FROM platform.organizations UNION SELECT slug::text FROM platform.reserved_slugs')) as { slug: string }[]).map((r) => r.slug);
    const prob = P.slugProblem(d.slug, taken); if (prob) throw new HttpError(409, prob, [{ path: 'slug', message: prob }]);
    const plans = (await panelDoc<P.PlansDoc>(db, 'plans')).data; const plan = plans.plans.find((x) => x.id === d.planId && !x.hidden);
    if (!plan) throw new HttpError(400, 'Choose one of the plans on offer.', [{ path: 'planId', message: 'Choose a plan.' }]);
    const starter = await starterDocs(d.owner);
    const org = (await one<{ id: string; client_no: number }>(db, PLATFORM, `INSERT INTO platform.organizations (slug, name, short_name, type, city, state, address, phone, email, color, status, plan, billing_cycle, trial_ends_on, template, member_prefix)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULLIF($14, '')::date, $15, $16) RETURNING id::text, client_no`,
      [d.slug, d.name, d.shortName, d.type, d.city, d.state, d.address, d.phone, d.email.toLowerCase(), d.color, d.trial ? 'trial' : 'active', plan.id, d.cycle, d.trial ? addDays(todayCT(), plans.trialDays) : '', d.template, memberPrefix(d.shortName, d.slug)]))!;
    const mods = Object.entries(d.modules).filter(([k]) => !P.CORE_MODULES.includes(k as P.Module));
    if (mods.length) await db.run(PLATFORM, mods.map(([k, v]) => ({ sql: 'INSERT INTO platform.org_modules (org_id, module, value) VALUES ($1::uuid, $2, $3)', params: [org.id, k, v] })));
    for (const [key, data] of starter) await saveDocument(db, org.id, key, data, s.name, 'Starter content');
    const link = await invite(db, s, org.id, { slug: d.slug, name: d.name }, { ...d.owner, role: 'owner' });
    await audit(db, s, 'org.created', org.id, `${d.name} joined as client #${org.client_no} on ${plan.name}${d.trial ? ` (${plans.trialDays}-day trial)` : ''}; owner ${d.owner.name} <${d.owner.email}> invited`);
    return { status: 201, body: { tenant: await tenant(db, d.slug), invite: link } };
  }
  if (method === 'POST' && (m = path.match(/^\/platform\/orgs\/([a-z0-9-]{3,30})\/actions$/))) return { status: 200, body: await act(db, s, m[1], b) };
  if ((m = path.match(/^\/platform\/docs\/(plans|flags|announcements|settings|team)$/))) {
    const key = m[1] as DocKey;
    if (method === 'GET') { const d = await panelDoc(db, key); if (key === 'team' && s.role !== 'owner') throw new HttpError(403, 'Only the platform owner sees the team.'); return { status: 200, body: d }; }
    if (method === 'PUT') {
      if (key === 'team' || key === 'plans' || key === 'settings') allow(s); else allow(s, 'support');
      const parsed = DOCS[key].schema.safeParse(b?.data); if (!parsed.success) throw new HttpError(400, 'The document has problems.', issues(parsed.error));
      const version = await savePanelDoc(db, key, parsed.data, s.name, Number(b?.baseVersion ?? -2));
      await audit(db, s, `doc.${key}`, null, `Saved ${key} v${version}`);
      return { status: 200, body: { key, version } };
    }
  }
  if (method === 'POST' && (m = path.match(/^\/platform\/invoices\/([A-Za-z0-9_-]+)$/))) {
    allow(s, 'billing'); const to = String(b?.status ?? '');
    if (!['paid', 'void', 'retry'].includes(to)) throw new HttpError(400, 'status: paid, void or retry.');
    const inv = await one<{ org_id: string; status: string; amount_cents: number }>(db, PLATFORM, 'SELECT org_id::text, status, amount_cents FROM platform.invoices WHERE id = $1', [m[1]]); if (!inv) throw new HttpError(404, 'No such invoice.');
    if (inv.status === 'paid' || inv.status === 'void') throw new HttpError(409, `This invoice is already ${inv.status}.`);
    if (to === 'retry' && process.env.PAYMENTS_PROVIDER === 'stripe') throw new HttpError(501, 'Card retries go through Stripe Billing (not connected yet).');
    await db.run(PLATFORM, [{ sql: `UPDATE platform.invoices SET status = $2, method = CASE WHEN $3 = 'paid' THEN 'check or bank' ELSE method END WHERE id = $1`, params: [m[1], to === 'void' ? 'void' : 'paid', to] },
      { sql: `UPDATE platform.organizations SET status = 'active' WHERE id = $1::uuid AND status = 'past_due' AND NOT EXISTS (SELECT 1 FROM platform.invoices WHERE org_id = $1::uuid AND status = 'failed')`, params: [inv.org_id] }]);
    await audit(db, s, `invoice.${to}`, inv.org_id, `${m[1]} (${(inv.amount_cents / 100).toFixed(2)} USD)`);
    return { status: 200, body: { id: m[1], status: to === 'void' ? 'void' : 'paid' } };
  }
  throw new HttpError(404, `No route ${method} ${path}.`);
}

/* ---------------- the organization side ---------------- */
export const ORG_PLATFORM_ROUTES: Route[] = [
  route('GET', /^\/admin\/platform\/me$/, async (ctx) => {
    if (!ctx.me) throw new HttpError(401, 'Sign in.');
    const t = await tenant(ctx.db, ctx.slug); const [plans, flags, ann, settings] = await Promise.all([panelDoc<P.PlansDoc>(ctx.db, 'plans'), panelDoc<{ flags: P.Flag[] }>(ctx.db, 'flags'), panelDoc<{ items: P.Announcement[] }>(ctx.db, 'announcements'), panelDoc<P.PlatformSettings>(ctx.db, 'settings')]);
    const today = todayCT();
    const support = await one<{ by: string; mode: string; ends_at: string; reason: string }>(ctx.db, PLATFORM, `SELECT coalesce(NULLIF(u.name, ''), u.email) AS by, s.mode, s.ends_at::text, s.reason FROM platform.support_sessions s JOIN platform.staff st ON st.id = s.staff_id JOIN platform.users u ON u.id = st.user_id WHERE s.org_id = $1::uuid AND s.ended_at IS NULL AND s.ends_at > now() ORDER BY s.started_at DESC LIMIT 1`, [ctx.orgId]);
    return { status: 200, body: { productName: settings.data.productName, supportEmail: settings.data.supportEmail,
      org: { slug: t.slug, name: t.name, shortName: t.shortName, status: t.status, color: t.color, plan: P.planOf(plans.data, t.planId).name, trialDaysLeft: t.trialEndsOn ? Math.max(0, Math.round((Date.parse(t.trialEndsOn) - Date.parse(today)) / 86_400_000)) : null, suspendedReason: t.suspendedReason ?? null },
      modules: P.effectiveModules(t, plans.data, flags.data.flags),
      announcements: ann.data.items.filter((a) => a.active && a.startsOn <= today && a.endsOn >= today && (a.audience === 'all' || (a.audience === 'plans' && a.ids.includes(t.planId)) || (a.audience === 'orgs' && a.ids.includes(t.slug)))).map(({ ids: _i, ...a }) => a),
      support: support ? { by: support.by, mode: support.mode, until: support.ends_at, reason: support.reason } : null,
      // the website: a verified own domain, else the founding organization's own address (legacy_web_host), else <slug>.<base domain>
      siteUrl: process.env.PUBLIC_SITE_URL ?? `https://${t.customDomain?.status === 'verified' ? t.customDomain.host : (await one<{ h: string }>(ctx.db, PLATFORM, 'SELECT legacy_web_host::text AS h FROM platform.organizations WHERE slug = $1', [t.slug]))?.h || `${t.slug}.${settings.data.baseDomain}`}`,
      you: { name: ctx.me.name, support: ctx.me.id === 'platform-support', readOnly: !!ctx.readOnly } } };
  }),
  route('GET', /^\/auth\/invitations\/([A-Za-z0-9_-]{30,60})$/, async (ctx, mm) => {
    const i = await one<{ email: string; name: string; role: P.Role }>(ctx.db, PLATFORM, `SELECT email::text, name, role FROM platform.invitations WHERE token_hash = decode($1, 'hex') AND org_id = $2::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [sha256hex(mm[1]), ctx.orgId]);
    if (!i) throw new HttpError(404, 'This invitation link does not work any more – ask for a new one.');
    const org = await one<{ name: string }>(ctx.db, PLATFORM, 'SELECT name FROM platform.organizations WHERE id = $1::uuid', [ctx.orgId]);
    const has = await one(ctx.db, PLATFORM, 'SELECT 1 AS x FROM platform.passwords p JOIN platform.users u ON u.id = p.user_id WHERE u.email = $1', [i.email]);
    return { status: 200, body: { organization: org?.name, email: i.email, name: i.name, role: P.ROLE_INFO[i.role].label, needsPassword: !has } };
  }),
  route('POST', /^\/auth\/invitations\/([A-Za-z0-9_-]{30,60})\/accept$/, async (ctx, mm) => {
    const i = await one<{ id: string; email: string; name: string; role: P.Role; org_user_id: string }>(ctx.db, PLATFORM, `SELECT id::text, email::text, name, role, org_user_id::text FROM platform.invitations WHERE token_hash = decode($1, 'hex') AND org_id = $2::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [sha256hex(mm[1]), ctx.orgId]);
    if (!i) throw new HttpError(404, 'This invitation link does not work any more – ask for a new one.');
    const b = (ctx.req.body ?? {}) as Record<string, string>; const pw = String(b.password ?? '');
    const u = (await one<{ id: string }>(ctx.db, PLATFORM, 'SELECT id::text FROM platform.users WHERE email = $1', [i.email]))!;
    const existing = await one<{ hash: string }>(ctx.db, PLATFORM, 'SELECT hash FROM platform.passwords WHERE user_id = $1::uuid', [u.id]);
    if (!existing) { const why = passwordProblem(pw, i.email); if (why) throw new HttpError(400, why); }
    await ctx.db.run(PLATFORM, [
      ...(existing ? [] : [{ sql: 'INSERT INTO platform.passwords (user_id, hash) VALUES ($1::uuid, $2)', params: [u.id, hashPassword(pw)] }]),
      { sql: `UPDATE platform.users SET name = coalesce(NULLIF($2, ''), name) WHERE id = $1::uuid`, params: [u.id, String(b.name ?? '').trim().slice(0, 80)] },
      { sql: `UPDATE platform.invitations SET accepted_at = now() WHERE id = $1::uuid`, params: [i.id] },
      { sql: `UPDATE platform.org_admin_users SET status = 'active', last_active_on = current_date WHERE id = $1::uuid`, params: [i.org_user_id] }]);
    const doc = AccessSchema.parse(await document(ctx.db, ctx.orgId, 'admin-access'));
    await saveDocument(ctx.db, ctx.orgId, 'admin-access', { ...doc, admins: doc.admins.map((a) => (a.email.toLowerCase() === i.email.toLowerCase() ? { ...a, status: 'active' as const, name: String(b.name ?? '').trim() || a.name } : a)) }, i.email, 'Invitation accepted');
    await audit(ctx.db, i.email, 'org.invitation-accepted', ctx.orgId, `${i.email} as ${P.ROLE_INFO[i.role].label}`);
    return { status: 200, body: { accepted: true, email: i.email, next: 'Sign in with your email.' } };
  }),
  route('POST', /^\/auth\/support$/, async (ctx) => {
    const token = String(((ctx.req.body ?? {}) as Record<string, string>).token ?? '');
    const s = await one<{ id: string; user_id: string; mode: string; minutes: number }>(ctx.db, PLATFORM, `UPDATE platform.support_sessions s SET used_at = now() FROM platform.staff st WHERE st.id = s.staff_id AND s.token_hash = decode($1, 'hex') AND s.org_id = $2::uuid AND s.used_at IS NULL AND s.ended_at IS NULL AND s.ends_at > now()
      RETURNING s.id::text, st.user_id::text, s.mode, greatest(1, extract(epoch FROM s.ends_at - now())::int / 60) AS minutes`, [sha256hex(token), ctx.orgId]);
    if (!s) throw new HttpError(404, 'This support link does not work (used, ended or for another organization).');
    const t = newToken();
    await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.sessions (id, user_id, org_id, kind, admin_id, two_step_ok, support_session_id, read_only, idle_minutes, expires_at) VALUES (decode($1, 'hex'), $2::uuid, $3::uuid, 'admin', 'platform-support', true, $4::uuid, $5::boolean, 30, now() + make_interval(mins => $6::int))`,
      params: [sha256hex(t), s.user_id, ctx.orgId, s.id, s.mode !== 'full', s.minutes] }]);
    await audit(ctx.db, 'support', 'support.opened', ctx.orgId, `${s.mode} support session opened`);
    return { status: 200, headers: { 'set-cookie': cookie(t, s.minutes * 60) }, body: { signedIn: true, mode: s.mode } };
  }),
];
void (null as unknown as Ctx);
