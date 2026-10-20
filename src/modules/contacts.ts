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
 */
import { one, rows } from '../db/sql.js';
import { HttpError, audit, need, route, type Ctx, type Res, type Route } from '../http/core.js';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const ok = (b: unknown, status = 200): Res => ({ status, body: b });
const UUID = /^[0-9a-f-]{36}$/;
const PER_IP_15MIN = () => Number(process.env.CONTACTS_PER_IP ?? 30);

type Row = { id: string; masjid_id: string | null; first_name: string; last_name: string; email: string; phone: string; source: string; note: string; created_at: string; last_seen_at: string; member_id: string | null };
const SELECT = `SELECT c.id, k.code AS masjid_id, c.first_name, c.last_name, c.email::text, c.phone, c.source, c.note, c.created_at::text, c.last_seen_at::text,
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
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'app', $7)
        ON CONFLICT (org_id, lower(email::text), phone) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, center_id = coalesce(EXCLUDED.center_id, app.contacts.center_id), last_seen_at = now()
        RETURNING id`, [ctx.orgId, centerId, f.firstName, f.lastName, f.email, f.phone, ip]);
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
    await ctx.db.run(API(ctx), [{ sql: `UPDATE app.contacts SET first_name = coalesce($2, first_name), last_name = coalesce($3, last_name), email = coalesce($4, email), phone = coalesce($5, phone),
        center_id = CASE WHEN $6::boolean THEN $7::uuid ELSE center_id END, last_seen_at = now() WHERE id = $1::uuid`,
      params: [cur.id, f.firstName ?? null, f.lastName ?? null, f.email ?? null, f.phone ?? null, centerId !== undefined, centerId ?? null] }]);
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
