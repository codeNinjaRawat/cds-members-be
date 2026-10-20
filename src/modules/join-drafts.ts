/**
 * Join form drafts – nothing a person types is lost, and the office sees who stopped half way.
 * The moment an email is proven (join code), that person has a record: a member row with joinStage 'incomplete'
 * (the same shape as an imported contact who never finished). Every answer after that is saved on it as they type:
 * the known fields go to their columns (name, phone, birth date, address, plan) and the whole form is kept in
 * record.join.draft. Submitting turns the same record into the application – no second record, no member number lost.
 *
 *   PUT  /public/join/draft {resumeToken, step, data}   autosave (the website calls it after every change, debounced)
 *   GET  /public/join/draft/:token                      open a saved application (link from the email) → answers + joinToken
 *   POST /public/join/draft/link {resumeToken}          email "finish your application" with the link (30 days)
 *   POST /public/join/check {resumeToken, firstName, lastName, dob, phone}   yes/no: same person / phone already on file
 *   POST /admin/members/:id/join-reminder               the office sends that link again (and may copy it to text it)
 *
 * The resume token is a login_codes row (purpose 'join-resume', 30 days, kept until the application is sent); only its
 * sha-256 is stored. Having the link = having the email that received it, so it also proves the email at submit.
 */
import { one, type Db } from '../db/sql.js';
import { HttpError, PLATFORM, need, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { newToken, sha256hex } from '../auth/crypto.js';

export const RESUME_DAYS = 30;
const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const MAX_DRAFT = 60_000;   // characters of JSON – a whole join form is far smaller; pictures are never kept here

/** The organization's website address for links in emails: the address the visitor is on (website calls), else the
 *  organization's own website (founding organization's address, else <slug>.<base domain>) – never the admin's address. */
export async function siteOf(ctx: Ctx): Promise<string> {
  if (process.env.PUBLIC_SITE_URL) return process.env.PUBLIC_SITE_URL.replace(/\/$/, '');
  const h = String(ctx.req?.headers?.['x-org-host'] ?? '').trim().toLowerCase();
  if (String(ctx.req?.path ?? '').startsWith('/public/') && h && /^[a-z0-9.-]+(:\d+)?$/.test(h)) return `${/^(localhost|127\.|[a-z0-9-]+\.localhost)/.test(h) ? 'http' : 'https'}://${h}`;
  const r = await one<{ h: string | null }>(ctx.db, PLATFORM, 'SELECT legacy_web_host::text AS h FROM platform.organizations WHERE id = $1::uuid', [ctx.orgId]);
  return `https://${r?.h || `${ctx.slug}.${process.env.BASE_DOMAIN ?? 'nextgrow.pro'}`}`;
}
export const resumeLink = async (ctx: Ctx, token: string) => `${await siteOf(ctx)}/membership/join?resume=${encodeURIComponent(token)}`;

export async function newResumeToken(db: Db, orgId: string, email: string): Promise<string> {
  const t = newToken();
  await db.run(PLATFORM, [{ sql: `INSERT INTO platform.login_codes (org_id, channel, address, purpose, code_hash, expires_at) VALUES ($1, 'email', $2, 'join-resume', decode($3, 'hex'), now() + make_interval(days => $4::int))`, params: [orgId, email, sha256hex(t), RESUME_DAYS] }]);
  return t;
}
/** The email a resume token belongs to (null = unknown, expired or already used for a sent application). */
export async function emailOfResume(ctx: Ctx, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(token)) return null;
  const r = await one<{ address: string }>(ctx.db, PLATFORM, `SELECT address::text FROM platform.login_codes WHERE purpose = 'join-resume' AND org_id = $1 AND used_at IS NULL AND expires_at > now() AND code_hash = decode($2, 'hex')`, [ctx.orgId, sha256hex(token)]);
  return r?.address.toLowerCase() ?? null;
}
type DraftRow = { id: string; email: string; first_name: string; middle_name: string; last_name: string; preferred_name: string; phone: string; dob: string | null; street: string; city: string; state: string; zip: string; plan: string; join: Record<string, unknown> | null };
const DRAFT_SQL = `SELECT id, email::text, first_name, middle_name, last_name, preferred_name, phone, dob::text, street, city, state, zip, plan, record->'join' AS join
  FROM app.members WHERE lower(email) = $1 AND archived IS NULL AND status = 'pending' AND approved_on IS NULL AND record->>'joinStage' = 'incomplete' ORDER BY created_at DESC LIMIT 1`;
export const unfinishedOf = (ctx: Ctx, email: string) => one<DraftRow>(ctx.db, API(ctx), DRAFT_SQL, [email]);

