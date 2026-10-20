/**
 * B3 Website and member portal.
 *   POST /public/join/email/start {email}              6-digit code to prove the email (join form step 1)
 *   POST /public/join/email/verify {email, code}       → joinToken (2 hours, one use)
 *   POST /public/membership/applications               the join form: re-validated with the admin's own rules
 *        (makeJoinSchemas, cleanAnswers), price recomputed (priceFor + checkoutTotal), member placed by ZIP (never by
 *        what the browser says), border request → masjid-change request, consents stored, payment row created
 *   GET  /member/renewal                               plan, standing, may renew?, prices for 1..N years
 *   POST /member/renewal {years, method, coverFees?, code?}   → pending payment(s) for the years being paid
 *   POST /admin/payments/:id/status {status, note}     an office marks a check cleared / bounced, a card failed… (PAYMENT_MOVES)
 *   GET  /public/centers · GET /public/place?zip=      masjids and zones (public fields) · ZIP → masjid → zone
 *   GET  /member/records · GET /member/leadership      members-only records · every past term (no member ids)
 *   GET  /public/helpdesk                              categories people may pick (publicHelpdesk)
 *   POST /public/newsletter {email, consentText}       email list sign-up with proof of consent
 * Card payments: the answer carries the payment ids; the website opens the card page with POST /public/checkout (B5b).
 */
