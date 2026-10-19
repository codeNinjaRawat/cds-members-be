/**
 * B5a Jobs, the outbox worker and provider webhooks – on a migrated + seeded database (log provider: nothing leaves).
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/jobs.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1'; process.env.EMAIL_WEBHOOK_TOKEN = 'test-hook-token';
const { createApi } = await import('../src/http/server.js');
const { openDb, one, rows } = await import('../src/db/sql.js');
const { drainOutbox } = await import('../src/jobs/outbox.js');
const { emailProviders } = await import('../src/jobs/providers.js');
const { tick, systemContext } = await import('../src/jobs/runner.js');
const { runRenewalJobs } = await import('../src/jobs/renewals.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, who = 'owner', headers: Record<string, string> = {}) => {
  const h: Record<string, string> = { 'content-type': 'application/json', ...headers }; if (who) h['x-admin'] = who;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(db, OWNER, sql, p))!.n;
const org = (await one<{ id: string }>(db, OWNER, `SELECT id::text FROM platform.organizations WHERE slug = 'isgh'`))!.id;

/* the outbox is drained through the provider */
await drainOutbox(db);   // whatever the seed left
const t = await call('POST', '/public/helpdesk/tickets', { categoryId: 'feedback', subject: 'Thank you', detail: 'The new parking signs are great.', name: 'Amal Noor', email: 'amal.jobs@example.org' }, '');
ok(t.status === 201, 'a website request queues an acknowledgement');
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'amal.jobs@example.org' AND sent_at IS NULL AND status = 'queued'`) === 1, 'queued, not sent');
const d1 = await drainOutbox(db);
ok(d1.sent >= 1 && d1.failed === 0, `drained (${d1.sent} sent)`, d1);
const row = await one<{ status: string; provider: string; provider_ref: string; attempts: number }>(db, OWNER, `SELECT status, provider, provider_ref, attempts FROM platform.outbox WHERE to_address = 'amal.jobs@example.org'`);
ok(row!.status === 'sent' && row!.provider === 'log' && row!.provider_ref.startsWith('log-') && row!.attempts === 1, 'sent once, with the provider’s reference', row);
ok((await drainOutbox(db)).claimed === 0, 'nothing is sent twice');

/* failures are retried, then given up */
await db.run(OWNER, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1::uuid, 'email', 'retry@example.org', 'Retry', 'Body', 'test')`, params: [org] }]);
for (let i = 0; i < 5; i++) await drainOutbox(db, { email: emailProviders.fail() });
const rt = await one<{ status: string; attempts: number; error: string }>(db, OWNER, `SELECT status, attempts, error FROM platform.outbox WHERE to_address = 'retry@example.org'`);
ok(rt!.status === 'failed' && rt!.attempts === 5 && rt!.error.includes('unavailable'), 'five tries, then failed with the reason', rt);
ok((await drainOutbox(db, { email: emailProviders.fail() })).claimed === 0, 'a failed row is not tried again');

/* a bulk message: deliveries follow the outbox */
const msg = await call('POST', '/admin/messages', { name: 'Jobs test', channel: 'email', topic: 'membership', subject: 'AGM notice', body: 'The AGM is in March.', audience: { everyone: false, groupIds: ['voting-2026'] } }, 'comms');
await call('POST', '/admin/groups/refresh', {});
const sent = await call('POST', `/admin/messages/${msg.body.id}/send`, {}, 'comms');
ok(sent.status === 200 && sent.body.sent > 0, `bulk queued for ${sent.body.sent}`);
ok(await n(`SELECT count(*)::int AS n FROM app.deliveries WHERE message_id = $1::uuid AND status = 'queued'`, [msg.body.id]) === sent.body.sent, 'deliveries queued');
await drainOutbox(db, { limit: 1000 });
ok(await n(`SELECT count(*)::int AS n FROM app.deliveries WHERE message_id = $1::uuid AND status = 'sent' AND provider_ref <> ''`, [msg.body.id]) === sent.body.sent, 'deliveries sent with the provider reference');

