/**
 * B5b Online payments – checkout + signed provider webhooks (the fake provider; Stripe's event format and signature).
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/checkout.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
const { createHmac } = await import('node:crypto');
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, who: string | { cookie: string } = 'owner', headers: Record<string, string> = {}) => {
  const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
  if (typeof who === 'string') { if (who) h['x-admin'] = who; } else h.cookie = who.cookie;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(db, OWNER, sql, p))!.n;
let evn = 0;
const hook = async (type: string, object: Record<string, unknown>, opts: { id?: string; secret?: string; t?: number } = {}) => {
  const raw = JSON.stringify({ id: opts.id ?? `evt_${++evn}`, type, data: { object } }); const t = opts.t ?? Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', opts.secret ?? 'whsec_test_secret').update(`${t}.${raw}`).digest('hex');
  return call('POST', '/webhooks/pay/stripe', raw, '', { 'stripe-signature': `t=${t},v1=${sig}` });
};
const completed = (session: string, pi: string, amount: number) => hook('checkout.session.completed', { object: 'checkout.session', id: session, payment_status: 'paid', payment_intent: pi, amount_total: amount });

/* dues by card: renewal → checkout → webhook → active; refund → expired again */
const ex = (await one<{ id: string; email: string }>(db, OWNER, `SELECT m.id, m.email FROM app.members m WHERE m.status = 'expired' AND m.plan = 'single' AND m.archived IS NULL AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY m.id DESC LIMIT 1`))!;
const st = await call('POST', '/auth/code/start', { address: ex.email }, '');
const vr = await fetch(base + '/auth/code/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: ex.email, code: st.body.devCode }) });
const jar = { cookie: (vr.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)![0] };
const ren = await call('POST', '/member/renewal', { years: 1, method: 'card' }, jar);
ok(ren.status === 201 && ren.body.paymentIds.length >= 1, 'renewal waits for a card payment', ren.body);
ok((await call('POST', '/public/checkout', { kind: 'dues', paymentIds: ['00000000-0000-0000-0000-000000000000'] }, '')).status === 404, 'unknown payment');
const co = await call('POST', '/public/checkout', { kind: 'dues', paymentIds: ren.body.paymentIds }, '');
ok(co.status === 201 && co.body.session.startsWith('cs_fake_') && co.body.url.includes('/pay/fake') && co.body.amountCents === ren.body.amountCents, 'card page opened for the dues', co.body);
ok(await n(`SELECT count(*)::int AS n FROM app.checkout_intents WHERE session_id = $1 AND status = 'open'`, [co.body.session]) === 1, 'the checkout is remembered');
const raw = JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: { object: 'checkout.session', id: co.body.session, payment_status: 'paid', payment_intent: 'pi_dues', amount_total: co.body.amountCents } } });
ok((await call('POST', '/webhooks/pay/stripe', raw, '', { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` })).status === 400, 'a webhook with a wrong signature is refused');
const w1 = await completed(co.body.session, 'pi_dues', co.body.amountCents);
ok(w1.status === 200 && w1.body.applied === 'dues', 'the paid webhook is applied', w1.body);
ok((await one<{ status: string }>(db, OWNER, 'SELECT status FROM app.members WHERE id = $1', [ex.id]))!.status === 'active', 'paid → the member is active again');
ok(await n(`SELECT count(*)::int AS n FROM app.payments WHERE id = $1::uuid AND status = 'paid' AND processor = 'stripe' AND processor_ref LIKE 'pi_dues:%'`, [ren.body.paymentIds[0]]) === 1, 'the payment carries the card reference');
const old = await hook('checkout.session.completed', { object: 'checkout.session', id: co.body.session, payment_status: 'paid', payment_intent: 'pi_dues' }, { t: Math.floor(Date.now() / 1000) - 3600 });
ok(old.status === 400, 'an old (replayed) signature is refused');
ok((await hook('checkout.session.completed', { object: 'checkout.session', id: co.body.session, payment_status: 'paid', payment_intent: 'pi_dues' }, { id: 'evt_1' })).body.duplicate === true, 'the same event twice is ignored');
ok((await completed(co.body.session, 'pi_dues', co.body.amountCents)).body.already === 'paid', 'a second "paid" changes nothing');
ok((await call('POST', '/public/checkout', { kind: 'dues', paymentIds: ren.body.paymentIds }, '')).status === 409, 'a paid payment opens no new checkout');
const rf = await hook('charge.refunded', { object: 'charge', payment_intent: 'pi_dues', amount: co.body.amountCents, amount_refunded: co.body.amountCents });
ok(rf.body.refunded === 'dues', 'refund reported', rf.body);
ok((await one<{ status: string }>(db, OWNER, 'SELECT status FROM app.members WHERE id = $1', [ex.id]))!.status === 'expired', 'refunded → the term is taken away');

/* an event: the seat is held while the card page is open */
const ev = { title: 'Card test dinner', summary: 'A dinner to test card payments for registrations.', category: 'community', status: 'published', start: '2026-12-12T18:00', end: '2026-12-12T20:00',
  location: { name: 'Southeast Islamic Center 1', address: 'Pasadena, TX', center: 'Southeast Islamic Center 1' }, visibility: 'public', groupIds: [],
  registration: { enabled: true, capacity: 2, waitlist: true, guests: { allowed: false, max: 0 }, cancellation: { policy: 'until', daysBefore: 1, refund: 'full', feeCents: 0 }, types: [{ id: 'adult', name: 'Adult', priceCents: 2000 }] }, reminders: [1] };
ok((await call('PUT', '/admin/events/card-dinner', ev)).status === 201, 'paid event');
const r1 = await call('POST', '/public/events/card-dinner/registrations', { typeId: 'adult', name: 'Card One', email: 'card.one@example.org' }, '');
const r2 = await call('POST', '/public/events/card-dinner/registrations', { typeId: 'adult', name: 'Card Two', email: 'card.two@example.org' }, '');
const r3 = await call('POST', '/public/events/card-dinner/registrations', { typeId: 'adult', name: 'Card Three', email: 'card.three@example.org' }, '');
ok(r1.body.status === 'pending-payment' && r3.body.status === 'waitlisted', 'two seats held, the third waits');
ok((await call('POST', '/public/checkout', { kind: 'event', ref: r1.body.ref, token: 'x'.repeat(43) }, '')).status === 404, 'the registration’s own link is needed');
const c1 = await call('POST', '/public/checkout', { kind: 'event', ref: r1.body.ref, token: r1.body.manageToken }, '');
const c2 = await call('POST', '/public/checkout', { kind: 'event', ref: r2.body.ref, token: r2.body.manageToken }, '');
ok(c1.status === 201 && c1.body.amountCents === 2000, 'card page for the registration');
await completed(c1.body.session, 'pi_ev1', 2000);
ok(await n(`SELECT count(*)::int AS n FROM app.registrations WHERE id = $1 AND status = 'confirmed' AND paid_cents = 2000`, [r1.body.ref]) === 1, 'paid → confirmed');
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'card.one@example.org' AND kind = 'event-registered'`) === 1, 'confirmation email');
const exp = await hook('checkout.session.expired', { object: 'checkout.session', id: c2.body.session });
ok(exp.body.closed === 'event', 'an abandoned card page', exp.body);
ok(await n(`SELECT count(*)::int AS n FROM app.registrations WHERE id = $1 AND status = 'cancelled'`, [r2.body.ref]) === 1, 'gives the seat back');
ok(await n(`SELECT count(*)::int AS n FROM app.registrations WHERE id = $1 AND status = 'pending-payment'`, [r3.body.ref]) === 1, 'the waitlist moves up');

/* a gift: campaign fund wins, receipt above the IRS amount */
ok((await call('POST', '/public/checkout', { kind: 'gift', amountCents: 5000, fund: 'nope', name: 'G Giver', email: 'g.giver@example.org' }, '')).status === 422, 'only active funds');
const g = await call('POST', '/public/checkout', { kind: 'gift', amountCents: 30000, fund: 'general', campaignId: 'expansion-phase-2', pageId: 'aisha-runs-for-the-masjid', name: 'Gift Giver', email: 'gift.giver@example.org' }, '');
ok(g.status === 201, 'gift checkout', g.body);
await completed(g.body.session, 'pi_gift1', 30000);
const d = await one<{ id: string; fund_id: string; campaign_id: string; page_id: string; receipt_no: string; state: string }>(db, OWNER, `SELECT id, fund_id, campaign_id, page_id, receipt_no, state FROM app.donations WHERE platform = 'stripe' AND platform_ref = 'pi_gift1'`);
ok(!!d && d.fund_id === 'building' && d.campaign_id === 'expansion-phase-2' && d.page_id === 'aisha-runs-for-the-masjid' && d.state === 'awaiting-payout', 'recorded in Donations, in the campaign’s fund', d);
ok(/^R-\d{4}-\d{5}$/.test(d!.receipt_no) && await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'gift.giver@example.org' AND kind = 'donation-receipt' AND body LIKE '%No goods or services%'`) === 1, '$300 → the written receipt goes out');
const z = await call('POST', '/public/checkout', { kind: 'gift', amountCents: 5000, fund: 'zakat', name: 'Zakat Giver', email: 'z.giver@example.org', monthly: true }, '');
await completed(z.body.session, 'sub_z1', 5000);
ok(await n(`SELECT count(*)::int AS n FROM app.donations WHERE platform_ref = 'sub_z1' AND fund_id = 'zakat' AND monthly AND receipt_no = ''`) === 1, 'monthly Zakat gift recorded (small – thank-you only)');
await hook('charge.refunded', { object: 'charge', payment_intent: 'pi_gift1', amount: 30000, amount_refunded: 30000 });
ok(await n(`SELECT count(*)::int AS n FROM app.donations WHERE platform_ref = 'pi_gift1' AND state = 'refunded'`) === 1, 'a refund on Stripe refunds the gift');
ok(await n(`SELECT count(*)::int AS n FROM platform.webhook_events WHERE provider = 'stripe'`) >= 8, 'every event kept once');

server.close(); await db.close();
console.log(`checkout ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
