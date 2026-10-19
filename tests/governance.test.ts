/**
 * B4e Voter list, elections and officials – black-box over HTTP on a migrated + seeded database.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/governance.test.ts
 */
process.env.AUTH_DEV_HEADER = '1'; process.env.AUTH_DEV_CODES = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one, rows } = await import('../src/db/sql.js');
const { MEMBER_SQL, toMember } = await import('../src/modules/member-shape.js');
const { eligibility, recordDate } = await import('@/lib/members/members');
const { MembershipSettingsSchema } = await import('@/lib/content/membership');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 600))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const call = async (method: string, path: string, body?: unknown, who: string | { cookie: string } = 'ec-chair') => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof who === 'string') { if (who) h['x-admin'] = who; } else h.cookie = who.cookie;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, body: j };
};
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(db, OWNER, sql, p))!.n;
const Y = 2026;

/* facts the test needs (computed the same way the API does) */
const ms = MembershipSettingsSchema.parse((await one<{ data: unknown }>(db, OWNER, `SELECT data FROM app.documents WHERE key = 'membership-settings' AND org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh')`))!.data);
const all = ((await rows(db, OWNER, `${MEMBER_SQL} WHERE m.org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh')`)) as any[]).map(toMember);   // ISGH's members only (other tests add organizations)
const elig = (m: any, y: number) => !m.archived && eligibility(m, y, ms.plans, ms.rules).eligible;
const standing = (m: any) => { let k = 0; for (let y = Y - 1; y >= Math.max(2000, m.joined || 2000); y--) { if (elig(m, y) && m.approvedOn && m.approvedOn <= recordDate(y)) k++; else break; } return k; };
const voters = all.filter((m) => elig(m, Y));
const taken = new Set(((await one<{ data: any }>(db, OWNER, `SELECT data FROM app.documents WHERE key = 'elections' AND org_id = (SELECT id FROM platform.organizations WHERE slug = 'isgh')`))!.data.elections.flatMap((e: any) => e.nominations.map((x: any) => x.memberId))));
const strong = voters.filter((m) => standing(m) >= 2 && !taken.has(m.id)).sort((x, y) => x.id.localeCompare(y.id))
  .filter((m) => m.email && all.filter((o) => o.email.toLowerCase() === m.email.toLowerCase()).length === 1).reverse();   // unique emails; from the end (other tests sign in from the start)
ok(voters.length > 20 && strong.length >= 4, `seeded voters: ${voters.length}, with 2+ years: ${strong.length}`);
const inN = strong.find((m) => m.zone === 'n'); const notN = strong.find((m) => m.zone !== 'n')!; const gs = strong.filter((m) => m !== inN && m !== notN);
const nonVoter = all.find((m) => !m.archived && !elig(m, Y) && m.email)!;

/* voter list */
ok((await call('GET', `/admin/voters/${Y}`, undefined, 'web-editor')).status === 403, 'website editors never see the voter list');
const v0 = await call('GET', `/admin/voters/${Y}`);
ok(v0.status === 200 && v0.body.eligibleNow === voters.length && v0.body.versions.length === 0 && v0.body.canFreeze, `eligible today: ${v0.body.eligibleNow}`, v0.body);
ok((await call('POST', `/admin/voters/${Y}/freeze`, {}, 'board-secretary')).status === 403, 'only the Election Commission freezes');
ok((await call('POST', `/admin/voters/2027/freeze`, {})).status === 409, 'not before the record date');
const f1 = await call('POST', `/admin/voters/${Y}/freeze`, {});
ok(f1.status === 201 && f1.body.version === 1 && /^[0-9a-f]{64}$/.test(f1.body.fingerprint) && f1.body.voters === voters.length, `frozen v1 (${f1.body.fingerprint?.slice(0, 12)}…)`, f1.body);
const vf = await call('GET', `/admin/voters/${Y}/1/verify`);
ok(vf.body.intact === true, 'the database recomputes the same fingerprint');
const csv = await call('GET', `/admin/voters/${Y}/1?format=csv`);
ok(csv.status === 200 && String(csv.body).startsWith('# Voter list') && !String(csv.body).includes('@') && String(csv.body).split('\r\n').length === voters.length + 2, 'CSV: ID, name, zone, masjid – no emails');
ok((await call('POST', `/admin/voters/${Y}/freeze`, { reason: 'Nothing changed at all here' })).status === 409, 'no new version without a change');
const out = voters.find((m) => m !== inN && m !== notN && !gs.slice(0, 2).includes(m))!;
await db.run(OWNER, [{ sql: `UPDATE app.members SET archived = '{"on":"2026-10-18","reason":"Moved away"}'::jsonb WHERE id = $1`, params: [out.id] }]);
ok((await call('POST', `/admin/voters/${Y}/freeze`, { reason: 'short' })).status === 400, 'a correction needs a reason');
const v1 = await call('GET', `/admin/voters/${Y}`);
ok(v1.body.sinceLast.removed.includes(out.id), 'the change since v1 is shown');
const f2 = await call('POST', `/admin/voters/${Y}/freeze`, { reason: 'Member moved out of the area before the record date (letter on file).' });
ok(f2.status === 201 && f2.body.version === 2 && f2.body.voters === voters.length - 1, 'v2 with the reason', f2.body);
ok(await n(`SELECT count(*)::int AS n FROM app.voter_snapshot_rows WHERE year = ${Y} AND version = 1`) === voters.length, 'v1 is kept unchanged');

