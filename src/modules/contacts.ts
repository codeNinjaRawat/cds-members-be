/**
 * Contacts – people who use the member app as visitors of a masjid, without an account (0034).
 * The app asks first name, last name, email and mobile once (the "My masjid" tile); the answer is one row here, and
 * from then on the app starts donations, the join form and event registrations with those details filled in.
 *
 *   POST  /app/contacts            {masjidId, firstName, lastName, email, phone}  create or update (same email+mobile = same row)
 *   GET   /app/contacts/:id        the contact's own details (the id is a random uuid only that phone knows)
 *   PATCH /app/contacts/:id        change details or the masjid
 *   GET   /admin/contacts?q=&masjid=   the office's list (members.view); each row says whether a member record has that email
 *   PATCH /admin/contacts/:id      {note}  (members.edit)
 *   DELETE /admin/contacts/:id     (members.edit) – the person asked to be forgotten
 *
 * People (0036): everyone is a contact first; a contact may become a member and/or a donor – the same row, with
 * member_id / first_gift_at set. `touchPerson()` is called wherever a person shows up (join form, Add member, import,
 * a gift, an event registration) so the People list is always complete.
 *   GET   /admin/people?q=&kind=all|contacts|members|donors&masjid=   one row per person with stage, member and giving facts + the funnel
 *   GET   /admin/people/:id        one person: contact, member facts, gifts, registrations
 *   POST  /admin/contacts/:id/message  {subject, body}  an email to a contact who is not a member (comms.send)
 */
import { one, rows } from '../db/sql.js';
import { HttpError, audit, need, route, type Ctx, type Res, type Route } from '../http/core.js';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const ok = (b: unknown, status = 200): Res => ({ status, body: b });
const UUID = /^[0-9a-f-]{36}$/;
const PER_IP_15MIN = () => Number(process.env.CONTACTS_PER_IP ?? 30);

type Row = { id: string; masjid_id: string | null; first_name: string; last_name: string; email: string; phone: string; source: string; note: string; created_at: string; last_seen_at: string; member_id: string | null };
const SELECT = `SELECT c.id, k.code AS masjid_id, c.first_name, c.last_name, c.email::text, c.phone, c.source, c.note, to_json(c.created_at)#>>'{}' AS created_at, to_json(c.last_seen_at)#>>'{}' AS last_seen_at,
  (SELECT m.id FROM app.members m WHERE m.org_id = c.org_id AND lower(m.email::text) = lower(c.email::text) AND m.archived IS NULL ORDER BY m.approved_on DESC NULLS LAST LIMIT 1) AS member_id
  FROM app.contacts c LEFT JOIN app.centers k ON k.org_id = c.org_id AND k.id = c.center_id`;
const shape = (r: Row) => ({ contactId: r.id, masjidId: r.masjid_id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone, source: r.source, note: r.note, createdAt: r.created_at, lastSeenAt: r.last_seen_at, memberId: r.member_id });

/** The fields the app may send, checked; `partial` for PATCH (only what was sent). */
function fieldsOf(b: Record<string, unknown>, partial: boolean) {
  const s = (k: string, max: number) => (typeof b[k] === 'string' ? (b[k] as string).trim().slice(0, max) : undefined);
  const errors: Record<string, string> = {};
  const firstName = s('firstName', 60), lastName = s('lastName', 60), email = s('email', 120)?.toLowerCase(), phoneRaw = s('phone', 30);
  const phone = phoneRaw === undefined ? undefined : phoneRaw.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  if ((!partial || firstName !== undefined) && !(firstName && firstName.length >= 2)) errors.firstName = 'Enter your first name.';
  if ((!partial || lastName !== undefined) && !(lastName && lastName.length >= 2)) errors.lastName = 'Enter your last name.';
  if ((!partial || email !== undefined) && !(email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))) errors.email = 'Enter a valid email address.';
  if ((!partial || phone !== undefined) && !(phone && phone.length === 10)) errors.phone = 'Enter a 10-digit US mobile number.';
  if (Object.keys(errors).length) throw new HttpError(422, Object.values(errors)[0]!, errors);
  return { firstName, lastName, email, phone, masjidId: s('masjidId', 40) };
}
async function centerOf(ctx: Ctx, code: string | undefined): Promise<string | null | undefined> {
  if (code === undefined) return undefined;
  if (!code) return null;
  const c = await one<{ id: string }>(ctx.db, API(ctx), 'SELECT id FROM app.centers WHERE code = $1 AND active', [code]);
  if (!c) throw new HttpError(422, 'Choose a masjid from the list.', { masjidId: 'Choose a masjid from the list.' });
  return c.id;
}
async function load(ctx: Ctx, id: string): Promise<Row> {
  if (!UUID.test(id)) throw new HttpError(404, 'No such contact.');
  const r = await one<Row>(ctx.db, API(ctx), `${SELECT} WHERE c.id = $1::uuid`, [id]);
  if (!r) throw new HttpError(404, 'No such contact.');
  return r;
}

