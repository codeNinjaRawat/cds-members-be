/**
 * B4e Officials, elections and the voter list. Elections and officials are documents (`elections`, `officials`) checked by
 * the admin's own rules (web/src/lib/community/elections.ts, officials.ts); what must be facts comes from the database:
 * who is an eligible voter (the frozen voter list), years in good standing, where a candidate lives, who holds an office.
 *
 * Voter list (Election Commission: voters.freeze; reports.view may read)
 *   GET  /admin/voters/:year                       versions with fingerprints, today's eligible count, changes since the last version
 *   POST /admin/voters/:year/freeze {reason?}       a new version after the record date (a correction needs a reason)
 *   GET  /admin/voters/:year/:version[?format=csv]  ID, name, zone, masjid only · GET …/verify recomputes the fingerprint
 * Elections (voters.freeze or officials.manage)
 *   POST /admin/elections {year}                     seats from the configuration (parity by year, Area Rep seats from voter counts)
 *   GET  /admin/elections/:year                      ballot, tallies, warnings, turnout
 *   POST /admin/elections/:year/nominations          {seatKey, memberId, nominatedBy, secondedBy} → nomination + eligibility issues from the records
 *   POST /admin/elections/:year/nominations/:id      {status, note, secondedBy?}  (accepted only without issues)
 *   POST /admin/elections/:year/status {to}          planning → nominations → ballot → voting → counting → certified
 *   POST /admin/elections/:year/results              {seatKey, ballotsCast, spoiled, counts[]} · POST …/results/:seatKey/accept {winners?}
 *   POST /admin/elections/:year/swear-in             certified winners become the serving officials; the people they follow go into the history
 * Website and portal
 *   GET  /public/elections/:year                    ballot (accepted candidates) and, once certified, the results
 *   GET  /member/elections/:year · POST /member/elections/:year/nominations {seatKey, nomineeId?, secondedBy?}
 */