/* nominations checked against the records */
const e0 = await call('GET', `/admin/elections/${Y}`);
ok(e0.status === 200 && e0.body.election.status === 'nominations' && e0.body.election.voters.count === voters.length - 1, 'the election shows the frozen count', e0.body.election?.voters);
const zdN = e0.body.election.seats.find((s: any) => s.key === 'zd:n');
let nominee: any = null;
if (inN) {
  const a = await call('POST', `/admin/elections/${Y}/nominations`, { seatKey: 'zd:n', memberId: inN.id, nominatedBy: 'A member' });
  ok(a.status === 201 && a.body.issues.length === 0, `${a.body.nomination?.name} may stand for Zonal Director, North`, a.body);
  nominee = a.body.nomination;
  ok((await call('POST', `/admin/elections/${Y}/nominations/${nominee.id}`, { status: 'accepted' })).status === 409, 'accepted only with a seconder');
  ok((await call('POST', `/admin/elections/${Y}/nominations/${nominee.id}`, { status: 'accepted', secondedBy: 'Second Member' })).status === 200, 'accepted with the seconder');
  const twice = await call('POST', `/admin/elections/${Y}/nominations`, { seatKey: 'officer:general-secretary', memberId: inN.id, nominatedBy: 'Someone' });
  ok(twice.body.issues.some((x: string) => x.includes('one seat per person')), 'one seat per person', twice.body.issues);
} else ok(!!zdN, 'no North voter with standing in the demo – zone seat checked below only');
const wrong = await call('POST', `/admin/elections/${Y}/nominations`, { seatKey: 'zd:n', memberId: notN.id, nominatedBy: 'Someone' });
ok(wrong.body.issues.includes('Does not live in the zone.'), 'a candidate from another zone is flagged', wrong.body.issues);
const nv = await call('POST', `/admin/elections/${Y}/nominations`, { seatKey: 'officer:general-secretary', memberId: nonVoter.id, nominatedBy: 'Someone', secondedBy: 'Other' });
ok(nv.body.issues.some((x: string) => x.includes('Not an eligible voting member')), 'a member not on the voter list cannot stand', nv.body.issues);
ok((await call('POST', `/admin/elections/${Y}/nominations/${nv.body.nomination.id}`, { status: 'accepted' })).status === 409, 'and cannot be accepted');
ok((await call('POST', `/admin/elections/${Y}/nominations`, { seatKey: 'nope', memberId: notN.id })).status === 422, 'only seats on the ballot');