/** What the form starts with for an unfinished record: the saved draft, else what the record already knows (imports). */
export function prefillOf(r: DraftRow): Record<string, unknown> {
  const saved = (r.join?.draft ?? null) as Record<string, unknown> | null;
  if (saved && typeof saved === 'object') return saved;
  const about: Record<string, string> = {};
  const put = (k: string, v: string | null) => { if (v && String(v).trim()) about[k] = String(v).trim(); };
  put('firstName', r.first_name); put('middleName', r.middle_name); put('lastName', r.last_name); put('preferredName', r.preferred_name);
  put('phone', r.phone); put('dob', r.dob && !r.dob.startsWith('1900') ? r.dob.slice(0, 10) : ''); put('street', r.street); put('city', r.city); put('state', r.state); put('zip', r.zip);
  return Object.keys(about).length ? { about } : {};
}

/** A new person: the record exists from the moment the email is proven, so a stop on the next page is still seen. */
export async function startUnfinished(ctx: Ctx, email: string): Promise<string> {
  const today = todayCT();
  const id = (await one<{ id: string }>(ctx.db, API(ctx), `SELECT app.next_member_id($1::uuid, $2) AS id`, [ctx.orgId, ctx.slug.slice(0, 3).toUpperCase()]))!.id;
  await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.members (org_id, id, first_name, last_name, email, plan, joined_year, applied_on, source, record)
      VALUES ($1::uuid, $2, '', '', $3, '', $4::int, $5::date, 'website', $6::jsonb)`,
    params: [ctx.orgId, id, email, Number(today.slice(0, 4)), today, { joinStage: 'incomplete', join: { step: 'about', startedAt: new Date().toISOString(), lastSeen: new Date().toISOString(), reminders: 0 },
      audit: [{ at: new Date().toISOString(), by: 'Website', action: 'Started the join form', detail: 'Email verified' }] }] }]);
  return id;
}

/* ---------- the answers → the record's own columns (only well-formed values; the rest stays in the draft) ---------- */
const s = (v: unknown, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function columnsOf(data: Record<string, unknown>, planIds: string[]) {
  const a = (data.about && typeof data.about === 'object' ? data.about : {}) as Record<string, unknown>;
  const p = (data.plan && typeof data.plan === 'object' ? data.plan : {}) as Record<string, unknown>;
  const digits = s(a.phone, 30).replace(/\D/g, '').slice(-10);
  const dob = s(a.dob, 10);
  return {
    first: s(a.firstName, 60), middle: s(a.middleName, 60), last: s(a.lastName, 60), preferred: s(a.preferredName, 60),
    phone: digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : '',
    dob: /^\d{4}-\d{2}-\d{2}$/.test(dob) && !Number.isNaN(Date.parse(dob)) ? dob : '',
    street: [s(a.street, 120), s(a.unit, 30)].filter(Boolean).join(' '), city: s(a.city, 60), state: /^[A-Za-z]{2}$/.test(s(a.state, 2)) ? s(a.state, 2).toUpperCase() : '',
    zip: /^\d{5}/.test(s(a.zip, 10)) ? s(a.zip, 10).slice(0, 5) : '', plan: planIds.includes(s(p.planId, 40)) ? s(p.planId, 40) : '',
  };
}
/** Never keep pictures (photo ID, selfie) or codes in a draft – they have their own, safer places. */
function clean(v: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (typeof v === 'string') return v.startsWith('data:') || v.length > 4000 ? '' : v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/^(otp|code|joinToken|resumeToken|password|card|cvc|idImage|idPhoto|selfie)$/i.test(k)).map(([k, x]) => [k, clean(x, depth + 1)]));
  return v;
}

export async function saveDraft(ctx: Ctx, memberId: string, stepIn: unknown, dataIn: unknown, planIds: string[], progress: unknown = {}) {
  const data = clean(dataIn && typeof dataIn === 'object' ? dataIn : {}) as Record<string, unknown>;
  const json = JSON.stringify(data);
  if (json.length > MAX_DRAFT) throw new HttpError(413, 'The saved answers are too large.');
  const step = /^[a-z0-9:-]{1,50}$/.test(String(stepIn)) ? String(stepIn) : 'about';
  const pr = (progress && typeof progress === 'object' ? progress : {}) as Record<string, unknown>;
  const index = Number.isInteger(pr.index) ? Math.max(0, Math.min(30, Number(pr.index))) : 1;
  const total = Number.isInteger(pr.total) ? Math.max(1, Math.min(30, Number(pr.total))) : 6;
  const label = s(pr.label, 60) || step;
  const c = columnsOf(data, planIds);
  await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET
      first_name = CASE WHEN $3 <> '' THEN $3 ELSE first_name END, middle_name = CASE WHEN $4 <> '' THEN $4 ELSE middle_name END,
      last_name = CASE WHEN $5 <> '' THEN $5 ELSE last_name END, preferred_name = CASE WHEN $6 <> '' THEN $6 ELSE preferred_name END,
      phone = CASE WHEN $7 <> '' THEN $7 ELSE phone END, dob = coalesce(NULLIF($8, '')::date, dob),
      street = CASE WHEN $9 <> '' THEN $9 ELSE street END, city = CASE WHEN $10 <> '' THEN $10 ELSE city END,
      state = CASE WHEN $11 <> '' THEN $11 ELSE state END, zip = CASE WHEN $12 <> '' THEN $12 ELSE zip END, plan = CASE WHEN $13 <> '' THEN $13 ELSE plan END,
      record = jsonb_set(record, '{join}', coalesce(record->'join', '{}'::jsonb) || jsonb_build_object('step', $14::text, 'stepLabel', $16::text, 'lastSeen', now(), 'draft', $15::jsonb, 'total', $18::int,
        'furthest', CASE WHEN coalesce((record->'join'->>'furthestIndex')::int, -1) >= $17::int THEN record->'join'->'furthest' ELSE to_jsonb($16::text) END,
        'furthestIndex', greatest(coalesce((record->'join'->>'furthestIndex')::int, -1), $17::int)))
    WHERE org_id = $1::uuid AND id = $2 AND record->>'joinStage' = 'incomplete'`,
    params: [ctx.orgId, memberId, c.first, c.middle, c.last, c.preferred, c.phone, c.dob, c.street, c.city, c.state, c.zip, c.plan, step, json, label, index, total] }]);
  return { step };
}