import { z } from 'zod';
import { one, rows, type Statement } from '../db/sql.js';
import { HttpError, PLATFORM, audit, document, need, needMember, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { codeHash, newCode, newToken, sha256hex } from '../auth/crypto.js';
import { MembershipSettingsSchema, mockMembershipSettings, DEFAULT_LIFECYCLE, ageOn, type Plan } from '@/lib/content/membership';
import { priceFor, canRenew, standingOn } from '@/lib/content/renewal';
import { makeJoinSchemas, fieldErrors } from '@/lib/join/schema';
import { JoinFormSchema, defaultJoinForm, cleanAnswers, type Answers } from '@/lib/join/form-def';
import { OrgConfigSchema, mockOrgConfig, payMethods } from '@/lib/community/org-config';
import { checkoutTotal, canMove, type PayMethod, type PaymentStatus } from '@/lib/community/payments';
import { recordsFor, RecordsSchema, mockRecords } from '@/lib/community/records';
import { OfficialsSchema, mockOfficials, memberPastLeadership } from '@/lib/community/officials';
import { WorkSettingsSchema, mockWorkSettings, publicHelpdesk } from '@/lib/community/work';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const parse = async <S extends z.ZodTypeAny>(ctx: Ctx, key: string, schema: S, fallback: z.output<S>): Promise<z.output<S>> => { const p = schema.safeParse(await document(ctx.db, ctx.orgId, key)); return p.success ? p.data : fallback; };
const settingsOf = (ctx: Ctx) => parse(ctx, 'membership-settings', MembershipSettingsSchema, mockMembershipSettings);
const configOf = (ctx: Ctx) => parse(ctx, 'org-config', OrgConfigSchema, mockOrgConfig);
const yearOf = (d: string) => Number(d.slice(0, 4));
const fmtPhone = (p: string) => { const d = p.replace(/\D/g, '').slice(-10); return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`; };

/** Payment rows for the dues years a term covers (the total split by year – the receipt shows the whole amount). */
function duesRows(ctx: Ctx, p: { memberId: string; years: number[]; totalCents: number; method: string; status: string; applicationId?: string; lines: unknown; ref: string }): Statement[] {
  const each = Math.floor(p.totalCents / p.years.length);
  return p.years.map((y, i) => ({ sql: `INSERT INTO app.payments (org_id, member_id, year, paid_on, amount_cents, method, ref, status, processor, application_id, kind, lines, recorded_by)
      VALUES ($1::uuid, $2, $3::int, $4::date, $5::int, $6, $7, $8, $9, NULLIF($10, ''), 'dues', $11::jsonb, 'Website') RETURNING id`,
    params: [ctx.orgId, p.memberId, y, todayCT(), i === p.years.length - 1 ? p.totalCents - each * (p.years.length - 1) : each, p.method === 'payLater' ? 'check' : p.method === 'card' || p.method === 'ach' ? p.method : p.method === 'cash' ? 'cash' : 'check',
      `${p.ref}-${y}`, p.status, p.method === 'card' || p.method === 'ach' ? 'stripe' : 'office', p.applicationId ?? '', JSON.stringify(p.lines)] }));
}
const coveredYears = (through: string | null, years: number, fallbackYear: number) => { const last = through ? yearOf(through) : fallbackYear; return Array.from({ length: Math.max(1, years) }, (_, i) => last - years + 1 + i); };

export const WEBSITE_ROUTES: Route[] = [
  /* ---------------- join: prove the email ---------------- */
  route('POST', /^\/public\/join\/email\/start$/, async (ctx) => {
    const email = String(body(ctx).email ?? '').trim().toLowerCase();
    if (!z.string().email().safeParse(email).success) throw new HttpError(400, 'Enter a valid email address, like name@example.com.');
    const recent = await one<{ n: number }>(ctx.db, PLATFORM, `SELECT count(*)::int AS n FROM platform.login_codes WHERE address = $1 AND created_at > now() - interval '15 minutes'`, [email]);
    // development only (AUTH_DEV_CODES=1, never in production): same switches as the admin sign-in – AUTH_DEV_NO_LIMITS and AUTH_DEV_FIXED_CODE
    const dev = process.env.AUTH_DEV_CODES === '1' && process.env.NODE_ENV !== 'production';
    if ((recent?.n ?? 0) >= (dev && process.env.AUTH_DEV_NO_LIMITS === '1' ? 1000 : 5)) throw new HttpError(429, 'Too many codes asked for. Wait 15 minutes and try again.');
    const fixed = process.env.AUTH_DEV_FIXED_CODE ?? '';
    const code = dev && /^\d{6}$/.test(fixed) ? fixed : newCode();
    await ctx.db.run(PLATFORM, [
      { sql: `INSERT INTO platform.login_codes (org_id, channel, address, purpose, code_hash, ip) VALUES ($1, 'email', $2, 'join', decode($3, 'hex'), NULLIF($4, '')::inet)`, params: [ctx.orgId, email, codeHash(email, code), ctx.req.ip ?? ''] },
      { sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1, 'email', $2, $3, $4, 'join-code')`, params: [ctx.orgId, email, `${code} is your code to join`, `Assalamu alaikum,\n\nYour code to continue your membership application is ${code}. It works for 10 minutes.`] },
    ]);
    return { status: 202, body: { sent: true, ...(process.env.AUTH_DEV_CODES === '1' && process.env.NODE_ENV !== 'production' ? { devCode: code } : {}) } };
  }),
  route('POST', /^\/public\/join\/email\/verify$/, async (ctx) => {
    const email = String(body(ctx).email ?? '').trim().toLowerCase(); const code = String(body(ctx).code ?? '');
    const c = await one<{ id: string; attempts: number; ok: boolean }>(ctx.db, PLATFORM, `SELECT id, attempts, (code_hash = decode($2, 'hex')) AS ok FROM platform.login_codes WHERE address = $1 AND purpose = 'join' AND org_id = $3 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [email, codeHash(email, code), ctx.orgId]);
    if (!c) throw new HttpError(400, 'That code has expired. Ask for a new one.');
    if (c.attempts >= 5) throw new HttpError(429, 'Too many tries. Ask for a new code.');
    if (!c.ok) { await ctx.db.run(PLATFORM, [{ sql: 'UPDATE platform.login_codes SET attempts = attempts + 1 WHERE id = $1::uuid', params: [c.id] }]); throw new HttpError(400, 'That code is not right.'); }
    // the email is proven now: tell its owner straight away when it already has an application or a membership (the
    // application would be refused at the end otherwise)
    const existing = await one<{ status: string; stage: string }>(ctx.db, API(ctx), `SELECT status, coalesce(record->>'joinStage', '') AS stage FROM app.members WHERE lower(email) = $1 ORDER BY (archived IS NULL) DESC LIMIT 1`, [email]);
    if (existing && existing.status !== 'archived') throw new HttpError(409, existing.status !== 'pending' ? 'You are already a member – sign in to renew.'
      : existing.stage === 'incomplete' ? 'We already have an unfinished application for this email. Contact the office and we will finish it with you.'
      : 'An application with this email is already waiting for approval – we will email you when it is reviewed.', undefined, existing.status === 'pending' ? 'already-applied' : 'already-member');
    const token = newToken();
    await ctx.db.run(PLATFORM, [{ sql: 'UPDATE platform.login_codes SET used_at = now() WHERE id = $1::uuid', params: [c.id] },
      { sql: `INSERT INTO platform.login_codes (org_id, channel, address, purpose, code_hash, expires_at) VALUES ($1, 'email', $2, 'verify-email', decode($3, 'hex'), now() + interval '2 hours')`, params: [ctx.orgId, email, sha256hex(token)] }]);
    return { status: 200, body: { joinToken: token, expiresInMinutes: 120 } };
  }),

  /* ---------------- join: the application ---------------- */
  route('POST', /^\/public\/membership\/applications$/, async (ctx) => {
    const raw = body(ctx);
    const [settings, form, config] = await Promise.all([settingsOf(ctx), parse(ctx, 'join-form', JoinFormSchema, defaultJoinForm), configOf(ctx)]);
    const today = todayCT();
    const email = String((raw.account as { email?: string } | undefined)?.email ?? '').trim().toLowerCase();
    // the email must have been proven on this server – the browser's "verified: true" is not enough
    const tok = await one<{ id: string }>(ctx.db, PLATFORM, `SELECT id FROM platform.login_codes WHERE address = $1 AND purpose = 'verify-email' AND org_id = $2 AND used_at IS NULL AND expires_at > now() AND code_hash = decode($3, 'hex')`, [email, ctx.orgId, sha256hex(String(raw.joinToken ?? ''))]);
    if (!tok) throw new HttpError(401, 'Verify your email with the 6-digit code first.', { 'account.verified': 'Verify your email with the 6-digit code first.' });
    const parsed = makeJoinSchemas(settings, today).application.safeParse({ ...raw, account: { email, verified: true } });
    if (!parsed.success) throw new HttpError(422, 'Some answers need a look.', fieldErrors(parsed.error));
    const a = parsed.data;
    const plan = settings.plans.find((p) => p.id === a.plan.planId) as Plan;
    const custom = cleanAnswers(form, ((raw.custom && typeof raw.custom === 'object') ? raw.custom : {}) as Answers, { planId: plan.id, planCategory: plan.category, memberClass: a.plan.memberClass, age: ageOn(a.about.dob, today) });
    if (Object.keys(custom.errors).length) throw new HttpError(422, 'Some answers need a look.', custom.errors);
    const co = (raw.checkout && typeof raw.checkout === 'object' ? raw.checkout : {}) as { method?: string; coverFees?: boolean; discountCode?: string };
    const method = String(co.method ?? 'card');
    if (!(payMethods(config) as readonly string[]).includes(method)) throw new HttpError(422, 'Choose one of the ways to pay shown.', { 'payment.method': 'Choose one of the ways to pay shown.' });
    const price = priceFor(plan, { start: today, years: a.plan.years, saleYear: settings.year });
    const total = checkoutTotal(config, { label: `${plan.name} membership`, kind: 'dues', priceCents: price.totalCents, planId: plan.id, method: method as PayMethod, coverFees: co.coverFees === true, code: co.discountCode, today });
    if (!total.codeOk) throw new HttpError(422, total.codeMessage ?? 'That code does not work.', { 'payment.code': total.codeMessage });
    const existing = await one<{ id: string; status: string }>(ctx.db, API(ctx), `SELECT id, status FROM app.members WHERE lower(email) = $1 ORDER BY (archived IS NULL) DESC LIMIT 1`, [email]);
    if (existing && existing.status !== 'archived') { const msg = existing.status === 'pending' ? 'An application with this email is already waiting for approval – we will email you when it is reviewed.' : 'You are already a member – sign in to renew.'; throw new HttpError(409, msg, { 'account.email': msg }); }   // the detail is field messages – never the member number

    const appId = (await one<{ id: string }>(ctx.db, API(ctx), `SELECT 'APP-' || $2::text || '-' || lpad(app.next_no($1::uuid, 'application-' || $2::text, 4001)::text, 5, '0') AS id`, [ctx.orgId, settings.year]))!.id;
    const memberId = (await one<{ id: string }>(ctx.db, API(ctx), `SELECT app.next_member_id($1::uuid, $2) AS id`, [ctx.orgId, ctx.slug.slice(0, 3).toUpperCase()]))!.id;
    const offline = method === 'check' || method === 'cash' || method === 'payLater';
    const payStatus = !total.needsPayment ? '' : method === 'check' && config.payments.checkPendingStatus ? 'check_pending' : 'pending';
    const v = (k: 'pledgeVersion' | 'emailConsentVersion' | 'smsConsentVersion' | 'identityConsentVersion') => String(a[k] ?? '');
    const stmts: Statement[] = [
      { sql: `INSERT INTO app.members (org_id, id, first_name, middle_name, last_name, preferred_name, email, phone, dob, street, city, state, zip, plan, joined_year, applied_on, commitment, source, extra, record)
          VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12, $13, $14, $15::int, $16::date, $17, 'website', $18::jsonb, $19::jsonb) RETURNING id, center, zone`,
        params: [ctx.orgId, memberId, a.about.firstName, a.about.middleName ?? '', a.about.lastName, a.about.preferredName ?? '', email, fmtPhone(a.about.phone), a.about.dob, [a.about.street, a.about.unit].filter(Boolean).join(' '), a.about.city, a.about.state, a.about.zip.slice(0, 5), plan.id, yearOf(today), today,
          (a.pledge.commitments[0] as string) && ['programs', 'contribution', 'volunteer'].includes(a.pledge.commitments[0] as string) ? a.pledge.commitments[0] : 'programs', custom.answers,
          { audit: [{ at: new Date().toISOString(), by: 'Website', action: 'Applied', detail: `${plan.name}, ${price.term.years} year(s)` }], payer: a.payment }] },
      { sql: `INSERT INTO app.applications (org_id, id, member_id, kind, email, first_name, last_name, zip, plan_id, data, consents, status, paid, submitted_at, source)
          VALUES ($1::uuid, $2, $3, 'new', $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'submitted', $11::boolean, now(), 'website')`,
        params: [ctx.orgId, appId, memberId, email, a.about.firstName, a.about.lastName, a.about.zip.slice(0, 5), plan.id, { ...a, custom: custom.answers, quote: { ...price, lines: total.lines, totalCents: total.totalCents, method } }, { pledge: v('pledgeVersion'), email: v('emailConsentVersion'), sms: v('smsConsentVersion'), identity: v('identityConsentVersion') }, !total.needsPayment] },
      ...([['pledge', 'pledgeVersion'], ['email', 'emailConsentVersion'], ['sms', 'smsConsentVersion'], ['identity', 'identityConsentVersion']] as const).filter(([, k]) => v(k)).map(([kind, k]) => ({
        sql: `INSERT INTO app.consents (org_id, member_id, email, kind, version, ip, source) VALUES ($1::uuid, $2, $3, $4, $5, NULLIF($6, '')::inet, 'join-form')`,
        params: [ctx.orgId, memberId, email, kind, v(k), ctx.req.ip ?? ''] })),
      { sql: `UPDATE platform.login_codes SET used_at = now() WHERE id = $1::uuid`, params: [tok.id] },
    ];
    if (plan.category === 'household' && a.plan.spouse?.firstName) stmts.push({ sql: `INSERT INTO app.relationships (org_id, member_id, relation, related_name) VALUES ($1::uuid, $2, 'spouse', $3)`, params: [ctx.orgId, memberId, `${a.plan.spouse.firstName} ${a.plan.spouse.lastName ?? ''}`.trim()] });
    if (payStatus) stmts.push(...duesRows(ctx, { memberId, years: coveredYears(price.term.through, price.term.years, settings.year), totalCents: total.totalCents, method, status: payStatus, applicationId: appId, lines: total.lines, ref: appId }));
    // login_codes is a platform table: the API role runs the member part, the platform role marks the token
    await ctx.db.run(API(ctx), stmts.filter((s) => !s.sql.includes('platform.login_codes')));
    await ctx.db.run(PLATFORM, stmts.filter((s) => s.sql.includes('platform.login_codes')));
    const placed = await one<{ center: string; zone: string; center_id: string | null }>(ctx.db, API(ctx), 'SELECT center, zone, center_id FROM app.members WHERE id = $1', [memberId]);
    // a border request: they live in one masjid's area but ask for another → a masjid-change request for the office
    if (a.about.borderRequestCenterId) await ctx.db.run(API(ctx), [{ sql: `INSERT INTO app.center_changes (org_id, member_id, from_center, to_center, reason) SELECT $1::uuid, $2, NULLIF($3, '')::uuid, id, 'Asked on the join form (lives near a border)' FROM app.centers WHERE code = $4 AND active AND id IS DISTINCT FROM NULLIF($3, '')::uuid`, params: [ctx.orgId, memberId, placed?.center_id ?? '', a.about.borderRequestCenterId] }]);
    const payIds = payStatus ? ((await rows(ctx.db, API(ctx), `SELECT id::text FROM app.payments WHERE application_id = $1 ORDER BY year`, [appId])) as { id: string }[]).map((r) => r.id) : [];
    return { status: 201, body: { applicationId: appId, memberId, status: 'submitted', center: placed?.center ?? '', amountCents: total.totalCents, lines: total.lines, term: price.term,
      payment: total.needsPayment ? { method, status: payStatus, paymentIds: payIds, checkout: offline ? null : { kind: 'dues', paymentIds: payIds, post: '/public/checkout' }, next: offline ? 'Bring or mail your payment to the office – your application waits for it.' : 'Card payment opens in the next step.' } : { method: null, status: 'none' } } };
  }),

  /* ---------------- renewal ---------------- */
  route('GET', /^\/member\/renewal$/, async (ctx) => {
    const id = needMember(ctx);
    const [settings, m] = await Promise.all([settingsOf(ctx), one<{ plan: string; paid_through: string | null; status: string }>(ctx.db, API(ctx), 'SELECT plan, paid_through::text, status FROM app.members WHERE id = $1', [id])]);
    const plan = settings.plans.find((p) => p.id === m?.plan); if (!plan || !m) throw new HttpError(404, 'Your plan is not available – contact the office.');
    const today = todayCT(); const lc = settings.lifecycle ?? DEFAULT_LIFECYCLE;
    const may = canRenew(plan, m.paid_through, today, lc);
    const options = may.ok ? Array.from({ length: plan.term === 'calendar_year' ? plan.maxYearsAhead : 1 }, (_, i) => { const p = priceFor(plan, { start: today, years: i + 1, saleYear: settings.year, current: m.paid_through, extendWithinDays: lc.overdueDays }); return { years: p.term.years, totalCents: p.totalCents, through: p.term.through }; }) : [];
    return { status: 200, body: { plan: { id: plan.id, name: plan.name }, standing: standingOn(plan, lc, m.paid_through, today), canRenew: may, options } };
  }),
  route('POST', /^\/member\/renewal$/, async (ctx) => {
    const id = needMember(ctx);
    const [settings, config] = await Promise.all([settingsOf(ctx), configOf(ctx)]);
    const m = await one<{ plan: string; paid_through: string | null }>(ctx.db, API(ctx), 'SELECT plan, paid_through::text FROM app.members WHERE id = $1', [id]);
    const plan = settings.plans.find((p) => p.id === m?.plan); if (!plan || !m) throw new HttpError(404, 'Your plan is not available – contact the office.');
    const today = todayCT(); const lc = settings.lifecycle ?? DEFAULT_LIFECYCLE;
    const may = canRenew(plan, m.paid_through, today, lc); if (!may.ok) throw new HttpError(409, may.reason);
    const b = body(ctx); const method = String(b.method ?? 'card');
    if (!(payMethods(config) as readonly string[]).includes(method)) throw new HttpError(400, 'Choose one of the ways to pay shown.');
    const open = await one(ctx.db, API(ctx), `SELECT 1 FROM app.payments WHERE member_id = $1 AND kind = 'dues' AND status IN ('pending', 'check_pending')`, [id]);
    if (open) throw new HttpError(409, 'A renewal payment is already waiting – finish or cancel it first.');
    const price = priceFor(plan, { start: today, years: Number(b.years ?? 1), saleYear: settings.year, current: m.paid_through, extendWithinDays: lc.overdueDays });
    const total = checkoutTotal(config, { label: `${plan.name} renewal`, kind: 'dues', priceCents: price.totalCents, planId: plan.id, method: method as PayMethod, coverFees: b.coverFees === true, code: b.code ? String(b.code) : undefined, today });
    if (!total.codeOk) throw new HttpError(400, total.codeMessage ?? 'That code does not work.');
    const ref = `RNW-${(await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, 'renewal', 1001)::text AS n`, [ctx.orgId]))!.n}`;
    const status = method === 'check' && config.payments.checkPendingStatus ? 'check_pending' : 'pending';
    const ids = await ctx.db.run(API(ctx), duesRows(ctx, { memberId: id, years: coveredYears(price.term.through, price.term.years, settings.year), totalCents: total.totalCents, method, status, lines: total.lines, ref }));
    await audit(ctx, 'payments', 'Renewal started', `${plan.name} · ${price.term.years} year(s) · $${(total.totalCents / 100).toFixed(2)} · ${method}`, id);
    return { status: 201, body: { ref, amountCents: total.totalCents, lines: total.lines, term: price.term, paymentIds: ids.map((r) => (r[0] as { id: string }).id), payment: { method, status, checkoutUrl: null } } };
  }),

  /* ---------------- the office moves a payment along ---------------- */
  route('POST', /^\/admin\/payments\/([0-9a-f-]{36})\/status$/, async (ctx, mm) => {
    need(ctx, 'payments.record');
    const to = String(body(ctx).status ?? '') as PaymentStatus; const note = String(body(ctx).note ?? '').slice(0, 300);
    if ((to === 'refunded' || to === 'partially_refunded')) need(ctx, 'payments.refund');
    const p = await movePayment(ctx, mm[1], to, ctx.me!.name);
    await audit(ctx, 'payments', `Payment ${to}`, note, p.member_id);
    return { status: 200, body: { id: mm[1], status: to } };
  }),

  /* ---------------- public reads ---------------- */
  route('GET', /^\/public\/centers$/, async (ctx) => {
    const zones = await rows(ctx.db, API(ctx), `SELECT code AS id, name, areas, director_name AS director, sort FROM app.zones WHERE active ORDER BY sort, name`);
    const centers = await rows(ctx.db, API(ctx), `SELECT c.code AS id, c.name, c.aka, c.kind, z.code AS zone, c.street, c.city, c.state, c.zip, c.phone, c.website, c.services,
        coalesce((SELECT json_agg(json_build_object('khutbah', to_char(j.khutbah_at, 'HH24:MI'), 'label', j.label) ORDER BY j.slot) FROM app.center_jumuah j WHERE j.org_id = c.org_id AND j.center_id = c.id), '[]') AS jumuah
      FROM app.centers c JOIN app.zones z ON z.org_id = c.org_id AND z.id = c.zone_id WHERE c.active ORDER BY z.sort, c.sort, c.name`);
    return { status: 200, body: { zones, centers } };
  }),
  route('GET', /^\/public\/place$/, async (ctx) => {
    const zip = String(ctx.req.query.get('zip') ?? '').slice(0, 5);
    if (!/^\d{5}$/.test(zip)) throw new HttpError(400, 'Enter a 5-digit ZIP code.');
    const r = await one<{ zone: string | null; zone_name: string | null; center: string | null; center_name: string | null; why: string }>(ctx.db, API(ctx), `SELECT z.code AS zone, z.name AS zone_name, c.code AS center, c.name AS center_name, h.why FROM app.home_for_zip($1) h LEFT JOIN app.zones z ON z.org_id = app.current_org() AND z.id = h.zone_id LEFT JOIN app.centers c ON c.org_id = app.current_org() AND c.id = h.center_id`, [zip]);
    // where the ZIP is (geo.postal_codes – loaded by the platform) and, when no masjid serves it, the nearest ones
    const g = await one<{ city: string; state: string; lat: string | null; lng: string | null }>(ctx.db, API(ctx), `SELECT city, state, lat::text, lng::text FROM geo.postal_codes WHERE country = 'US' AND code = $1`, [zip]);
    const nearest = !r?.center && g?.lat && g?.lng ? await rows(ctx.db, API(ctx), `SELECT c.name, c.code AS id, round(n.miles, 1)::float AS miles FROM app.nearest_centers($1::numeric, $2::numeric, 3) n JOIN app.centers c ON c.org_id = app.current_org() AND c.id = n.center_id`, [g.lat, g.lng]) : [];
    return { status: 200, body: { ...r, place: g ? { city: g.city, state: g.state } : null, nearest } };
  }),
  route('GET', /^\/member\/records$/, async (ctx) => {
    needMember(ctx);
    const d = await parse(ctx, 'records', RecordsSchema, mockRecords);
    return { status: 200, body: { items: recordsFor(d, 'members') } };
  }),
  route('GET', /^\/member\/leadership$/, async (ctx) => {
    needMember(ctx);
    const d = await parse(ctx, 'officials', OfficialsSchema, mockOfficials);
    const zones = await rows(ctx.db, API(ctx), 'SELECT code, name FROM app.zones') as { code: string; name: string }[];
    return { status: 200, body: { years: memberPastLeadership(d, (id) => zones.find((z) => z.code === id)?.name ?? id) } };
  }),
  route('GET', /^\/public\/helpdesk$/, async (ctx) => ({ status: 200, body: publicHelpdesk(await parse(ctx, 'work-settings', WorkSettingsSchema, mockWorkSettings)) })),
  route('POST', /^\/public\/newsletter$/, async (ctx) => {
    const email = String(body(ctx).email ?? '').trim().toLowerCase(); const text = String(body(ctx).consentText ?? '').slice(0, 500);
    if (!z.string().email().safeParse(email).success) throw new HttpError(400, 'Enter a valid email address.');
    if (!text) throw new HttpError(400, 'The consent text is missing.');
    await ctx.db.run(API(ctx), [
      { sql: `INSERT INTO app.contact_prefs (org_id, address, channel, topics) VALUES ($1::uuid, $2, 'email', ARRAY['newsletter']) ON CONFLICT (org_id, channel, address) DO UPDATE SET topics = (SELECT array_agg(DISTINCT t) FROM unnest(app.contact_prefs.topics || ARRAY['newsletter']) t), unsubscribed = false, updated_at = now()`, params: [ctx.orgId, email] },
      { sql: `INSERT INTO app.consents (org_id, email, kind, version, text_sha256, ip, source) VALUES ($1::uuid, $2, 'email', 'newsletter', decode($3, 'hex'), NULLIF($4, '')::inet, 'website-footer')`, params: [ctx.orgId, email, sha256hex(text), ctx.req.ip ?? ''] },
    ]);
    return { status: 202, body: { status: 'subscribed' } };
  }),
];