/* a member nominates from the portal */
const voter = gs[0];
const st = await call('POST', '/auth/code/start', { address: voter.email }, '');
const vr = await fetch(base + '/auth/code/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: voter.email, code: st.body.devCode }) });
const jar = { cookie: (vr.headers.get('set-cookie') ?? '').match(/ms_sid=([^;]*)/)![0] };
const me = await call('GET', `/member/elections/${Y}`, undefined, jar);
ok(me.status === 200 && me.body.onVoterList === true && me.body.mySeats.some((s: any) => s.key === 'officer:president') && me.body.nominationsOpen, 'the member sees the seats they vote for', me.body);
ok(!me.body.mySeats.some((s: any) => s.key.startsWith('zd:') && s.key !== `zd:${voter.zone}`), 'never another zone’s seat');
const pn = await call('POST', `/member/elections/${Y}/nominations`, { seatKey: 'officer:general-secretary', nomineeId: gs[1].id, secondedBy: 'Third Member' }, jar);
ok(pn.status === 201, 'portal nomination received', pn.body);
ok((await call('POST', `/member/elections/${Y}/nominations`, { seatKey: 'officer:general-secretary', nomineeId: nonVoter.id }, jar)).status === 422, 'the portal refuses an ineligible nominee');

/* the ballot, the count, certification, swearing-in */
ok((await call('POST', `/admin/elections/${Y}/status`, { to: 'ballot' })).status === 409, 'the ballot waits for the end of nominations');
const doc = (await call('GET', `/admin/elections/${Y}`)).body.election;
for (const x of doc.nominations.filter((x: any) => x.status === 'nominated')) {
  const acc = x.id === pn.body.id;
  const r = await call('POST', `/admin/elections/${Y}/nominations/${x.id}`, acc ? { status: 'accepted' } : { status: 'declined', note: 'Did not accept the nomination.' });
  ok(r.status === 200, `nomination ${x.id} decided`, r.body);
}
ok((await call('POST', `/admin/elections/${Y}/status`, { to: 'voting' })).status === 409, 'steps go in order');
ok((await call('POST', `/admin/elections/${Y}/status`, { to: 'ballot', early: true })).body.election?.status === 'ballot', 'ballot set (early, by the Commission)');
ok((await call('POST', `/admin/elections/${Y}/results`, { seatKey: 'officer:president', ballotsCast: 10, counts: [] })).status === 409, 'no counts before voting');
ok((await call('POST', `/admin/elections/${Y}/status`, { to: 'voting' })).body.election.status === 'voting', 'voting');
const pubB = await call('GET', `/public/elections/${Y}`, undefined, '');
ok(pubB.status === 200 && pubB.body.seats.length > 0 && pubB.body.results === null && !JSON.stringify(pubB.body).includes('HOU-'), 'the website shows the ballot – names only, no results yet', pubB.body.seats?.[0]);
const ballot = (await call('GET', `/admin/elections/${Y}`)).body.election.ballot.filter((s: any) => !s.empty);
const pres = ballot.find((s: any) => s.seat.key === 'officer:president');
ok((await call('POST', `/admin/elections/${Y}/results`, { seatKey: 'officer:president', ballotsCast: 100, spoiled: 2, counts: pres.candidates.map((c: any) => ({ nominationId: c.id, votes: 60 })) })).status === 422, 'votes cannot exceed the ballots cast');
await call('POST', `/admin/elections/${Y}/results`, { seatKey: 'officer:president', ballotsCast: 100, spoiled: 2, counts: pres.candidates.map((c: any) => ({ nominationId: c.id, votes: 49 })) });
const tie = await call('POST', `/admin/elections/${Y}/results/${encodeURIComponent('officer:president')}/accept`, {});
ok(tie.status === 409 && tie.body.error.includes('Tie'), 'a tie is not decided by the system', tie.body);
const tb = await call('POST', `/admin/elections/${Y}/results/${encodeURIComponent('officer:president')}/accept`, { winners: [pres.candidates[1].id] });
ok(tb.status === 200 && tb.body.tally.rows.find((r: any) => r.winner)?.nomination.id === pres.candidates[1].id, 'the run-off winner is recorded', tb.body);
for (const s of ballot.filter((s: any) => s.seat.key !== 'officer:president')) {
  await call('POST', `/admin/elections/${Y}/results`, { seatKey: s.seat.key, ballotsCast: 300, spoiled: 1, counts: s.candidates.map((c: any, i: number) => ({ nominationId: c.id, votes: 70 - i * 10 })) });
  const a = await call('POST', `/admin/elections/${Y}/results/${encodeURIComponent(s.seat.key)}/accept`, {});
  ok(a.status === 200, `count accepted: ${s.seat.label}`, a.body);
}
ok((await call('POST', `/admin/elections/${Y}/results`, { seatKey: 'officer:president', ballotsCast: 100, counts: [] })).status === 409, 'an accepted count does not change');
const cert = await call('POST', `/admin/elections/${Y}/status`, { to: 'certified', note: 'Certified at the count, 13 December.' });
ok(cert.status === 200 && cert.body.election.certification.on, 'certified', cert.body);
const pubR = await call('GET', `/public/elections/${Y}`, undefined, '');
ok(Array.isArray(pubR.body.results) && pubR.body.results.some((r: any) => r.rows.some((x: any) => x.winner)), 'results on the website after certification');
ok((await call('POST', `/admin/elections/${Y}/swear-in`, {}, 'board-secretary')).status === 403, 'swearing-in needs officials.manage');
const sw = await call('POST', `/admin/elections/${Y}/swear-in`, {});
ok(sw.status === 200 && sw.body.swornIn.length >= ballot.length, `${sw.body.swornIn?.length} officials sworn in`, sw.body);
ok(await n(`SELECT count(*)::int AS n FROM app.official_terms WHERE status = 'serving' AND source = 'admin' AND how = 'elected' AND term_start > '2026-12-31'`) >= sw.body.swornIn.length, 'they are the serving officials (projected)');
ok(await n(`SELECT count(*)::int AS n FROM app.official_terms WHERE status = 'ended' AND source = 'archived'`) >= 1, 'the people they follow are in the history');
ok((await call('GET', `/admin/elections/${Y}`)).body.election.status === 'closed', 'election closed');
ok(await n(`SELECT count(*)::int AS n FROM app.audit_log WHERE area = 'elections'`) >= 15, 'every step is in the audit log');

server.close(); await db.close();
console.log(`governance ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