import { z } from 'zod';
import { one, rows } from '../db/sql.js';
import { HttpError, audit, document, need, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { saveDocument } from './projections.js';
import { MEMBER_SQL, toMember, type MemberRow } from './member-shape.js';
import { can } from '@/lib/community/access';
import * as E from '@/lib/community/elections';
import * as O from '@/lib/community/officials';
import { MembershipSettingsSchema, mockMembershipSettings } from '@/lib/content/membership';
import { eligibility, recordDate, type Member } from '@/lib/members/members';
import { OrgStructureSchema, mockOrgStructure } from '@/lib/community/org-structure';
import { sha256hex } from '../auth/crypto.js';

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
const body = (ctx: Ctx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
const has = (ctx: Ctx, p: Parameters<typeof need>[1]) => !!ctx.me && can(ctx.access, ctx.me, p, todayCT());
const needEC = (ctx: Ctx) => { if (!has(ctx, 'voters.freeze') && !has(ctx, 'officials.manage')) need(ctx, 'voters.freeze'); };
const fp = (ids: string[]) => sha256hex([...ids].sort().join('\n'));   // same rule as the admin (reports.ts fingerprint) and app.voter_fingerprint()

/* ---------------- facts from the records ---------------- */
async function membership(ctx: Ctx) { const p = MembershipSettingsSchema.safeParse(await document(ctx.db, ctx.orgId, 'membership-settings')); const s = p.success ? p.data : mockMembershipSettings; return { plans: s.plans, rules: s.rules }; }
async function members(ctx: Ctx, where = '', params: unknown[] = []): Promise<Member[]> { return ((await rows(ctx.db, API(ctx), `${MEMBER_SQL} ${where}`, params)) as MemberRow[]).map(toMember); }
async function zoneNames(ctx: Ctx) { return new Map(((await rows(ctx.db, API(ctx), 'SELECT code, name FROM app.zones')) as { code: string; name: string }[]).map((z) => [z.code, z.name])); }
type MS = Awaited<ReturnType<typeof membership>>;
const eligibleIn = (m: Member, y: number, ms: MS) => !m.archived && eligibility(m, y, ms.plans, ms.rules).eligible;
/** Years in a row before the election year the member was an eligible voter (and already approved by that record date). */
function standing(m: Member, year: number, ms: MS) { let n = 0; for (let y = year - 1; y >= Math.max(2000, m.joined || 2000); y--) { if (eligibleIn(m, y, ms) && !!m.approvedOn && m.approvedOn <= recordDate(y)) n++; else break; } return n; }
async function latestSnapshot(ctx: Ctx, year: number) { return one<{ version: number; voters: number; fingerprint: string; frozen_at: string }>(ctx.db, API(ctx), 'SELECT version, voters, fingerprint, frozen_at::text FROM app.voter_snapshots WHERE year = $1 ORDER BY version DESC LIMIT 1', [year]); }
async function officials(ctx: Ctx): Promise<O.Officials> { const p = O.OfficialsSchema.safeParse(await document(ctx.db, ctx.orgId, 'officials')); return p.success ? p.data : O.mockOfficials; }
async function electionsDoc(ctx: Ctx): Promise<E.ElectionsDoc> { const p = E.ElectionsSchema.safeParse(await document(ctx.db, ctx.orgId, 'elections')); return p.success ? p.data : E.mockElections; }
async function electionOf(ctx: Ctx, year: number) { const doc = await electionsDoc(ctx); const e = doc.elections.find((x) => x.year === year); if (!e) throw new HttpError(404, `No election for ${year}.`); return { doc, e }; }
async function saveElection(ctx: Ctx, doc: E.ElectionsDoc, e: E.Election, note: string) {
  const next = { ...doc, elections: doc.elections.some((x) => x.year === e.year) ? doc.elections.map((x) => (x.year === e.year ? e : x)) : [...doc.elections, e] };
  const p = E.ElectionsSchema.safeParse(next); if (!p.success) throw new HttpError(422, p.error.issues[0].message, issues(p.error));
  await saveDocument(ctx.db, ctx.orgId, 'elections', p.data, ctx.me?.name ?? 'Member', note);
  return p.data.elections.find((x) => x.year === e.year)!;
}
/** Everything nominationIssues needs about one candidate. Voter status comes from the frozen list once there is one. */
async function factsFor(ctx: Ctx, memberId: string, year: number): Promise<E.CandidateFacts | null> {
  const m = (await members(ctx, 'WHERE m.id = $1', [memberId]))[0]; if (!m) return null;
  const ms = await membership(ctx); const snap = await latestSnapshot(ctx, year);
  const onList = snap ? !!(await one(ctx.db, API(ctx), 'SELECT 1 AS x FROM app.voter_snapshot_rows WHERE year = $1 AND version = $2 AND member_id = $3', [year, snap.version, m.id])) : eligibleIn(m, year, ms);
  const off = await officials(ctx); const oath = O.oathDay(year, off.eidDates);
  const held = off.holders.find((h) => h.status === 'serving' && h.memberId === m.id && h.kind !== 'secretary' && (!h.termEnd || h.termEnd > oath));
  return { eligibleVoter: onList, standingYears: standing(m, year, ms), zone: m.zone, center: m.center, zip: m.zip, holdsOffice: held ? O.seatLabel(held) : undefined };
}
const view = (e: E.Election, today: string) => ({ ...e, statusLabel: E.ELECTION_STATUS[e.status], window: E.nominationWindow(e), nominationsOpen: E.nominationsOpen(e, today), ballot: E.ballot(e),
  tallies: e.seats.filter((s) => !s.removed).map((s) => E.tally(e, s.key)), warnings: E.electionWarnings(e, today), turnout: E.turnout(e) });

/** A nomination id no other nomination of this election uses (imported or older ones keep theirs). */
async function nominationId(ctx: Ctx, e: E.Election) {
  for (;;) { const id = `nom-${(await one<{ n: string }>(ctx.db, API(ctx), `SELECT app.next_no($1::uuid, $2, 1)::text AS n`, [ctx.orgId, `nomination-${e.year}`]))!.n}`; if (!e.nominations.some((x) => x.id === id)) return id; }
}
const ORDER: E.Election['status'][] = ['planning', 'nominations', 'ballot', 'voting', 'counting', 'certified', 'closed'];
const YEAR = '(\\d{4})';

export const GOVERNANCE_ROUTES: Route[] = [
  /* ---------------- voter list ---------------- */
  route('GET', new RegExp(`^/admin/voters/${YEAR}$`), async (ctx, mm) => {
    if (!has(ctx, 'voters.freeze')) need(ctx, 'reports.view');
    const year = Number(mm[1]); const ms = await membership(ctx); const zn = await zoneNames(ctx);
    const versions = await rows(ctx.db, API(ctx), 'SELECT version, record_date::text AS "recordDate", frozen_at::text AS "frozenAt", frozen_by AS "frozenBy", reason, voters, fingerprint FROM app.voter_snapshots WHERE year = $1 ORDER BY version', [year]) as { version: number }[];
    const all = await members(ctx); const now = all.filter((m) => eligibleIn(m, year, ms));
    const last = versions.length ? versions[versions.length - 1].version : 0;
    const frozen = last ? new Set(((await rows(ctx.db, API(ctx), 'SELECT member_id FROM app.voter_snapshot_rows WHERE year = $1 AND version = $2', [year, last])) as { member_id: string }[]).map((r) => r.member_id)) : null;
    const nowIds = new Set(now.map((m) => m.id));
    const name = (m: Member) => `${m.first} ${m.last}`;
    return { status: 200, body: { year, recordDate: recordDate(year), canFreeze: todayCT() > recordDate(year), versions,
      eligibleNow: now.length, byZone: Array.from(zn.entries()).map(([code, n]) => ({ zone: n, voters: now.filter((m) => m.zone === code).length })),
      approvedAfterRecord: now.filter((m) => m.approvedOn && m.approvedOn > recordDate(year)).map((m) => ({ id: m.id, name: name(m), approvedOn: m.approvedOn })),
      sinceLast: frozen ? { added: now.filter((m) => !frozen.has(m.id)).map((m) => ({ id: m.id, name: name(m) })), removed: Array.from(frozen).filter((id) => !nowIds.has(id)) } : null } };
  }),
  route('POST', new RegExp(`^/admin/voters/${YEAR}/freeze$`), async (ctx, mm) => {
    need(ctx, 'voters.freeze');
    const year = Number(mm[1]); if (todayCT() <= recordDate(year)) throw new HttpError(409, `The voter list is frozen after the record date (${recordDate(year)}).`);
    const prev = await latestSnapshot(ctx, year); const version = (prev?.version ?? 0) + 1;
    const reason = String(body(ctx).reason ?? '').trim();
    if (version > 1 && reason.length < 10) throw new HttpError(400, 'A new version of the voter list needs a reason (at least 10 characters).');
    const ms = await membership(ctx); const zn = await zoneNames(ctx);
    const voters = (await members(ctx)).filter((m) => eligibleIn(m, year, ms));
    const print = fp(voters.map((m) => m.id));
    if (prev && prev.fingerprint === print) throw new HttpError(409, 'Nothing changed since the last version.');
    const rowsJson = JSON.stringify(voters.map((m) => ({ member_id: m.id, name: `${m.first} ${m.last}`, zip: m.zip, center: m.center, zone: m.zone })));
    await ctx.db.run(API(ctx), [
      { sql: `INSERT INTO app.voter_snapshots (org_id, year, version, record_date, frozen_by, reason, voters, sha256, fingerprint) VALUES ($1::uuid, $2::int, $3::int, $4::date, $5, $6, $7::int, decode($8, 'hex'), $8)`,
        params: [ctx.orgId, year, version, recordDate(year), ctx.me!.name, version === 1 ? (reason || 'Frozen after the record date') : reason, voters.length, print] },
      { sql: `INSERT INTO app.voter_snapshot_rows (org_id, year, version, member_id, name, zip, center_id, zone_id)
        SELECT $1::uuid, $2::int, $3::int, r.member_id, r.name, r.zip, (SELECT c.id FROM app.centers c WHERE c.name = r.center), (SELECT z.id FROM app.zones z WHERE z.code = r.zone)
        FROM jsonb_to_recordset($4::jsonb) AS r(member_id text, name text, zip text, center text, zone text)`, params: [ctx.orgId, year, version, rowsJson] }]);
    const check = (await one<{ f: string }>(ctx.db, API(ctx), 'SELECT app.voter_fingerprint($1::int, $2::int) AS f', [year, version]))!.f;
    if (check !== print) throw new HttpError(500, 'The stored list does not match its fingerprint.');
    // the election of that year shows the frozen count
    const doc = await electionsDoc(ctx); const e = doc.elections.find((x) => x.year === year);
    if (e) await saveElection(ctx, doc, { ...e, voters: { frozenOn: todayCT(), count: voters.length } }, `Voter list v${version}`);
    await audit(ctx, 'elections', version === 1 ? 'Voter list frozen' : 'Voter list corrected', `${year} v${version}: ${voters.length} voters, ${print.slice(0, 12)}…${reason ? ` – ${reason}` : ''}`, String(year));
    void zn;
    return { status: 201, body: { year, version, voters: voters.length, fingerprint: print } };
  }),
  route('GET', new RegExp(`^/admin/voters/${YEAR}/(\\d+)(/verify)?$`), async (ctx, mm) => {
    if (!has(ctx, 'voters.freeze')) need(ctx, 'reports.view');
    const year = Number(mm[1]), version = Number(mm[2]);
    const snap = await one<{ fingerprint: string; voters: number }>(ctx.db, API(ctx), 'SELECT fingerprint, voters FROM app.voter_snapshots WHERE year = $1 AND version = $2', [year, version]); if (!snap) throw new HttpError(404, 'No such version.');
    if (mm[3]) { const f = (await one<{ f: string }>(ctx.db, API(ctx), 'SELECT app.voter_fingerprint($1::int, $2::int) AS f', [year, version]))!.f; return { status: 200, body: { stored: snap.fingerprint, recomputed: f, intact: f === snap.fingerprint } }; }
    const list = (await rows(ctx.db, API(ctx), `SELECT r.member_id AS id, r.name, coalesce(z.name, '') AS zone, coalesce(c.name, '') AS center FROM app.voter_snapshot_rows r LEFT JOIN app.zones z ON z.org_id = r.org_id AND z.id = r.zone_id LEFT JOIN app.centers c ON c.org_id = r.org_id AND c.id = r.center_id
      WHERE r.year = $1 AND r.version = $2 ORDER BY z.sort NULLS LAST, c.name, r.name`, [year, version])) as { id: string; name: string; zone: string; center: string }[];
    await audit(ctx, 'elections', 'Voter list viewed', `${year} v${version}${ctx.req.query.get('format') === 'csv' ? ' (download)' : ''}`, String(year));
    if (ctx.req.query.get('format') === 'csv') {
      const cell = (v: string) => { let s = v; if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = [`# Voter list ${year} version ${version} · ${snap.voters} voters · SHA-256 ${snap.fingerprint}`, 'Member ID,Name,Zone,Masjid', ...list.map((r) => [r.id, r.name, r.zone, r.center].map(cell).join(','))].join('\r\n');
      return { status: 200, body: csv, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="voters-${year}-v${version}.csv"` } };
    }
    return { status: 200, body: { year, version, fingerprint: snap.fingerprint, voters: list } };
  }),

  /* ---------------- elections ---------------- */
  route('POST', /^\/admin\/elections$/, async (ctx) => {
    needEC(ctx);
    const year = Number(body(ctx).year); if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new HttpError(400, 'Which year?');
    const doc = await electionsDoc(ctx); if (doc.elections.some((x) => x.year === year)) throw new HttpError(409, `There is already an election for ${year}.`);
    const mp = OrgStructureSchema.safeParse(await document(ctx.db, ctx.orgId, 'org-structure')); const map = mp.success ? mp.data : mockOrgStructure;
    const ms = await membership(ctx); const voters = (await members(ctx)).filter((m) => eligibleIn(m, year, ms));
    const byCenter: Record<string, Record<string, number>> = {}; for (const m of voters) { byCenter[m.center] ??= {}; byCenter[m.center][m.zip] = (byCenter[m.center][m.zip] ?? 0) + 1; }
    const off = await officials(ctx);
    const e: E.Election = { year, electionDay: O.electionDay(year), status: 'planning', rules: doc.rules, seats: E.seatsOnBallot(year, { zones: map.zones.map((z) => ({ id: z.id, name: z.name, active: z.active ?? true })), centers: map.centers.map((c) => ({ name: c.name, zone: c.zone, active: c.active ?? true })) }, byCenter),
      nominations: [], results: [], voters: { frozenOn: '', count: 0 }, certification: { by: '', on: '', note: '' }, swornInOn: '' };
    void off;
    e.seats = e.seats.filter((x) => x.places >= 1);   // Area Representative seats with no voters yet (a year far ahead) are not on the ballot
    const saved = await saveElection(ctx, doc, e, `Election ${year} planned`);
    await audit(ctx, 'elections', 'Election planned', `${year}: ${saved.seats.length} seats`, String(year));
    return { status: 201, body: { election: view(saved, todayCT()) } };
  }),
  route('GET', new RegExp(`^/admin/elections/${YEAR}$`), async (ctx, mm) => {
    if (!has(ctx, 'voters.freeze') && !has(ctx, 'officials.manage')) need(ctx, 'reports.view');
    const { e } = await electionOf(ctx, Number(mm[1])); return { status: 200, body: { election: view(e, todayCT()) } };
  }),
  route('POST', new RegExp(`^/admin/elections/${YEAR}/nominations$`), async (ctx, mm) => {
    needEC(ctx); const year = Number(mm[1]); const { doc, e } = await electionOf(ctx, year);
    if (!['planning', 'nominations'].includes(e.status)) throw new HttpError(409, 'Nominations are closed for this election.');
    const P = z.object({ seatKey: z.string(), memberId: z.string().trim().toUpperCase().default(''), name: z.string().trim().max(80).default(''), nominatedBy: z.string().trim().max(80).default(''), secondedBy: z.string().trim().max(80).default(''), note: z.string().max(300).default('') });
    const p = P.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the nomination.', issues(p.error)); const b = p.data;
    const m = b.memberId ? (await members(ctx, 'WHERE m.id = $1', [b.memberId]))[0] : undefined;
    const n: E.Nomination = { id: await nominationId(ctx, e), seatKey: b.seatKey, memberId: m?.id ?? '', name: m ? `${m.first} ${m.last}` : b.name, nominatedBy: b.nominatedBy, secondedBy: b.secondedBy, on: todayCT(), status: 'nominated', note: b.note };
    const nv = E.NominationSchema.safeParse(n); if (!nv.success) throw new HttpError(422, nv.error.issues[0].message, issues(nv.error));
    const found = n.memberId ? await factsFor(ctx, n.memberId, year) : null;
    const problems = E.nominationIssues(n, e, found);
    if (problems.includes('This seat is not on the ballot.')) throw new HttpError(422, 'This seat is not on the ballot.');
    const saved = await saveElection(ctx, doc, { ...e, nominations: [...e.nominations, n] }, `Nomination ${n.id}`);
    await audit(ctx, 'elections', 'Nomination received', `${n.name} for ${n.seatKey}${problems.length ? ` (${problems.length} issues)` : ''}`, n.id);
    return { status: 201, body: { nomination: n, issues: problems, election: { status: saved.status } } };
  }),
  route('POST', new RegExp(`^/admin/elections/${YEAR}/nominations/([a-z0-9-]{2,60})$`), async (ctx, mm) => {
    needEC(ctx); const year = Number(mm[1]); const { doc, e } = await electionOf(ctx, year);
    const cur = e.nominations.find((x) => x.id === mm[2]); if (!cur) throw new HttpError(404, 'No such nomination.');
    const b = body(ctx); const status = String(b.status ?? '') as E.Nomination['status']; const note = String(b.note ?? '').trim().slice(0, 300);
    if (!(status in E.NOMINATION_STATUS)) throw new HttpError(400, `Status: ${Object.keys(E.NOMINATION_STATUS).join(', ')}.`);
    if (['voting', 'counting', 'certified', 'closed'].includes(e.status) && status === 'accepted') throw new HttpError(409, 'The ballot is set – no new candidates.');
    const n = { ...cur, status, note: note || cur.note, secondedBy: typeof b.secondedBy === 'string' ? b.secondedBy.trim().slice(0, 80) : cur.secondedBy };
    if (status === 'accepted') {
      const problems = E.nominationIssues(n, e, n.memberId ? await factsFor(ctx, n.memberId, year) : null);
      if (problems.length) throw new HttpError(409, problems[0], problems);
      if (e.rules.seconderRequired && !n.secondedBy) throw new HttpError(409, 'A seconder is required before a nomination is accepted.');
    }
    if ((status === 'ineligible' || status === 'declined') && note.length < 3) throw new HttpError(400, 'Give the reason (the candidate is told).');
    await saveElection(ctx, doc, { ...e, nominations: e.nominations.map((x) => (x.id === n.id ? n : x)) }, `Nomination ${n.id}: ${status}`);
    await audit(ctx, 'elections', `Nomination ${status}`, `${n.name} – ${n.seatKey}${note ? `: ${note}` : ''}`, n.id);
    return { status: 200, body: { nomination: n } };
  }),
  route('POST', new RegExp(`^/admin/elections/${YEAR}/status$`), async (ctx, mm) => {
    needEC(ctx); const year = Number(mm[1]); const { doc, e } = await electionOf(ctx, year); const today = todayCT();
    const to = String(body(ctx).to ?? '') as E.Election['status']; const at = ORDER.indexOf(e.status), want = ORDER.indexOf(to);
    if (want < 0) throw new HttpError(400, `Status: ${ORDER.join(', ')}.`);
    if (want !== at + 1) throw new HttpError(409, `From ${E.ELECTION_STATUS[e.status]} the next step is ${E.ELECTION_STATUS[ORDER[at + 1]] ?? 'none'}.`);
    if (to === 'closed') throw new HttpError(409, 'Swear the winners in – that closes the election.');
    if (to === 'ballot' && today <= E.nominationWindow(e).close && !body(ctx).early) throw new HttpError(409, `Nominations run until ${E.fmt(E.nominationWindow(e).close)}.`);
    if (to === 'ballot' && e.nominations.some((n) => n.status === 'nominated')) throw new HttpError(409, `${e.nominations.filter((n) => n.status === 'nominated').length} nominations are not decided yet.`);
    if (to === 'voting' && !e.voters.frozenOn) throw new HttpError(409, 'Freeze the voter list first.');
    let next: E.Election = { ...e, status: to };
    if (to === 'certified') {
      const open = E.ballot(e).filter((s) => !s.empty && !e.results.find((r) => r.seatKey === s.seat.key)?.winners.length);
      if (open.length) throw new HttpError(409, `${open.length} seats are not decided: ${open.slice(0, 3).map((s) => s.seat.label).join(', ')}.`);
      next = { ...next, certification: { by: `${e.rules.certifiedBy} – ${ctx.me!.name}`, on: today, note: String(body(ctx).note ?? '').slice(0, 300) } };
    }
    const saved = await saveElection(ctx, doc, next, `Election ${year}: ${E.ELECTION_STATUS[to]}`);
    await audit(ctx, 'elections', `Election ${E.ELECTION_STATUS[to]}`, String(year), String(year));
    return { status: 200, body: { election: view(saved, today) } };
  }),
  route('POST', new RegExp(`^/admin/elections/${YEAR}/results$`), async (ctx, mm) => {
    needEC(ctx); const year = Number(mm[1]); const { doc, e } = await electionOf(ctx, year);
    if (!['voting', 'counting'].includes(e.status)) throw new HttpError(409, 'Counts are entered after voting starts.');
    const p = E.ResultSchema.safeParse(body(ctx)); if (!p.success) throw new HttpError(400, 'Check the count.', issues(p.error)); const r = { ...p.data, winners: [] };
    const seat = E.ballot(e).find((s) => s.seat.key === r.seatKey); if (!seat) throw new HttpError(404, 'Not a seat on the ballot.');
    if (r.counts.some((c) => !seat.candidates.some((n) => n.id === c.nominationId))) throw new HttpError(422, 'A count for someone who is not a candidate for this seat.');
    if (e.results.find((x) => x.seatKey === r.seatKey)?.winners.length) throw new HttpError(409, 'This seat’s count was accepted – it does not change.');
    const next = { ...e, status: 'counting' as const, results: [...e.results.filter((x) => x.seatKey !== r.seatKey), r] };
    const saved = await saveElection(ctx, doc, next, `Count for ${r.seatKey}`);
    await audit(ctx, 'elections', 'Count entered', `${r.seatKey}: ${r.ballotsCast} ballots`, String(year));
    return { status: 200, body: { tally: E.tally(saved, r.seatKey) } };
  }),
  route('POST', new RegExp(`^/admin/elections/${YEAR}/results/([^/]+)/accept$`), async (ctx, mm) => {
    needEC(ctx); const year = Number(mm[1]); const key = decodeURIComponent(mm[2]); const { doc, e } = await electionOf(ctx, year);
    const t = E.tally(e, key); const r = e.results.find((x) => x.seatKey === key); if (!t || !r) throw new HttpError(404, 'Enter the count first.');
    if (r.winners.length) throw new HttpError(409, 'Already accepted.');
    let winners = E.impliedWinners(t);
    if (t.tie) {
      const given = Array.isArray(body(ctx).winners) ? (body(ctx).winners as string[]) : [];
      if (!given.length) throw new HttpError(409, `Tie – ${e.rules.tieBreak === 'runoff' ? 'hold a run-off and enter its count' : e.rules.tieBreak === 'drawing' ? 'draw lots and give the winner' : 'the Commission names the winner'}.`);
      const top = t.rows.filter((x) => x.votes >= t.rows[t.seat.places - 1].votes).map((x) => x.nomination.id);
      if (given.length !== t.seat.places || given.some((g) => !top.includes(g))) throw new HttpError(422, 'Winners must be among the tied candidates, one per place.');
      winners = given;
    }
    if (!winners.length) throw new HttpError(409, 'No votes counted for this seat.');
    const saved = await saveElection(ctx, doc, { ...e, results: e.results.map((x) => (x.seatKey === key ? { ...x, winners } : x)) }, `Count accepted for ${key}`);
    await audit(ctx, 'elections', 'Count accepted', `${key}: ${winners.map((w) => e.nominations.find((n) => n.id === w)?.name).join(', ')}`, String(year));
    return { status: 200, body: { tally: E.tally(saved, key) } };
  }),
  route('POST', new RegExp(`^/admin/elections/${YEAR}/swear-in$`), async (ctx, mm) => {
    need(ctx, 'officials.manage'); const year = Number(mm[1]); const { doc, e } = await electionOf(ctx, year);
    if (e.status !== 'certified') throw new HttpError(409, 'Certify the results first.');
    const off = await officials(ctx); const incoming = E.holdersFromResults(e, off.eidDates);
    const same = (a: O.Holder, b: O.Holder) => a.kind === b.kind && a.office === b.office && a.zone === b.zone && a.center === b.center && a.atLarge === b.atLarge && a.zips.join() === b.zips.join();
    const today = todayCT(); const history = [...off.history]; let holders = [...off.holders]; const added = new Set<string>();
    for (const h of incoming) {
      const before = holders.filter((x) => same(x, h) && x.status !== 'ended' && !added.has(x.id));   // never the winner sworn in a line above (seats with several places)
      for (const p of before.filter((x) => x.status === 'serving' && x.name)) history.push({ id: `${p.id}-${year}`.slice(0, 60), year: p.termStart ? Number(p.termStart.slice(0, 4)) - 1 : year - 2, kind: p.kind, office: p.office, zone: p.zone, center: p.center, zips: p.zips, atLarge: p.atLarge, title: O.seatLabel(p), name: p.name, memberId: p.memberId, how: p.how, termStart: p.termStart, termEnd: p.termEnd || h.termStart, endReason: 'completed', notes: `Followed by ${h.name} (elected ${year}).`, source: 'archived', showOnWebsite: p.showOnWebsite });
      // seats with several places (Area Representatives): the incoming list replaces them all
      holders = [...holders.filter((x) => !before.includes(x)), { ...h, boardTerms: O.boardTermsServed(history, { memberId: h.memberId, name: h.name }, year) }]; added.add(h.id);
    }
    const nextOff = O.OfficialsSchema.safeParse({ ...off, holders, history });
    if (!nextOff.success) throw new HttpError(409, nextOff.error.issues[0].message, issues(nextOff.error));
    await saveDocument(ctx.db, ctx.orgId, 'officials', nextOff.data, ctx.me!.name, `Sworn in: election ${year}`);
    await saveElection(ctx, doc, { ...e, status: 'closed', swornInOn: today }, `Election ${year}: sworn in`);
    await audit(ctx, 'elections', 'Sworn in', `${year}: ${incoming.length} officials`, String(year));
    return { status: 200, body: { swornIn: incoming.map((h) => ({ name: h.name, seat: O.seatLabel(h), termStart: h.termStart, termEnd: h.termEnd })) } };
  }),

  /* ---------------- website and portal ---------------- */
  route('GET', new RegExp(`^/public/elections/${YEAR}$`), async (ctx, mm) => {
    const { e } = await electionOf(ctx, Number(mm[1])); const done = ['certified', 'closed'].includes(e.status);
    return { status: 200, body: { year: e.year, electionDay: e.electionDay, status: E.ELECTION_STATUS[e.status], window: E.nominationWindow(e), method: e.rules.method,
      seats: E.ballot(e).filter((s) => !s.empty || e.status === 'nominations').map((s) => ({ key: s.seat.key, label: s.seat.label, places: s.seat.places, candidates: ['planning', 'nominations'].includes(e.status) ? [] : s.candidates.map((c) => c.name), uncontested: s.uncontested })),
      results: done ? e.seats.filter((s) => !s.removed).map((s) => { const t = E.tally(e, s.key)!; return { label: s.label, ballotsCast: t.ballotsCast, rows: t.rows.map((r) => ({ name: r.nomination.name, votes: r.votes, winner: r.winner })) }; }).filter((x) => x.rows.length) : null,
      certified: done ? e.certification : null } };
  }),
  route('GET', new RegExp(`^/member/elections/${YEAR}$`), async (ctx, mm) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const year = Number(mm[1]); const { e } = await electionOf(ctx, year);
    const m = (await members(ctx, 'WHERE m.id = $1', [ctx.memberId]))[0]; const snap = await latestSnapshot(ctx, year);
    const onList = snap ? !!(await one(ctx.db, API(ctx), 'SELECT 1 AS x FROM app.voter_snapshot_rows WHERE year = $1 AND version = $2 AND member_id = $3', [year, snap.version, m.id])) : null;
    const ms = await membership(ctx);
    const mine = E.ballot(e).filter((s) => s.seat.voters === 'all' || (s.seat.voters === 'zone' && s.seat.zone === m.zone) || (s.seat.voters === 'center' && s.seat.center === m.center) || (s.seat.voters === 'zips' && s.seat.center === m.center && (s.seat.zips.includes(m.zip) || !!s.seat.atLarge)));
    return { status: 200, body: { year, electionDay: e.electionDay, status: E.ELECTION_STATUS[e.status], onVoterList: onList, eligibleNow: eligibleIn(m, year, ms), nominationsOpen: e.status === 'nominations' && E.nominationsOpen(e, todayCT()),
      mySeats: mine.map((s) => ({ key: s.seat.key, label: s.seat.label, candidates: ['planning', 'nominations'].includes(e.status) ? [] : s.candidates.map((c) => c.name) })),
      myNominations: e.nominations.filter((n) => n.memberId === m.id).map((n) => ({ seat: e.seats.find((s) => s.key === n.seatKey)?.label, status: E.NOMINATION_STATUS[n.status], note: n.status === 'ineligible' || n.status === 'declined' ? n.note : '' })) } };
  }),
  route('POST', new RegExp(`^/member/elections/${YEAR}/nominations$`), async (ctx, mm) => {
    if (!ctx.memberId) throw new HttpError(401, 'Sign in as a member.');
    const year = Number(mm[1]); const { doc, e } = await electionOf(ctx, year);
    if (e.status !== 'nominations' || !E.nominationsOpen(e, todayCT())) throw new HttpError(409, 'Nominations are not open.');
    const b = body(ctx); const me = (await members(ctx, 'WHERE m.id = $1', [ctx.memberId]))[0];
    const nomineeId = String(b.nomineeId ?? me.id).trim().toUpperCase();
    if (nomineeId === me.id && !e.rules.selfNominationAllowed) throw new HttpError(409, 'Self-nomination is not allowed in this election.');
    const nominee = (await members(ctx, 'WHERE m.id = $1', [nomineeId]))[0]; if (!nominee) throw new HttpError(422, `No member ${nomineeId}.`);
    const myFacts = await factsFor(ctx, me.id, year); if (!myFacts?.eligibleVoter) throw new HttpError(403, 'Only eligible voting members may nominate.');
    const n: E.Nomination = { id: await nominationId(ctx, e), seatKey: String(b.seatKey ?? ''), memberId: nominee.id, name: `${nominee.first} ${nominee.last}`,
      nominatedBy: `${me.first} ${me.last} (${me.id})`, secondedBy: String(b.secondedBy ?? '').trim().slice(0, 80), on: todayCT(), status: 'nominated', note: 'Sent from the member portal.' };
    const problems = E.nominationIssues(n, e, await factsFor(ctx, nominee.id, year));
    if (problems.length) throw new HttpError(422, problems[0], problems);
    await saveElection(ctx, doc, { ...e, nominations: [...e.nominations, n] }, `Nomination ${n.id} from the portal`);
    await audit(ctx, 'elections', 'Nomination from a member', `${n.name} for ${n.seatKey} by ${me.id}`, n.id);
    return { status: 201, body: { id: n.id, status: E.NOMINATION_STATUS.nominated, seat: e.seats.find((s) => s.key === n.seatKey)?.label } };
  }),
];
