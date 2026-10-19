/**
 * B4a Help desk + Team tasks – black-box over HTTP on a migrated + seeded database.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/helpdesk.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, who: string | { cookie: string } = 'owner') => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof who === 'string') { if (who) h['x-admin'] = who; } else h.cookie = who.cookie;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any, cookie: (r.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)?.[0] ?? '' };
};
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(db, OWNER, sql, p))!.n;
const SE1 = 'Southeast Islamic Center 1';

/* office creates a phone ticket → routed by category */
const t1 = await call('POST', '/admin/helpdesk/tickets', { subject: 'Card did not arrive', detail: 'Renewed in September, no card yet.', categoryId: 'membership', channel: 'phone', name: 'Bilal Haddad', email: 'bilal.h@example.org', center: SE1 });
ok(t1.status === 201 && /^T-\d+$/.test(t1.body.ticket.id) && t1.body.ticket.assignee === 'membership-office', 'phone ticket routed to the membership office', t1.body);
const id1 = t1.body.ticket.id as string;
ok((await call('POST', '/admin/helpdesk/tickets', { subject: 'xx', detail: 'x', categoryId: 'membership', name: 'B' })).status === 400, 'bad ticket refused');
ok((await call('POST', '/admin/helpdesk/tickets', { subject: 'Some subject', detail: 'Some detail', categoryId: 'nope', name: 'Bilal' })).status === 400, 'unknown category refused');
ok((await call('POST', '/admin/helpdesk/tickets', { subject: 'Some subject', detail: 'Some detail', categoryId: 'membership', name: 'Bilal', center: 'Moon Masjid' })).status === 400, 'unknown masjid refused');
ok((await call('POST', '/admin/helpdesk/tickets', { subject: 'Some subject', detail: 'Some detail', categoryId: 'membership', name: 'Bilal', center: 'North Islamic Center 1' }, 'ad-se1')).status === 403, 'a masjid role creates tickets for its own masjid only');

const list = await call('GET', '/admin/helpdesk/tickets');
const row = list.body.tickets?.find((t: any) => t.id === id1);
ok(list.status === 200 && !!row && row.clocks?.first && row.clocks?.solve && row.events === undefined, 'list shows both clocks, no thread', list.body);
ok((await call('GET', '/admin/helpdesk/tickets?view=unassigned')).body.tickets.every((t: any) => !t.assignee), 'unassigned view');
const stats = await call('GET', '/admin/helpdesk/stats');
ok(stats.status === 200 && typeof stats.body === 'object', 'stats');
ok((await call('GET', '/admin/helpdesk/tickets', undefined, 'katy-door')).status === 403, 'check-in volunteers do not see the help desk');