async function orgName(ctx: Ctx) { return (await one<{ name: string }>(ctx.db, PLATFORM, 'SELECT name FROM platform.organizations WHERE id = $1::uuid', [ctx.orgId]))?.name ?? 'the organization'; }
export async function emailLink(ctx: Ctx, email: string, firstName: string, token: string, kind: 'join-link' | 'join-reminder') {
  const name = await orgName(ctx);
  const link = await resumeLink(ctx, token);
  await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, $5)`,
    params: [ctx.orgId, email, kind === 'join-link' ? `Finish your ${name} membership application` : `Your ${name} membership application is waiting`,
      `Assalamu alaikum${firstName ? ` ${firstName}` : ''},\n\n${kind === 'join-link' ? 'Your answers are saved.' : 'You started a membership application and your answers are saved.'} Open this link to pick up where you stopped:\n\n${link}\n\nThe link works for ${RESUME_DAYS} days. If you did not start an application, you can ignore this email.`, kind] }]);
  return link;
}
const planIdsOf = async (ctx: Ctx) => { const { MembershipSettingsSchema, mockMembershipSettings } = await import('@/lib/content/membership'); const { document } = await import('../http/core.js'); const p = MembershipSettingsSchema.safeParse(await document(ctx.db, ctx.orgId, 'membership-settings')); return (p.success ? p.data : mockMembershipSettings).plans.map((x) => x.id); };
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;

export const JOIN_DRAFT_ROUTES: Route[] = [
  route('PUT', /^\/public\/join\/draft$/, async (ctx) => {
    const b = body(ctx); const email = await emailOfResume(ctx, String(b.resumeToken ?? ''));
    if (!email) throw new HttpError(401, 'This saved application has expired. Verify your email again to continue – your answers are kept.', undefined, 'resume-expired');
    const r = await unfinishedOf(ctx, email);
    if (!r) throw new HttpError(409, 'This application was already sent.', undefined, 'already-sent');
    const saved = await saveDraft(ctx, r.id, b.step, b.data, await planIdsOf(ctx), b.progress);
    return { status: 200, body: { saved: true, step: saved.step, at: new Date().toISOString() } };
  }),
  // J1 – gentle existing-person check after "About you": only yes/no answers (never whose record), only for someone
  // whose email is proven (the saved-application link), and the answer is kept on their record for the office
  route('POST', /^\/public\/join\/check$/, async (ctx) => {
    const b = body(ctx); const email = await emailOfResume(ctx, String(b.resumeToken ?? ''));
    if (!email) throw new HttpError(401, 'Confirm your email first.', undefined, 'resume-expired');
    const first = s(b.firstName, 60).toLowerCase(), last = s(b.lastName, 60).toLowerCase(), dob = /^\d{4}-\d{2}-\d{2}$/.test(s(b.dob, 10)) ? s(b.dob, 10) : '';
    const phone = s(b.phone, 30).replace(/\D/g, '').slice(-10);
    const r = await one<{ person: boolean | null; phone: boolean | null }>(ctx.db, API(ctx), `SELECT
        bool_or($2 <> '' AND $3 <> '' AND $4 <> '' AND lower(first_name) = $2 AND lower(last_name) = $3 AND dob = NULLIF($4, '')::date) AS person,
        bool_or(length($5) = 10 AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = $5) AS phone
      FROM app.members WHERE archived IS NULL AND lower(email::text) <> $1 AND coalesce(record->>'joinStage', '') <> 'incomplete'`, [email, first, last, dob, phone]);
    const out = { possibleMember: !!r?.person, phoneOnFile: !!r?.phone };
    const me = await unfinishedOf(ctx, email);
    if (me) await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET record = jsonb_set(record, '{join}', coalesce(record->'join', '{}'::jsonb) || jsonb_build_object('checks', $3::jsonb)) WHERE org_id = $1::uuid AND id = $2`, params: [ctx.orgId, me.id, { ...out, at: new Date().toISOString(), notMe: b.notMe === true }] }]);
    return { status: 200, body: out };
  }),
  route('GET', /^\/public\/join\/draft\/([A-Za-z0-9_-]{30,80})$/, async (ctx, mm) => {
    const email = await emailOfResume(ctx, mm[1]);
    if (!email) throw new HttpError(404, 'This link has expired. Start again with your email – anything you saved is still there.', undefined, 'resume-expired');
    const r = await unfinishedOf(ctx, email);
    if (!r) throw new HttpError(409, 'This application was already sent – we will email you when it is reviewed.', undefined, 'already-sent');
    const joinToken = newToken();
    await ctx.db.run(PLATFORM, [{ sql: `INSERT INTO platform.login_codes (org_id, channel, address, purpose, code_hash, expires_at) VALUES ($1, 'email', $2, 'verify-email', decode($3, 'hex'), now() + interval '12 hours')`, params: [ctx.orgId, email, sha256hex(joinToken)] }]);
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET record = jsonb_set(record, '{join}', coalesce(record->'join', '{}'::jsonb) || jsonb_build_object('lastSeen', now())) WHERE org_id = $1::uuid AND id = $2`, params: [ctx.orgId, r.id] }]);
    return { status: 200, body: { email, joinToken, resumeToken: mm[1], step: String(r.join?.step ?? 'about'), data: prefillOf(r) } };
  }),
  route('POST', /^\/public\/join\/draft\/link$/, async (ctx) => {
    const token = String(body(ctx).resumeToken ?? ''); const email = await emailOfResume(ctx, token);
    if (!email) throw new HttpError(401, 'This saved application has expired. Verify your email again to continue – your answers are kept.', undefined, 'resume-expired');
    const recent = await one<{ n: number }>(ctx.db, PLATFORM, `SELECT count(*)::int AS n FROM platform.outbox WHERE org_id = $1 AND kind = 'join-link' AND to_address = $2 AND created_at > now() - interval '1 hour'`, [ctx.orgId, email]);
    if ((recent?.n ?? 0) >= 3) return { status: 200, body: { sent: false, message: 'We already emailed you the link a few times in the last hour – check your inbox and spam folder.' } };
    const r = await unfinishedOf(ctx, email);
    await emailLink(ctx, email, r?.first_name ?? '', token, 'join-link');
    return { status: 200, body: { sent: true, to: email } };
  }),
  route('POST', /^\/admin\/members\/([A-Za-z0-9-]+)\/join-reminder$/, async (ctx, mm) => {
    need(ctx, 'members.contact');
    const m = await one<{ id: string; email: string; first_name: string; stage: string }>(ctx.db, API(ctx), `SELECT id, email::text, first_name, coalesce(record->>'joinStage', '') AS stage FROM app.members WHERE id = $1 AND archived IS NULL`, [mm[1].toUpperCase()]);
    if (!m) throw new HttpError(404, 'No such member.');
    if (m.stage !== 'incomplete') throw new HttpError(409, 'This application is already finished.');
    if (!/@/.test(m.email)) throw new HttpError(409, 'There is no email address on this record – call them instead.');
    const token = await newResumeToken(ctx.db, ctx.orgId, m.email.toLowerCase());
    const link = await emailLink(ctx, m.email, m.first_name, token, 'join-reminder');
    const at = new Date().toISOString();
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.members SET record = jsonb_set(jsonb_set(record, '{join}', coalesce(record->'join', '{}'::jsonb) || jsonb_build_object('reminders', coalesce((record->'join'->>'reminders')::int, 0) + 1, 'lastReminded', $3::text)),
        '{audit}', coalesce(record->'audit', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', $3::text, 'by', $4::text, 'action', 'Reminder sent', 'detail', 'Link to finish the application emailed')))
      WHERE org_id = $1::uuid AND id = $2`, params: [ctx.orgId, m.id, at, ctx.me?.name ?? 'Office'] }]);
    return { status: 200, body: { sent: true, to: m.email, link } };
  }),
];