/** Move one dues payment along (PAYMENT_MOVES) and let membership follow: terms, status, the application's "paid".
 *  Used by the office (above) and by the payment provider's webhook (checkout.ts). */
export async function movePayment(ctx: Ctx, id: string, to: PaymentStatus, by: string, processor?: { name: string; ref: string }) {
  const p = await one<{ status: PaymentStatus; member_id: string; application_id: string | null }>(ctx.db, API(ctx), `SELECT p.status, p.member_id, p.application_id FROM app.payments p WHERE p.id = $1::uuid`, [id]);
  if (!p) throw new HttpError(404, 'No such payment.');
  if (p.status === to) return p;
  if (!canMove(p.status, to)) throw new HttpError(409, `A payment that is “${p.status}” cannot become “${to}”.`);
  const stmts: Statement[] = [
    { sql: `UPDATE app.payments SET status = $2, paid_on = CASE WHEN $2 = 'paid' THEN current_date ELSE paid_on END, recorded_by = $3, processor = CASE WHEN $4 = '' THEN processor ELSE $4 END, processor_ref = CASE WHEN $5 = '' THEN processor_ref ELSE $5 END, updated_at = now() WHERE id = $1::uuid`, params: [id, to, by, processor?.name ?? '', processor?.ref ?? ''] },
    { sql: 'SELECT app.backfill_memberships($1::uuid)', params: [ctx.orgId] },
    { sql: 'SELECT app.revoke_unpaid_terms($1::uuid, $2)', params: [ctx.orgId, p.member_id] },
    { sql: 'SELECT app.refresh_status($1::uuid, $2)', params: [ctx.orgId, p.member_id] },
  ];
  if (p.application_id && to === 'paid') stmts.push({ sql: `UPDATE app.applications SET paid = NOT EXISTS (SELECT 1 FROM app.payments x WHERE x.application_id = $1 AND x.status <> 'paid') WHERE id = $1`, params: [p.application_id] });
  await ctx.db.run(API(ctx), stmts);
  return p;
}