export const CONTACT_ROUTES: Route[] = [
  route('POST', /^\/app\/contacts$/, async (ctx) => {
    const f = fieldsOf(body(ctx), false);
    const ip = ctx.req.ip ?? '';
    if (ip) {
      const n = await one<{ n: number }>(ctx.db, API(ctx), `SELECT count(*)::int AS n FROM app.contacts WHERE ip = $1 AND created_at > now() - interval '15 minutes'`, [ip]);
      if ((n?.n ?? 0) >= PER_IP_15MIN()) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.', undefined, 'rate');
    }
    const centerId = (await centerOf(ctx, f.masjidId)) ?? null;
    const r = await one<{ id: string }>(ctx.db, API(ctx), `INSERT INTO app.contacts (org_id, center_id, first_name, last_name, email, phone, source, ip)
        VALUES ($1::uuid, NULLIF($2, '')::uuid, $3, $4, $5, $6, 'app', $7)
        ON CONFLICT (org_id, lower(email::text), phone) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, center_id = coalesce(EXCLUDED.center_id, app.contacts.center_id), last_seen_at = now()
        RETURNING id`, [ctx.orgId, centerId ?? '', f.firstName, f.lastName, f.email, f.phone, ip]);
    return ok(shape(await load(ctx, r!.id)), 201);
  }),
  route('GET', /^\/app\/contacts\/([0-9a-f-]{36})$/, async (ctx, mm) => ok(shape(await load(ctx, mm[1]!)))),
  route('PATCH', /^\/app\/contacts\/([0-9a-f-]{36})$/, async (ctx, mm) => {
    const cur = await load(ctx, mm[1]!);
    const f = fieldsOf(body(ctx), true);
    const centerId = await centerOf(ctx, f.masjidId);
    const dup = f.email !== undefined || f.phone !== undefined
      ? await one<{ id: string }>(ctx.db, API(ctx), `SELECT id FROM app.contacts WHERE lower(email::text) = $1 AND phone = $2 AND id <> $3::uuid`, [f.email ?? cur.email.toLowerCase(), f.phone ?? cur.phone, cur.id]) : null;
    if (dup) throw new HttpError(409, 'Those details already belong to another contact.', { email: 'Already used.' });
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.contacts SET first_name = coalesce(NULLIF($2, ''), first_name), last_name = coalesce(NULLIF($3, ''), last_name), email = coalesce(NULLIF($4, ''), email), phone = coalesce(NULLIF($5, ''), phone),
        center_id = CASE WHEN $6::boolean THEN NULLIF($7, '')::uuid ELSE center_id END, last_seen_at = now() WHERE id = $1::uuid`,
      params: [cur.id, f.firstName ?? '', f.lastName ?? '', f.email ?? '', f.phone ?? '', centerId !== undefined, centerId ?? ''] }]);
    return ok(shape(await load(ctx, cur.id)));
  }),

  route('GET', /^\/admin\/contacts$/, async (ctx) => {
    need(ctx, 'members.view');
    const q = (ctx.req.query.get('q') ?? '').trim().toLowerCase(); const masjid = (ctx.req.query.get('masjid') ?? '').trim();
    const list = await rows(ctx.db, API(ctx), `${SELECT} WHERE ($1 = '' OR lower(c.first_name || ' ' || c.last_name || ' ' || c.email::text || ' ' || c.phone) LIKE '%' || $1 || '%') AND ($2 = '' OR k.code = $2)
      ORDER BY c.created_at DESC LIMIT 2000`, [q, masjid]) as Row[];
    return ok({ contacts: list.map(shape), total: list.length });
  }),
  route('PATCH', /^\/admin\/contacts\/([0-9a-f-]{36})$/, async (ctx, mm) => {
    need(ctx, 'members.edit');
    const cur = await load(ctx, mm[1]!); const note = typeof body(ctx).note === 'string' ? (body(ctx).note as string).slice(0, 2000) : cur.note;
    await ctx.db.run(API(ctx), [{ sql: 'UPDATE app.contacts SET note = $2 WHERE id = $1::uuid', params: [cur.id, note] }]);
    await audit(ctx, 'members', 'Contact note changed', `${cur.first_name} ${cur.last_name}`, cur.id);
    return ok(shape(await load(ctx, cur.id)));
  }),
  route('DELETE', /^\/admin\/contacts\/([0-9a-f-]{36})$/, async (ctx, mm) => {
    need(ctx, 'members.edit');
    const cur = await load(ctx, mm[1]!);
    await ctx.db.run(API(ctx), [{ sql: 'DELETE FROM app.contacts WHERE id = $1::uuid', params: [cur.id] }]);
    await audit(ctx, 'members', 'Contact removed', `${cur.first_name} ${cur.last_name} · ${cur.email}`, cur.id);
    return ok({ ok: true });
  }),
];


/* ---------- People ---------- */
export type PersonTouch = { firstName: string; lastName: string; email: string; phone?: string; source: 'app' | 'website' | 'office' | 'import' | 'member' | 'donation' | 'event'; centerId?: string | null; memberId?: string | null; gaveAt?: string | null };
/** A person showed up (joined, was added, gave, registered): make sure they have a contact row and that it knows what
 *  they became. Never throws – a problem here must not stop the thing the person was doing. */
export async function touchPerson(ctx: Pick<Ctx, 'db' | 'orgId'>, p: PersonTouch): Promise<void> {
  const email = p.email.trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return;
  const phone = (p.phone ?? '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  const first = p.firstName.trim().slice(0, 60) || 'Friend', last = p.lastName.trim().slice(0, 60);
  try {
    const api = { org: ctx.orgId, role: 'app_api' as const };
    const cur = await one<{ id: string; phone: string }>(ctx.db, api, `SELECT id, phone FROM app.contacts WHERE lower(email::text) = $1 ORDER BY (phone = $2 AND $2 <> '') DESC, last_seen_at DESC LIMIT 1`, [email, phone]);
    if (cur) {
      await ctx.db.run(api, [{ sql: `UPDATE app.contacts SET first_name = CASE WHEN first_name IN ('', 'Friend', 'Donor') THEN $2 ELSE first_name END, last_name = CASE WHEN last_name = '' THEN $3 ELSE last_name END,
          phone = CASE WHEN phone = '' THEN $4 ELSE phone END, center_id = coalesce(center_id, NULLIF($5, '')::uuid), member_id = coalesce(member_id, NULLIF($6, '')), became_member_at = coalesce(became_member_at, CASE WHEN NULLIF($6, '') IS NULL THEN NULL ELSE now() END),
          first_gift_at = coalesce(first_gift_at, NULLIF($7, '')::timestamptz), last_seen_at = now() WHERE id = $1::uuid`, params: [cur.id, first, last, phone, p.centerId ?? '', p.memberId ?? '', p.gaveAt ?? ''] }]);
    } else {
      await ctx.db.run(api, [{ sql: `INSERT INTO app.contacts (org_id, center_id, first_name, last_name, email, phone, source, member_id, became_member_at, first_gift_at)
          VALUES ($1::uuid, NULLIF($2, '')::uuid, $3, $4, $5, $6, $7, NULLIF($8, ''), CASE WHEN NULLIF($8, '') IS NULL THEN NULL ELSE now() END, NULLIF($9, '')::timestamptz) ON CONFLICT DO NOTHING`, params: [ctx.orgId, p.centerId ?? '', first, last, email, phone, p.source, p.memberId ?? '', p.gaveAt ?? ''] }]);
    }
  } catch (e) { console.warn('[people] touchPerson skipped:', (e as Error).message); }
}

/** The join form starts with what the person already told us as a contact (app / event / gift): name and mobile. */
export async function contactPrefill(ctx: Pick<Ctx, 'db' | 'orgId'>, email: string): Promise<Record<string, unknown>> {
  const c = await one<{ first_name: string; last_name: string; phone: string }>(ctx.db, { org: ctx.orgId, role: 'app_api' }, `SELECT first_name, last_name, phone FROM app.contacts WHERE lower(email::text) = $1 ORDER BY last_seen_at DESC LIMIT 1`, [email.toLowerCase()]).catch(() => null);
  if (!c || c.first_name === 'Friend' || c.first_name === 'Donor') return {};
  const about: Record<string, string> = { firstName: c.first_name, lastName: c.last_name };
  if (c.phone.length === 10) about.phone = `(${c.phone.slice(0, 3)}) ${c.phone.slice(3, 6)}-${c.phone.slice(6)}`;
  return { about };
}

type PersonRow = Row & { member_status: string | null; member_plan: string | null; approved_on: string | null; gifts_count: number; gifts_cents: number; last_gift_on: string | null; events_count: number; tags: string[]; became_member_at: string | null; first_gift_at: string | null };
const PEOPLE_SELECT = `SELECT c.id, k.code AS masjid_id, c.first_name, c.last_name, c.email::text, c.phone, c.source, c.note, c.tags, to_json(c.created_at)#>>'{}' AS created_at, to_json(c.last_seen_at)#>>'{}' AS last_seen_at,
    to_json(c.became_member_at)#>>'{}' AS became_member_at, to_json(c.first_gift_at)#>>'{}' AS first_gift_at,
    m.id AS member_id, m.status AS member_status, m.plan AS member_plan, m.approved_on::text AS approved_on,
    coalesce(g.n, 0)::int AS gifts_count, coalesce(g.cents, 0)::bigint AS gifts_cents, g.last::text AS last_gift_on,
    coalesce(e.n, 0)::int AS events_count
  FROM app.contacts c
  LEFT JOIN app.centers k ON k.org_id = c.org_id AND k.id = c.center_id
  LEFT JOIN LATERAL (SELECT m.id, m.status, m.plan, m.approved_on FROM app.members m WHERE m.org_id = c.org_id AND m.archived IS NULL AND coalesce(m.record->>'joinStage', '') <> 'incomplete' AND (m.id = c.member_id OR lower(m.email::text) = lower(c.email::text)) ORDER BY (m.id = c.member_id) DESC, m.approved_on DESC NULLS LAST LIMIT 1) m ON true
  LEFT JOIN LATERAL (SELECT count(*) AS n, sum(d.amount_cents) AS cents, max(d.given_on) AS last FROM app.donations d WHERE d.org_id = c.org_id AND d.state IN ('ok', 'awaiting-payout') AND (lower(d.donor_email::text) = lower(c.email::text) OR (m.id IS NOT NULL AND d.member_id = m.id))) g ON true
  LEFT JOIN LATERAL (SELECT count(*) AS n FROM app.registrations r WHERE r.org_id = c.org_id AND lower(r.email::text) = lower(c.email::text)) e ON true`;
/** contact → applicant (applied, not approved yet) → member; donor is on top of any of them */
const stageOf = (r: PersonRow) => { const m = r.member_id ? (r.approved_on ? 'member' : 'applicant') : ''; return m && r.gifts_count > 0 ? `${m}+donor` : m || (r.gifts_count > 0 ? 'donor' : 'contact'); };
const person = (r: PersonRow) => ({ ...shape(r), tags: r.tags ?? [], stage: stageOf(r), becameMemberAt: r.became_member_at, firstGiftAt: r.first_gift_at,
  member: r.member_id ? { id: r.member_id, status: r.member_status, plan: r.member_plan, approvedOn: r.approved_on } : null,
  giving: { count: r.gifts_count, cents: Number(r.gifts_cents), lastOn: r.last_gift_on }, events: r.events_count });

export const PEOPLE_ROUTES: Route[] = [
  route('GET', /^\/admin\/people$/, async (ctx) => {
    need(ctx, 'members.view');
    const q = (ctx.req.query.get('q') ?? '').trim().toLowerCase(); const masjid = (ctx.req.query.get('masjid') ?? '').trim(); const kind = ctx.req.query.get('kind') ?? 'all';
    const list = (await rows(ctx.db, API(ctx), `${PEOPLE_SELECT} WHERE ($1 = '' OR lower(c.first_name || ' ' || c.last_name || ' ' || c.email::text || ' ' || c.phone) LIKE '%' || $1 || '%') AND ($2 = '' OR k.code = $2)
      ORDER BY c.last_seen_at DESC LIMIT 5000`, [q, masjid])) as PersonRow[];
    const people = list.map(person).filter((p) => kind === 'all' || (kind === 'contacts' ? p.stage === 'contact' : kind === 'members' ? p.stage.startsWith('member') : kind === 'applicants' ? p.stage.startsWith('applicant') : kind === 'donors' ? p.giving.count > 0 : true));
    const all = list.map(stageOf);
    const funnel = { people: all.length, contacts: all.filter((s) => s === 'contact').length, applicants: all.filter((s) => s.startsWith('applicant')).length, members: all.filter((s) => s.startsWith('member')).length, donors: all.filter((s) => s.endsWith('donor')).length, both: all.filter((s) => s === 'member+donor').length };
    return ok({ people, total: people.length, funnel });
  }),
  route('GET', /^\/admin\/people\/([0-9a-f-]{36})$/, async (ctx, mm) => {
    need(ctx, 'members.view');
    const r = (await one<PersonRow>(ctx.db, API(ctx), `${PEOPLE_SELECT} WHERE c.id = $1::uuid`, [mm[1]!])); if (!r) throw new HttpError(404, 'No such person.');
    const gifts = await rows(ctx.db, API(ctx), `SELECT d.id, d.given_on::text AS given_on, d.amount_cents::int AS amount_cents, d.method, f.name AS fund FROM app.donations d LEFT JOIN app.funds f ON f.org_id = d.org_id AND f.id = d.fund_id
      WHERE d.org_id = $1::uuid AND d.state IN ('ok', 'awaiting-payout') AND (lower(d.donor_email::text) = $2 OR ($3 <> '' AND d.member_id = $3)) ORDER BY d.given_on DESC LIMIT 20`, [ctx.orgId, r.email.toLowerCase(), r.member_id ?? '']);
    const regs = await rows(ctx.db, API(ctx), `SELECT r.id, r.status, ev.title, ev.starts_at::text AS starts_at FROM app.registrations r JOIN app.events ev ON ev.org_id = r.org_id AND ev.id = r.event_id WHERE r.org_id = $1::uuid AND lower(r.email::text) = $2 ORDER BY ev.starts_at DESC LIMIT 20`, [ctx.orgId, r.email.toLowerCase()]).catch(() => []);
    return ok({ ...person(r), gifts, registrations: regs });
  }),
  route('PATCH', /^\/admin\/people\/([0-9a-f-]{36})$/, async (ctx, mm) => {
    need(ctx, 'members.edit');
    const cur = await load(ctx, mm[1]!); const b = body(ctx);
    const tags = Array.isArray(b.tags) ? Array.from(new Set(b.tags.map((t) => String(t).trim().slice(0, 30)).filter(Boolean))).slice(0, 20) : undefined;
    const note = typeof b.note === 'string' ? (b.note as string).slice(0, 2000) : undefined;
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.contacts SET tags = CASE WHEN $2 = '' THEN tags ELSE ARRAY(SELECT jsonb_array_elements_text($2::jsonb)) END, note = CASE WHEN $3 = '' THEN note ELSE $3 END WHERE id = $1::uuid`, params: [cur.id, tags ? JSON.stringify(tags) : '', note ?? ''] }]);
    const r = (await one<PersonRow>(ctx.db, API(ctx), `${PEOPLE_SELECT} WHERE c.id = $1::uuid`, [cur.id]))!;
    return ok(person(r));
  }),
  route('POST', /^\/admin\/contacts\/([0-9a-f-]{36})\/message$/, async (ctx, mm) => {
    need(ctx, 'comms.send');
    const cur = await load(ctx, mm[1]!); const b = body(ctx);
    const subject = String(b.subject ?? '').trim().slice(0, 150), text = String(b.body ?? '').trim().slice(0, 10_000);
    if (!subject || !text) throw new HttpError(422, 'Write a subject and the message.');
    await ctx.db.run({ org: null, role: 'owner' }, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind, ref) VALUES ($1, 'email', $2, $3, $4, 'contact', $5)`, params: [ctx.orgId, cur.email.toLowerCase(), subject, `${text}\n\n— ${ctx.me?.name ?? 'The office'}`, `contact:${cur.id}`] }]);
    await audit(ctx, 'members', 'Contact emailed', `${cur.first_name} ${cur.last_name}: ${subject}`, cur.id);
    return ok({ ok: true, to: cur.email });
  }),
];