/* email webhooks: delivered, bounced, replay, suppression */
const one1 = await one<{ provider_ref: string; to_address: string }>(db, OWNER, `SELECT provider_ref, to_address::text FROM platform.outbox WHERE ref = $1 ORDER BY id LIMIT 1`, [`msg:${msg.body.id}`]);
ok((await call('POST', '/webhooks/email/postmark', { RecordType: 'Delivery', MessageID: one1!.provider_ref, Recipient: one1!.to_address, ID: 'pm-1' }, '', { 'x-webhook-token': 'wrong' })).status === 401, 'a webhook without the token is refused');
const dv = await call('POST', '/webhooks/email/postmark', { RecordType: 'Delivery', MessageID: one1!.provider_ref, Recipient: one1!.to_address, ID: 'pm-1' }, '', { 'x-webhook-token': 'test-hook-token' });
ok(dv.status === 200 && dv.body.handled === 1, 'delivery reported');
ok(await n(`SELECT count(*)::int AS n FROM app.deliveries WHERE message_id = $1::uuid AND address = $2 AND status = 'delivered'`, [msg.body.id, one1!.to_address]) === 1, 'the delivery row says delivered');
const bounce = { RecordType: 'Bounce', Type: 'HardBounce', MessageID: one1!.provider_ref, Email: one1!.to_address, ID: 'pm-2' };
const auth = { authorization: `Basic ${Buffer.from('postmark:test-hook-token').toString('base64')}` };
ok((await call('POST', '/webhooks/email/postmark', bounce, '', auth)).body.handled === 1, 'a hard bounce (Postmark basic auth)');
ok((await call('POST', '/webhooks/email/postmark', bounce, '', auth)).body.handled === 0, 'the same event twice changes nothing');
ok(await n(`SELECT count(*)::int AS n FROM app.contact_prefs WHERE address = $1 AND channel = 'email' AND bounced`, [one1!.to_address]) === 1, 'the address is marked bounced');
await db.run(OWNER, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1::uuid, 'email', $2, 'Next', 'Body', 'receipt'), ($1::uuid, 'email', $2, 'Your code', '123456', 'sign-in-code')`, params: [org, one1!.to_address] }]);
const d2 = await drainOutbox(db);
ok(d2.suppressed === 1 && d2.sent === 1, 'later mail to a bounced address is suppressed (a sign-in code still goes)', d2);
const sg = await call('POST', '/webhooks/email/sendgrid', [{ event: 'spamreport', sg_message_id: 'nope.filter0001', email: 'x@example.org', sg_event_id: 'sg-1' }], '', { 'x-webhook-token': 'test-hook-token' });
ok(sg.status === 200 && sg.body.handled === 0, 'an event for a message we never sent is ignored');

/* texts: STOP and START replies */
const m = await one<{ id: string; phone: string; email: string }>(db, OWNER, `SELECT id, phone, email FROM app.members WHERE phone <> '' AND archived IS NULL ORDER BY id LIMIT 1`);
const digits = m!.phone.replace(/\D/g, '').slice(-10);
await db.run(OWNER, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind, sent_at, status, provider_ref) VALUES ($1::uuid, 'sms', $2, '', 'Jumuah moved', 'bulk', now(), 'sent', 'SM-old')`, params: [org, digits] }]);
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const stop = await fetch(base + '/webhooks/sms/twilio', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ MessageSid: 'SM-in-1', From: `+1${digits}`, Body: 'Stop' }) });
ok(stop.status === 200 && (await stop.json()).handled === 1, 'STOP reply recorded (form post)');
ok(await n(`SELECT count(*)::int AS n FROM app.contact_prefs WHERE channel = 'sms' AND address = $1 AND unsubscribed`, [digits]) === 1, 'no more texts to that number');
ok(await n(`SELECT count(*)::int AS n FROM app.consents WHERE member_id = $1 AND kind = 'sms' AND NOT given`, [m!.id]) === 1, 'the member’s text consent is withdrawn');
await db.run(OWNER, [{ sql: `INSERT INTO platform.outbox (org_id, channel, to_address, subject, body, kind) VALUES ($1::uuid, 'sms', $2, '', 'Reminder', 'event-reminder')`, params: [org, digits] }]);
ok((await drainOutbox(db)).suppressed === 1, 'a later text is suppressed');
await fetch(base + '/webhooks/sms/twilio', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ MessageSid: 'SM-in-2', From: `+1${digits}`, Body: 'START' }) });
ok(await n(`SELECT count(*)::int AS n FROM app.contact_prefs WHERE channel = 'sms' AND address = $1 AND NOT unsubscribed`, [digits]) === 1, 'START turns texts back on');

/* renewal reminders on their day, once */
const r = await one<{ id: string; paid_through: string }>(db, OWNER, `SELECT id, paid_through::text FROM app.members WHERE archived IS NULL AND email <> '' AND paid_through IS NOT NULL AND status = 'active' ORDER BY paid_through, id LIMIT 1`);
const day = new Date(Date.parse(`${r!.paid_through}T12:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
const ctx = await systemContext(db, org, 'isgh');
const rr = await runRenewalJobs(ctx, day);
ok(rr.emails >= 1, `30 days before ${r!.paid_through}: ${rr.emails} reminder(s)`, rr);
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox o JOIN app.members x ON lower(x.email) = lower(o.to_address) WHERE x.id = $1 AND o.kind = 'renewal-reminder-1'`, [r!.id]) === 1, 'the member’s first reminder is queued');
ok(await n(`SELECT count(*)::int AS n FROM app.sent_notices WHERE member_id = $1 AND key = 'renewal-reminder-1'`, [r!.id]) === 1, 'and remembered');
ok((await runRenewalJobs(ctx, day)).emails === 0, 'never twice for the same term');

/* the runner: per tick and once a day */
const t1 = await tick(db, { now: new Date('2026-11-02T15:00:00Z') });
ok(typeof (t1.isgh as any).renewals === 'object' && (t1.isgh as any).renewals !== null && typeof (t1.isgh as any).helpdesk === 'object', 'first tick of the day runs the daily jobs', t1);
const t2 = await tick(db, { now: new Date('2026-11-02T15:01:00Z') });
ok((t2.isgh as any).renewals === null && (t2.isgh as any).events === null, 'the next tick that day does not', t2.isgh);
ok(await n(`SELECT count(*)::int AS n FROM platform.job_runs WHERE run_date = '2026-11-02' AND done_at IS NOT NULL`) >= 4, 'daily runs recorded');
ok(typeof (t1 as any).outbox?.claimed === 'number', 'and the outbox drained');

server.close(); await db.close();
console.log(`jobs ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
