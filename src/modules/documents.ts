/**
 * The admin's documents (C3) – the same rules the demo admin's store route applies, now on the server:
 *   GET    /admin/documents/:key            published document, or this organization's starter content (never ISGH's for
 *                                           another organization); ?versions=1 adds the history. Any signed-in admin may
 *                                           read; integrations need their own permission. ?versions=full adds each version's content.
 *   PUT    /admin/documents/:key {data, baseVersion?, note?}   publish: schema, permission, 409 when someone published
 *                                           after you opened it, readable theme colors, four eyes for provider / key
 *                                           changes, masjid leaders change only their own masjid's working body, and an
 *                                           election's recorded facts change only through the election steps (electionGuard)
 *   DELETE /admin/documents/:key            back to the starter content, published as a new version (history kept)
 */
import { OrgStructureSchema, mockOrgStructure } from '@/lib/community/org-structure';
import { one, rows } from '../db/sql.js';
import { HttpError, audit, document, need, route, todayCT, type Ctx, type Route } from '../http/core.js';
import { REGISTRY, isDocKey, permissionToPublish, type DocKey } from '../registry.js';
import { project } from './projections.js';
import { starterFor } from '../platform/starter.js';
import { AccessSchema, can, teamChangeProblem, type AccessDoc, pagesChangeProblem } from '@/lib/community/access';
import { IntegrationsSchema, fourEyes } from '@/lib/integrations/integrations';
import { checkContrast, type ThemesFile } from '@/lib/theme/theme-css';
import { ElectionsSchema, type ElectionsDoc } from '@/lib/community/elections';

/** What the election service records (voter list, statuses, nominations, counts, certification, swearing-in) cannot be
 *  changed by publishing the document – only by the steps in /admin/voters and /admin/elections, which check the facts. */
export function electionGuard(before: ElectionsDoc, after: ElectionsDoc): string | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const b of before.elections) {
    const a = after.elections.find((x) => x.year === b.year);
    if (!a) { if (b.status !== 'planning' || b.nominations.length || b.voters.frozenOn) return `The ${b.year} election has started – it cannot be deleted.`; continue; }
    const what = !same(a.status, b.status) ? 'its status' : !same(a.voters, b.voters) ? 'the voter list' : !same(a.nominations, b.nominations) ? 'the nominations'
      : !same(a.results, b.results) ? 'the counts' : !same(a.certification, b.certification) ? 'the certification' : !same(a.swornInOn, b.swornInOn) ? 'the swearing-in' : '';
    if (what) return `${b.year} election: ${what} is recorded through the election desk's steps, not by publishing.`;
  }
  for (const a of after.elections) if (!before.elections.some((x) => x.year === a.year) && (a.status !== 'planning' || a.nominations.length || a.voters.frozenOn || a.results.length)) return `A new election starts in planning.`;
  return null;
}

const API = (ctx: Ctx) => ({ org: ctx.orgId, role: 'app_api' as const });
type DocRow = { data: unknown; version: number; published_at: string; published_by: string; note: string };
const keyOf = (k: string): DocKey => { if (!isDocKey(k)) throw new HttpError(404, `Unknown document “${k}”.`); return k; };
const signedIn = (ctx: Ctx) => {
  if (ctx.needsTwoStep) throw new HttpError(401, 'Finish the second sign-in step first.', undefined, 'two-step');
  if (!ctx.me) throw new HttpError(401, 'Sign in first.', undefined, 'sign-in');
};
const issuesOf = (e: { issues: { path: (string | number)[]; message: string }[] }) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/** Who may publish this key: its permission – or, for the admin list, team.manage limited by teamChangeProblem. */
function mayPublish(ctx: Ctx, key: DocKey) {
  if (key === 'pages' && ctx.me && !can(ctx.access, ctx.me, 'content.publish', todayCT()) && can(ctx.access, ctx.me, 'center.content', todayCT())) return; // masjid editors: the change itself is checked below
  if (key === 'admin-access' && ctx.me && !can(ctx.access, ctx.me, 'admins.manage', todayCT()) && can(ctx.access, ctx.me, 'team.manage', todayCT())) return;
  need(ctx, permissionToPublish(key));
}