/* reply goes to the requester (outbox), note stays inside and tells mentioned people */
const before = await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'bilal.h@example.org'`);
const rep = await call('POST', `/admin/helpdesk/tickets/${id1}/replies`, { text: 'Assalamu alaikum Bilal, your card is printed and goes out Monday.', status: 'waiting' });
ok(rep.status === 201 && rep.body.ticket.status === 'waiting' && !!rep.body.ticket.firstResponseAt, 'reply → waiting, first response stamped', rep.body);
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'bilal.h@example.org' AND kind = 'ticket-reply'`) === before + 1, 'the reply is queued as email');
ok((await call('POST', `/admin/helpdesk/tickets/${id1}/replies`, { text: 'Hello {{first_name}} and {{nothing}}' })).status === 400, 'unfilled placeholders refused');
const note = await call('POST', `/admin/helpdesk/tickets/${id1}/notes`, { text: 'Checked the print batch, @treasurer please confirm the payment.' });
ok(note.status === 201 && note.body.ticket.watchers.includes('treasurer'), 'mention makes a watcher', note.body);
ok(await n(`SELECT count(*)::int AS n FROM app.notices WHERE admin_id = 'treasurer' AND kind = 'mention'`) === 1, 'mentioned person gets a notice');
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'bilal.h@example.org'`) === before + 1, 'a note never leaves');
const got = await call('GET', `/admin/helpdesk/tickets/${id1}`);
ok(got.status === 200 && got.body.ticket.events.length >= 3 && got.body.ticket.events.every((e: any) => e.id.startsWith('db')), `thread kept (${got.body.ticket?.events?.length} events)`);

/* patch: owner, priority, tags, solved + rating */
const pt = await call('PATCH', `/admin/helpdesk/tickets/${id1}`, { assignee: 'front-office', priority: 'high', tags: ['Card Print', 'renewal'] });
ok(pt.status === 200 && pt.body.ticket.assignee === 'front-office' && pt.body.ticket.priority === 'high' && pt.body.ticket.tags.includes('card-print'), 'owner, priority, tags', pt.body);
ok((await call('PATCH', `/admin/helpdesk/tickets/${id1}`, { assignee: 'nobody-here' })).status === 400, 'owner must be an active admin');
ok((await call('PATCH', `/admin/helpdesk/tickets/${id1}`, { colour: 'red' })).status === 400, 'unknown fields refused');

/* restricted: only the people involved and senior roles */
const c = await call('POST', '/admin/helpdesk/tickets', { subject: 'Complaint about a volunteer', detail: 'Rude at the door on Friday.', categoryId: 'conduct', name: 'Anon Sister', phone: '713-555-0100' });
ok(c.status === 201 && c.body.ticket.restricted === true && c.body.ticket.assignee === 'gen-secretary', 'conduct ticket is restricted and goes to the General Secretary', c.body);
const cid = c.body.ticket.id;
ok((await call('GET', `/admin/helpdesk/tickets/${cid}`, undefined, 'membership-office')).status === 404, 'others do not even learn it exists');
ok(!(await call('GET', '/admin/helpdesk/tickets', undefined, 'membership-office')).body.tickets.some((t: any) => t.id === cid), 'not in their list');
ok((await call('GET', `/admin/helpdesk/tickets/${cid}`, undefined, 'gen-secretary')).status === 200, 'the owner sees it');
ok((await call('GET', `/admin/helpdesk/tickets/${cid}`, undefined, 'president')).status === 200, 'a senior role sees it');

/* merge + bulk */
const dup = await call('POST', '/admin/helpdesk/tickets', { subject: 'Where is my card', detail: 'Calling again about the card.', categoryId: 'membership', name: 'Bilal Haddad', email: 'bilal.h@example.org' });
const mg = await call('POST', `/admin/helpdesk/tickets/${dup.body.ticket.id}/merge`, { into: id1 });
ok(mg.status === 200 && mg.body.into === id1, 'duplicate merged', mg.body);
const dupNow = await call('GET', `/admin/helpdesk/tickets/${dup.body.ticket.id}`);
ok(dupNow.body.ticket.mergedInto === id1 && dupNow.body.ticket.status === 'closed', 'the duplicate is closed and points to the main ticket', dupNow.body.ticket);
ok((await call('PATCH', `/admin/helpdesk/tickets/${dup.body.ticket.id}`, { priority: 'low' })).status === 409, 'a merged ticket cannot change');
const bk = await call('POST', '/admin/helpdesk/bulk', { ids: [id1, cid, 'T-999999'], priority: 'urgent' }, 'membership-office');
ok(bk.status === 200 && bk.body.changed === 1, 'bulk skips what you cannot see and what does not exist', bk.body);

/* ticket → team task, done task writes back to the ticket */
const tk = await call('POST', `/admin/helpdesk/tickets/${id1}/task`, { owner: 'treasurer', due: '2026-11-02' });
ok(tk.status === 201 && tk.body.task.owner === 'treasurer' && tk.body.task.links.some((l: any) => l.kind === 'ticket' && l.id === id1), 'ticket → task', tk.body);
ok((await call('GET', `/admin/helpdesk/tickets/${id1}`)).body.ticket.links.some((l: any) => l.kind === 'task'), 'the ticket links the task');
const mine = await call('GET', '/admin/tasks?owner=me', undefined, 'treasurer');
ok(mine.status === 200 && mine.body.tasks.some((t: any) => t.id === tk.body.task.id && t.bucket), 'the task is on the treasurer’s list', mine.body);
const dn = await call('POST', `/admin/tasks/${tk.body.task.id}/done`, {}, 'treasurer');
ok(dn.status === 200 && dn.body.status === 'done', 'task done', dn.body);
ok((await call('GET', `/admin/helpdesk/tickets/${id1}`)).body.ticket.events.some((e: any) => e.kind === 'note' && e.text.startsWith('Team task done')), 'the ticket hears about it');
ok((await call('POST', `/admin/tasks/${tk.body.task.id}/reopen`, {}, 'treasurer')).body.status === 'todo', 'reopen');

/* solve + rating */
const sv = await call('PATCH', `/admin/helpdesk/tickets/${id1}`, { status: 'solved', csat: { score: 'good', comment: 'Fast, thank you' } });
ok(sv.status === 200 && sv.body.ticket.status === 'solved' && !!sv.body.ticket.solvedAt && sv.body.ticket.csat?.score === 'good', 'solved and rated', sv.body);
const jobs = await call('POST', '/admin/helpdesk/run-jobs', {});
ok(jobs.status === 200 && typeof jobs.body.closed === 'number' && typeof jobs.body.escalated === 'number', `jobs ran (${JSON.stringify(jobs.body)})`);
ok((await call('POST', '/admin/helpdesk/run-jobs', {}, 'front-office')).status === 403, 'jobs need settings.manage');

/* website form */
const cats = await call('GET', '/public/helpdesk');
ok(cats.body.categories.some((x: any) => x.id === 'feedback'), 'public topics');
const pub = await call('POST', '/public/helpdesk/tickets', { categoryId: 'feedback', subject: 'Parking idea', detail: 'Please add a second entry gate on Fridays.', name: 'Hana Ali', email: 'hana.ali@example.org', center: SE1 }, '');
ok(pub.status === 201 && /^T-\d+$/.test(pub.body.reference), `website ticket ${pub.body.reference}`, pub.body);
ok(await n(`SELECT count(*)::int AS n FROM platform.outbox WHERE to_address = 'hana.ali@example.org'`) === 1, 'acknowledgement queued');
ok(await n(`SELECT count(*)::int AS n FROM app.hd_tickets WHERE id = $1 AND channel = 'website' AND center_id IS NOT NULL`, [pub.body.reference]) === 1, 'kept with its masjid');
ok((await call('POST', '/public/helpdesk/tickets', { categoryId: 'feedback', subject: 'Spam', detail: 'buy cheap things now', name: 'Bot', email: 'b@example.org', website: 'http://spam' }, '')).body.reference === 'T-0000', 'honeypot');
ok((await call('POST', '/public/helpdesk/tickets', { categoryId: 'nope', subject: 'Hello there', detail: 'A question for you all.', name: 'Hana', email: 'hana.ali@example.org' }, '')).status === 422, 'unknown topic refused');
ok((await call('POST', '/public/helpdesk/tickets', { categoryId: 'feedback', subject: 'Hello', detail: 'short', name: 'Hana', email: 'not-an-email' }, '')).status === 422, 'bad form refused');

/* member portal */
const mem = await one<{ id: string; email: string }>(db, OWNER, `SELECT m.id, m.email FROM app.members m WHERE m.status = 'active' AND m.archived IS NULL AND m.email <> '' AND NOT EXISTS (SELECT 1 FROM app.members x WHERE lower(x.email) = lower(m.email) AND x.id <> m.id) ORDER BY m.id LIMIT 1`);
const st = await call('POST', '/auth/code/start', { address: mem!.email }, '');
const jar = { cookie: (await call('POST', '/auth/code/verify', { address: mem!.email, code: st.body.devCode }, '')).cookie };
const mt = await call('POST', '/member/helpdesk/tickets', { categoryId: 'membership', subject: 'Add my son to the household', detail: 'He turned 18 this month, please add him.', name: 'ignored', email: 'ignored@example.org' }, jar);
ok(mt.status === 201, 'member ticket from the portal', mt.body);
ok(await n(`SELECT count(*)::int AS n FROM app.hd_tickets WHERE id = $1 AND member_id = $2 AND channel = 'portal' AND requester_email = $3`, [mt.body.reference, mem!.id, mem!.email]) === 1, 'the member’s own name and email are used');
const ml = await call('GET', '/member/helpdesk/tickets', undefined, jar);
ok(ml.status === 200 && ml.body.tickets.some((t: any) => t.id === mt.body.reference && t.messages.length === 1), 'member sees their request', ml.body);
await call('POST', `/admin/helpdesk/tickets/${mt.body.reference}/notes`, { text: 'Internal: check his age proof.' });
await call('POST', `/admin/helpdesk/tickets/${mt.body.reference}/replies`, { text: 'Please upload his ID from your member home.' });
const ml2 = await call('GET', '/member/helpdesk/tickets', undefined, jar);
const mv = ml2.body.tickets.find((t: any) => t.id === mt.body.reference);
ok(mv.messages.length === 2 && !JSON.stringify(mv).includes('Internal'), 'the member sees replies, never notes', mv);
const mr = await call('POST', `/member/helpdesk/tickets/${mt.body.reference}/reply`, { text: 'Uploaded it just now.' }, jar);
ok(mr.status === 201 && mr.body.messages.length === 3, 'member answers', mr.body);
ok((await call('POST', `/member/helpdesk/tickets/${id1}/reply`, { text: 'Not mine' }, jar)).status === 404, 'not someone else’s ticket');
ok((await call('GET', '/member/helpdesk/tickets', undefined, '')).status === 401, 'portal needs a member session');

/* team tasks */
const nt = await call('POST', '/admin/tasks', { title: 'Weekly cash count', owner: 'fs-se1', due: '2026-10-23', repeat: { every: 'week', interval: 1 } }, 'treasurer');
ok(nt.status === 201 && nt.body.task.owner === 'fs-se1', 'task created', nt.body);
ok((await call('POST', '/admin/tasks', { title: 'Bad date', due: '23/10/2026' }, 'treasurer')).status === 400, 'bad date refused');
ok((await call('POST', '/admin/tasks', { title: 'Ghost owner', owner: 'ghost' }, 'treasurer')).status === 400, 'owner must be an admin');
const done = await call('POST', `/admin/tasks/${nt.body.task.id}/done`, {}, 'fs-se1');
ok(done.status === 200 && done.body.next?.due === '2026-10-30', 'a repeating task makes the next one a week later', done.body);
ok((await call('PATCH', `/admin/tasks/${nt.body.task.id}`, { status: 'done' }, 'fs-se1')).status === 400, 'done goes through /done');
const pc = await call('PATCH', `/admin/tasks/${done.body.next.id}`, { priority: 'high', notes: 'Count both safes.' }, 'fs-se1');
ok(pc.status === 200 && pc.body.task.priority === 'high', 'task changed', pc.body);
const cm = await call('POST', `/admin/tasks/${done.body.next.id}/comments`, { text: 'Can @front-office help on Friday?' }, 'fs-se1');
ok(cm.status === 201 && cm.body.helpersAdded.includes('front-office'), 'mention adds a helper', cm.body);
ok((await call('GET', '/admin/tasks', undefined, 'front-office')).body.tasks.some((t: any) => t.id === done.body.next.id), 'the helper now sees it');
ok(!(await call('GET', '/admin/tasks', undefined, 'web-editor')).body.tasks.some((t: any) => t.id === done.body.next.id), 'others do not');
ok((await call('DELETE', `/admin/tasks/${done.body.next.id}`, undefined, 'front-office')).status === 403, 'a helper cannot delete');
ok((await call('DELETE', `/admin/tasks/${done.body.next.id}`, undefined, 'treasurer')).status === 200, 'the creator can');

/* projects */
const pj = await call('POST', '/admin/tasks/projects', { name: 'Masjid open house', center: SE1, visibility: 'masjid' }, 'ad-se1');
ok(pj.status === 201 && pj.body.project.visibility === 'masjid', 'masjid project', pj.body);
ok((await call('POST', '/admin/tasks/projects', { name: 'Someone else’s', center: 'North Islamic Center 1' }, 'ad-se1')).status === 403, 'a masjid role keeps projects at its masjid');
const tp = await call('POST', '/admin/tasks/projects/from-template', { templateId: 'eid-prayer', anchor: '2027-03-20', center: SE1 }, 'ad-se1');
ok(tp.status === 201 && tp.body.tasks > 3, `Eid project from the template (${tp.body.tasks} tasks)`, tp.body);
ok(await n(`SELECT count(*)::int AS n FROM app.tasks WHERE project_id = $1 AND due IS NOT NULL`, [tp.body.project.id]) === tp.body.tasks, 'every template task has a date from the anchor');
ok((await call('POST', '/admin/tasks/projects/from-template', { templateId: 'eid-prayer', anchor: 'soon', center: SE1 }, 'ad-se1')).status === 400, 'template needs its date');
const pl = await call('GET', '/admin/tasks/projects', undefined, 'ad-se1');
ok(pl.status === 200 && pl.body.projects.some((p: any) => p.id === tp.body.project.id && p.progress), 'projects with progress', pl.body);
ok((await call('PATCH', `/admin/tasks/projects/${tp.body.project.id}`, { archived: true }, 'fs-se1')).status !== 200, 'only the owner changes the project');
ok((await call('PATCH', `/admin/tasks/projects/${tp.body.project.id}`, { name: 'Eid al-Fitr 1448' }, 'ad-se1')).status === 200, 'owner renames it');

/* C4b: what the admin's screens use in live mode */
const anyList = await call('GET', '/admin/helpdesk/tickets?view=any&full=1');
const openList = await call('GET', '/admin/helpdesk/tickets');
ok(anyList.body.count >= openList.body.count && anyList.body.tickets.every((t: any) => Array.isArray(t.events)) && !openList.body.tickets.some((t: any) => t.events), `view=any&full=1: every ticket with its thread (${anyList.body.count} ≥ ${openList.body.count} open)`);
const rq1 = anyList.body.tickets.find((t: any) => !t.mergedInto && !['closed'].includes(t.status));
const rr = await call('POST', `/admin/helpdesk/tickets/${rq1.id}/requester`, { text: 'Called back: the card arrived today.' });
ok(rr.status === 201 && rr.body.ticket.events.some((e: any) => e.kind === 'requester' && e.text.startsWith('Called back')), 'the requester’s phone answer is logged');
ok((await call('POST', `/admin/helpdesk/tickets/${rq1.id}/requester`, { text: '' })).status === 400, 'with something said');
const named = await call('POST', '/admin/tasks', { id: 'task-from-screen-1', title: 'Order new name badges' });
ok(named.status === 201 && named.body.task.id === 'task-from-screen-1', 'a task keeps the id the screen gave it');
ok((await call('POST', '/admin/tasks', { id: 'task-from-screen-1', title: 'Same id again' })).body.task.id !== 'task-from-screen-1', 'an id already used gets a new one');
ok((await call('POST', '/admin/tasks', { id: 'DROP TABLE', title: 'Odd id' })).body.task.id.startsWith('task-'), 'odd ids are ignored');
const ord = await call('PATCH', '/admin/tasks/task-from-screen-1', { order: 7 });
ok(ord.status === 200 && (await call('GET', '/admin/tasks')).body.tasks.find((t: any) => t.id === 'task-from-screen-1')?.order === 7, 'board order is saved');
const pj2 = await call('POST', '/admin/tasks/projects', { id: 'prj-from-screen-1', name: 'Open house' });
ok(pj2.status === 201 && pj2.body.project.id === 'prj-from-screen-1', 'a project keeps its id too');

server.close(); await db.close();
console.log(`helpdesk ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