export const DOCUMENT_ROUTES: Route[] = [
  route('GET', /^\/admin\/documents\/([a-z0-9-]+)$/, async (ctx, mm) => {
    const key = keyOf(mm[1]); signedIn(ctx);
    if (key === 'integrations') need(ctx, permissionToPublish(key));
    const r = await one<DocRow>(ctx.db, API(ctx), 'SELECT data, version, published_at::text, published_by, note FROM app.documents WHERE key = $1', [key]);
    const vq = ctx.req.query.get('versions');   // 1 = the list · full = with each version's content ("load into draft")
    const versions = vq ? await rows(ctx.db, API(ctx), `SELECT version, published_at::text AS "publishedAt", published_by AS by, note${vq === 'full' ? ', data' : ''} FROM app.document_versions WHERE key = $1 ORDER BY version DESC LIMIT 20`, [key]) : undefined;
    if (r) return { status: 200, body: { key, source: 'published', data: r.data, version: r.version, publishedAt: r.published_at, by: r.published_by, note: r.note, versions } };
    return { status: 200, body: { key, source: 'default', data: await document(ctx.db, ctx.orgId, key), version: 0, publishedAt: null, by: null, versions: versions ?? [] } };
  }),

  route('PUT', /^\/admin\/documents\/([a-z0-9-]+)$/, async (ctx, mm) => {
    const key = keyOf(mm[1]); signedIn(ctx); mayPublish(ctx, key);
    const body = (ctx.req.body ?? {}) as { data?: unknown; note?: string; baseVersion?: number };
    const parsed = REGISTRY[key].schema.safeParse(body.data);
    if (!parsed.success) throw new HttpError(400, 'Some fields are not valid.', issuesOf(parsed.error));
    const cur = await one<{ version: number }>(ctx.db, API(ctx), 'SELECT version FROM app.documents WHERE key = $1', [key]);
    if (typeof body.baseVersion === 'number' && body.baseVersion !== (cur?.version ?? 0)) throw new HttpError(409, `Someone published a newer version (v${cur?.version ?? 0}) after you opened this page.`);
    const today = todayCT();
    if (key === 'themes') { const p = checkContrast(parsed.data as ThemesFile); if (p.length) throw new HttpError(400, 'Some colors are too hard to read.', p.map((m) => ({ path: 'themes', message: m }))); }
    if (key === 'integrations') {
      const before = IntegrationsSchema.safeParse(await document(ctx.db, ctx.orgId, 'integrations'));
      const approvers = ctx.access.admins.filter((a) => a.id !== ctx.me!.id && can(ctx.access, a, 'integrations.manage', today)).map((a) => a.id);
      const fe = before.success ? fourEyes(before.data, parsed.data as never, ctx.me!.id, approvers) : null;
      if (fe) throw new HttpError(409, fe);
    }
    if (key === 'pages' && !can(ctx.access, ctx.me, 'content.publish', today)) {
      // O1.5 – a masjid editor may only change pages of their own masajid and may not publish them
      const before = await document(ctx.db, ctx.orgId, 'pages') as Record<string, { slug: string; status: string; scope: { kind: 'org' } | { kind: 'masjid'; center: string } }>;
      const mp = OrgStructureSchema.safeParse(await document(ctx.db, ctx.orgId, 'org-structure')); const map = mp.success ? mp.data : mockOrgStructure;
      const problem = pagesChangeProblem(before ?? {}, parsed.data as typeof before, ctx.me!, ctx.access, (id) => map.centers.find((c) => c.id === id)?.name ?? '', (name) => map.centers.find((c) => c.name === name)?.zone ?? '');
      if (problem) throw new HttpError(403, problem);
    }
    if (key === 'admin-access' && !can(ctx.access, ctx.me, 'admins.manage', today)) {
      const tp = teamChangeProblem(ctx.access, AccessSchema.parse(parsed.data) as AccessDoc, ctx.me!, today);
      if (tp) throw new HttpError(403, tp);
    }
    if (key === 'elections') { const b = ElectionsSchema.safeParse(await document(ctx.db, ctx.orgId, 'elections')); const g = b.success ? electionGuard(b.data, parsed.data as ElectionsDoc) : null; if (g) throw new HttpError(409, g); }
    if (key === 'admin-access' && !(parsed.data as AccessDoc).admins.some((a) => a.roleId === 'owner' && a.status === 'active')) throw new HttpError(400, 'Keep at least one active owner.');
    const r = await one<{ version: number; published_at: string }>(ctx.db, API(ctx), `INSERT INTO app.documents (org_id, key, data, published_by, note) VALUES ($1, $2, $3::jsonb, $4, $5)
      ON CONFLICT (org_id, key) DO UPDATE SET data = EXCLUDED.data, version = app.documents.version + 1, published_at = now(), published_by = EXCLUDED.published_by, note = EXCLUDED.note RETURNING version, published_at::text`, [ctx.orgId, key, parsed.data, ctx.me!.name, String(body.note ?? '').slice(0, 200)]);
    await project(ctx.db, ctx.orgId, key, parsed.data);   // the tables behind the document follow the publish
    await audit(ctx, 'content', 'Published', `${REGISTRY[key].label} v${r!.version}${body.note ? ` – ${body.note}` : ''}`, key);
    return { status: 200, body: { ok: true, key, version: r!.version, publishedAt: r!.published_at } };
  }),

  route('DELETE', /^\/admin\/documents\/([a-z0-9-]+)$/, async (ctx, mm) => {
    const key = keyOf(mm[1]); signedIn(ctx);
    if (key === 'admin-access') throw new HttpError(409, 'The admin list cannot be reset – change it instead.');
    need(ctx, permissionToPublish(key));
    // published again as a new version (the history stays, so the earlier version can be restored)
    const data = await starterFor(ctx.db, ctx.orgId, key);
    const r = await one<{ version: number }>(ctx.db, API(ctx), `UPDATE app.documents SET data = $2::jsonb, version = version + 1, published_at = now(), published_by = $3, note = 'Back to the starter content' WHERE key = $1 RETURNING version`, [key, data, ctx.me!.name]);
    if (r) { await project(ctx.db, ctx.orgId, key, data); await audit(ctx, 'content', 'Reset to the starter content', `${REGISTRY[key].label} v${r.version}`, key); }
    return { status: 200, body: { ok: true, version: r?.version ?? 0 } };
  }),
];
