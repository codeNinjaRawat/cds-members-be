/**
 * Documents → tables. The admin edits documents (one JSON per organization); the database keeps tables so every rule can
 * be enforced and joined in SQL. On every publish (and at seed) the API copies the document into its tables:
 *   org-structure        → app.zones, app.zone_zips, app.centers, app.center_zips, app.center_jumuah; members re-placed by ZIP
 *   membership-settings  → app.membership_plans
 *   admin-access         → app.admin_roles, app.admins, app.admin_assignments
 *   donation-settings    → app.funds
 *   fundraising          → app.campaigns, app.campaign_pages (gifts are app.donations with a campaign)
 *   officials            → app.official_terms (serving holders and the history)
 *   groups               → app.groups, app.group_members (manual members; automatic ones by the comms job)
 *   events               → app.events, app.event_ticket_types (registrations stay rows; see modules/events.ts)
 * Rows that leave a document are switched off (zones, masjids, plans, funds) rather than deleted, so history keeps its links.
 * Each projection is one transaction (one db.run).
 */
import type { Db, Statement } from '../db/sql.js';

const as = (orgId: string) => ({ org: orgId, role: 'app_api' as const });

export function orgStructureSql(orgId: string, doc: unknown): Statement[] {
  const d = JSON.stringify(doc);
  return [
    { sql: `INSERT INTO app.zones (org_id, code, name, areas, director_name, director_email, term_ends_on, active, sort)
      SELECT $1::uuid, z->>'id', z->>'name', coalesce(z->>'areas', ''), coalesce(z->'director'->>'name', ''), coalesce(z->'director'->>'email', ''), NULLIF(z->>'termEnds', '')::date, coalesce((z->>'active')::boolean, true), ord
      FROM jsonb_array_elements($2::jsonb->'zones') WITH ORDINALITY AS t(z, ord)
      ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name, areas = EXCLUDED.areas, director_name = EXCLUDED.director_name, director_email = EXCLUDED.director_email, term_ends_on = EXCLUDED.term_ends_on, active = EXCLUDED.active, sort = EXCLUDED.sort`, params: [orgId, d] },
    { sql: `UPDATE app.zones SET active = false WHERE org_id = $1::uuid AND code NOT IN (SELECT z->>'id' FROM jsonb_array_elements($2::jsonb->'zones') z)`, params: [orgId, d] },
    { sql: `DELETE FROM app.zone_zips WHERE org_id = $1::uuid`, params: [orgId] },
    { sql: `INSERT INTO app.zone_zips (org_id, zone_id, zip)
      SELECT $1::uuid, zo.id, z5 FROM jsonb_array_elements($2::jsonb->'zones') z CROSS JOIN LATERAL jsonb_array_elements_text(z->'zips') z5
      JOIN app.zones zo ON zo.org_id = $1::uuid AND zo.code = z->>'id' ON CONFLICT DO NOTHING`, params: [orgId, d] },
    // masjids: names must stay unique, so a renamed pair cannot collide halfway – park the old names first
    { sql: `UPDATE app.centers SET name = name || ' ~' || left(id::text, 8) WHERE org_id = $1::uuid AND code IN (SELECT c->>'id' FROM jsonb_array_elements($2::jsonb->'centers') c WHERE c->>'name' IS DISTINCT FROM (SELECT name FROM app.centers x WHERE x.org_id = $1::uuid AND x.code = c->>'id'))`, params: [orgId, d] },
    { sql: `INSERT INTO app.centers (org_id, code, zone_id, name, aka, street, city, zip, phone, website, services, active, sort, name_status)
      SELECT $1::uuid, c->>'id', zo.id, c->>'name', coalesce(c->>'aka', ''), coalesce(c->'address'->>'street', ''), coalesce(c->'address'->>'city', ''), coalesce(c->'address'->>'zip', ''),
             coalesce(c->>'phone', ''), coalesce(c->>'website', ''), coalesce(ARRAY(SELECT jsonb_array_elements_text(c->'services')), '{}'), coalesce((c->>'active')::boolean, true), ord,
             CASE WHEN c->>'aka' = 'name to confirm' THEN 'to-confirm' ELSE 'confirmed' END
      FROM jsonb_array_elements($2::jsonb->'centers') WITH ORDINALITY AS t(c, ord) JOIN app.zones zo ON zo.org_id = $1::uuid AND zo.code = c->>'zone'
      ON CONFLICT (org_id, code) DO UPDATE SET zone_id = EXCLUDED.zone_id, name = EXCLUDED.name, aka = EXCLUDED.aka, street = EXCLUDED.street, city = EXCLUDED.city, zip = EXCLUDED.zip, phone = EXCLUDED.phone,
        website = EXCLUDED.website, services = EXCLUDED.services, active = EXCLUDED.active, sort = EXCLUDED.sort, name_status = EXCLUDED.name_status`, params: [orgId, d] },
    { sql: `UPDATE app.centers SET active = false WHERE org_id = $1::uuid AND code NOT IN (SELECT c->>'id' FROM jsonb_array_elements($2::jsonb->'centers') c)`, params: [orgId, d] },
    { sql: `INSERT INTO app.center_zips (org_id, zip, center_id)
      SELECT $1::uuid, z5, ce.id FROM jsonb_array_elements($2::jsonb->'centers') c CROSS JOIN LATERAL jsonb_array_elements_text(c->'zips') z5
      JOIN app.centers ce ON ce.org_id = $1::uuid AND ce.code = c->>'id'
      WHERE coalesce((c->>'active')::boolean, true) AND EXISTS (SELECT 1 FROM app.zone_zips zz WHERE zz.org_id = $1::uuid AND zz.zip = z5 AND zz.zone_id = ce.zone_id) ON CONFLICT DO NOTHING`, params: [orgId, d] },
    { sql: `DELETE FROM app.center_jumuah WHERE org_id = $1::uuid`, params: [orgId] },
    { sql: `INSERT INTO app.center_jumuah (org_id, center_id, slot, khutbah_at, label)
      SELECT $1::uuid, ce.id, j.ord, (j.v->>'khutbah')::time, coalesce(j.v->>'label', '') FROM jsonb_array_elements($2::jsonb->'centers') c
      CROSS JOIN LATERAL jsonb_array_elements(c->'jumuah') WITH ORDINALITY AS j(v, ord) JOIN app.centers ce ON ce.org_id = $1::uuid AND ce.code = c->>'id' WHERE j.ord <= 4`, params: [orgId, d] },
    // everybody not placed by hand follows the (new) map
    { sql: `UPDATE app.members SET center_id = NULL WHERE org_id = $1::uuid AND center_override IS NULL`, params: [orgId] },
  ];
}

export function plansSql(orgId: string, doc: unknown): Statement[] {
  const d = JSON.stringify(doc);
  return [
    { sql: `INSERT INTO app.membership_plans (org_id, id, name, category, term, years, price_cents, household_size, voting_eligible, requires_approval, visible, sort, archived)
      SELECT $1::uuid, p->>'id', p->>'name', coalesce(p->>'category', ''),
             CASE p->>'term' WHEN 'lifetime' THEN 'lifetime' WHEN 'recurring' THEN 'monthly' ELSE 'year' END, 1, (p->>'priceCents')::int,
             coalesce((p->'bundle'->>'maxMembers')::int, CASE WHEN p->>'category' = 'household' THEN 2 ELSE 1 END),
             coalesce((p->>'votingEligible')::boolean, true), coalesce((p->>'requiresApproval')::boolean, true), coalesce((p->>'visible')::boolean, true), ord, false
      FROM jsonb_array_elements($2::jsonb->'plans') WITH ORDINALITY AS t(p, ord)
      ON CONFLICT (org_id, id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, term = EXCLUDED.term, price_cents = EXCLUDED.price_cents, household_size = EXCLUDED.household_size,
        voting_eligible = EXCLUDED.voting_eligible, requires_approval = EXCLUDED.requires_approval, visible = EXCLUDED.visible, sort = EXCLUDED.sort, archived = false`, params: [orgId, d] },
    { sql: `UPDATE app.membership_plans SET archived = true WHERE org_id = $1::uuid AND id NOT IN (SELECT p->>'id' FROM jsonb_array_elements($2::jsonb->'plans') p)`, params: [orgId, d] },
  ];
}

export function accessSql(orgId: string, doc: unknown): Statement[] {
  const d = JSON.stringify(doc);
  return [
    { sql: `INSERT INTO app.admin_roles (org_id, id, name, description, permissions, area, zone_scoped, center_scoped, area_scoped, zakat_level, built_in)
      SELECT $1::uuid, r->>'id', r->>'name', coalesce(r->>'description', ''), ARRAY(SELECT jsonb_array_elements_text(r->'permissions')), coalesce(r->>'area', 'general'),
             coalesce((r->>'zoneScoped')::boolean, false), coalesce((r->>'centerScoped')::boolean, false), coalesce((r->>'areaScoped')::boolean, false), coalesce((r->>'zakatLevel')::int, 0), coalesce((r->>'builtIn')::boolean, false)
      FROM jsonb_array_elements($2::jsonb->'roles') r
      ON CONFLICT (org_id, id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, permissions = EXCLUDED.permissions, area = EXCLUDED.area, zone_scoped = EXCLUDED.zone_scoped,
        center_scoped = EXCLUDED.center_scoped, area_scoped = EXCLUDED.area_scoped, zakat_level = EXCLUDED.zakat_level, built_in = EXCLUDED.built_in`, params: [orgId, d] },
    { sql: `INSERT INTO app.admins (org_id, id, name, email, member_id, home_zip, status, two_step)
      SELECT $1::uuid, a->>'id', a->>'name', lower(a->>'email'), NULLIF(a->>'memberId', ''), coalesce(a->>'homeZip', ''), coalesce(a->>'status', 'invited'), coalesce((a->>'twoStep')::boolean, false)
      FROM jsonb_array_elements($2::jsonb->'admins') a
      ON CONFLICT (org_id, id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, member_id = EXCLUDED.member_id, home_zip = EXCLUDED.home_zip, status = EXCLUDED.status, two_step = EXCLUDED.two_step`, params: [orgId, d] },
    { sql: `DELETE FROM app.admins WHERE org_id = $1::uuid AND id NOT IN (SELECT a->>'id' FROM jsonb_array_elements($2::jsonb->'admins') a)`, params: [orgId, d] },
    { sql: `DELETE FROM app.admin_assignments WHERE org_id = $1::uuid`, params: [orgId] },
    { sql: `INSERT INTO app.admin_assignments (org_id, admin_id, role_id, is_main, zone_ids, center_ids, zips, expires_on, given_by, holder_id, reviewed_on)
      SELECT $1::uuid, a->>'id', x.v->>'roleId', x.main,
             ARRAY(SELECT zo.id FROM app.zones zo WHERE zo.org_id = $1::uuid AND zo.code IN (SELECT jsonb_array_elements_text(coalesce(x.v->'zones', '[]')))),
             ARRAY(SELECT ce.id FROM app.centers ce WHERE ce.org_id = $1::uuid AND ce.name IN (SELECT jsonb_array_elements_text(coalesce(x.v->'centers', '[]')))),
             ARRAY(SELECT jsonb_array_elements_text(coalesce(x.v->'zips', '[]'))), NULLIF(x.v->>'expiresOn', '')::date, coalesce(x.v->>'givenBy', ''), coalesce(x.v->>'holderId', ''), NULLIF(x.v->>'reviewedOn', '')::date
      FROM jsonb_array_elements($2::jsonb->'admins') a
      CROSS JOIN LATERAL (SELECT a AS v, true AS main UNION ALL SELECT m, false FROM jsonb_array_elements(coalesce(a->'more', '[]')) m) x
      WHERE EXISTS (SELECT 1 FROM app.admin_roles r WHERE r.org_id = $1::uuid AND r.id = x.v->>'roleId')`, params: [orgId, d] },
    { sql: `DELETE FROM app.admin_roles WHERE org_id = $1::uuid AND id NOT IN (SELECT r->>'id' FROM jsonb_array_elements($2::jsonb->'roles') r)`, params: [orgId, d] },
  ];
}

export function fundsSql(orgId: string, doc: unknown): Statement[] {
  const d = JSON.stringify(doc);
  return [
    { sql: `UPDATE app.funds SET active = false WHERE org_id = $1::uuid`, params: [orgId] },
    { sql: `INSERT INTO app.funds (org_id, id, name, kind, active)
      SELECT $1::uuid, f->>'id', f->>'name', CASE WHEN f->>'kind' IN ('general', 'zakat', 'sadaqah', 'building', 'restricted', 'dues') THEN f->>'kind' WHEN f->>'id' = 'zakat' THEN 'zakat' ELSE 'general' END, coalesce((f->>'active')::boolean, true)
      FROM jsonb_array_elements(coalesce($2::jsonb->'funds', '[]')) f
      ON CONFLICT (org_id, id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, active = EXCLUDED.active`, params: [orgId, d] },
  ];
}

/** events → app.events + app.event_ticket_types. Times are the organization's wall-clock; events gone from the document are archived. */
export function eventsSql(orgId: string, doc: unknown): Statement[] {
  const d = JSON.stringify(doc);
  return [
    { sql: `INSERT INTO app.events (org_id, id, title, summary, category, center_id, center_name, venue, address, starts_at, ends_at, capacity, audience, group_ids, registration, registration_closes_at, status, approval, promotion, waitlist, spec)
      SELECT $1::uuid, e->>'id', e->>'title', coalesce(e->>'summary', ''), coalesce(e->>'category', 'community'),
        (SELECT c.id FROM app.centers c WHERE c.org_id = $1::uuid AND c.name = e->'location'->>'center'), coalesce(e->'location'->>'center', ''),
        coalesce(e->'location'->>'name', ''), coalesce(e->'location'->>'address', ''),
        (e->>'start')::timestamp AT TIME ZONE app.org_tz(), (e->>'end')::timestamp AT TIME ZONE app.org_tz(),
        NULLIF((e->'registration'->>'capacity')::int, 0), CASE e->>'visibility' WHEN 'members' THEN 'members' WHEN 'groups' THEN 'group' ELSE 'public' END,
        ARRAY(SELECT jsonb_array_elements_text(coalesce(e->'groupIds', '[]'))),
        CASE WHEN NOT coalesce((e->'registration'->>'enabled')::boolean, true) THEN 'none' WHEN coalesce((e->'registration'->>'waitlist')::boolean, false) THEN 'waitlist' ELSE 'open' END,
        (NULLIF(e->'registration'->>'closes', ''))::timestamp AT TIME ZONE app.org_tz(),
        CASE WHEN e->>'status' = 'draft' AND e->'approval'->>'state' = 'pending' THEN 'pending-approval' ELSE coalesce(e->>'status', 'draft') END,
        coalesce(e->'approval', '{}'), coalesce(e->'promotion', '{}'), coalesce((e->'registration'->>'waitlist')::boolean, false), e
      FROM jsonb_array_elements($2::jsonb->'events') e
      ON CONFLICT (org_id, id) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, category = EXCLUDED.category, center_id = EXCLUDED.center_id, center_name = EXCLUDED.center_name,
        venue = EXCLUDED.venue, address = EXCLUDED.address, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, capacity = EXCLUDED.capacity, audience = EXCLUDED.audience, group_ids = EXCLUDED.group_ids,
        registration = EXCLUDED.registration, registration_closes_at = EXCLUDED.registration_closes_at, status = EXCLUDED.status, approval = EXCLUDED.approval, promotion = EXCLUDED.promotion, waitlist = EXCLUDED.waitlist, spec = EXCLUDED.spec`, params: [orgId, d] },
    { sql: `UPDATE app.events SET status = 'archived' WHERE org_id = $1::uuid AND status <> 'archived' AND id NOT IN (SELECT e->>'id' FROM jsonb_array_elements($2::jsonb->'events') e)`, params: [orgId, d] },
    { sql: `DELETE FROM app.event_ticket_types x WHERE x.org_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements($2::jsonb->'events') e CROSS JOIN LATERAL jsonb_array_elements(e->'registration'->'types') t WHERE e->>'id' = x.event_id AND t->>'id' = x.id)`, params: [orgId, d] },
    { sql: `INSERT INTO app.event_ticket_types (org_id, event_id, id, name, price_cents, guest_price_cents, members_only, limit_total, access_code, enabled, sort)
      SELECT $1::uuid, e->>'id', t->>'id', t->>'name', coalesce((t->>'priceCents')::int, 0), coalesce((t->>'guestPriceCents')::int, 0), coalesce(t->>'availability', '') IN ('members', 'plans'),
        NULLIF((t->>'limit')::int, 0), NULLIF(t->>'code', ''), coalesce((t->>'enabled')::boolean, true), ord
      FROM jsonb_array_elements($2::jsonb->'events') e CROSS JOIN LATERAL jsonb_array_elements(e->'registration'->'types') WITH ORDINALITY AS y(t, ord)
      ON CONFLICT (org_id, event_id, id) DO UPDATE SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents, guest_price_cents = EXCLUDED.guest_price_cents, members_only = EXCLUDED.members_only,
        limit_total = EXCLUDED.limit_total, access_code = EXCLUDED.access_code, enabled = EXCLUDED.enabled, sort = EXCLUDED.sort`, params: [orgId, d] },
  ];
}

/** fundraising → app.campaigns (+ personal pages). A campaign whose fund is not a donation fund is skipped (warned in the admin). */
export function fundraisingSql(orgId: string, doc: unknown): Statement[] {
  const d = JSON.stringify(doc);
  return [
    { sql: `INSERT INTO app.campaigns (org_id, id, name, fund_id, center_id, goal_cents, starts_on, ends_on, matching, status, spec)
      SELECT $1::uuid, c->>'id', c->>'name', c->>'fund', (SELECT x.id FROM app.centers x WHERE x.org_id = $1::uuid AND x.name = c->>'center'), (c->>'goalCents')::bigint,
        (c->>'start')::date, NULLIF(c->>'end', '')::date, coalesce(c->'matching', '[]'), CASE c->>'status' WHEN 'closed' THEN 'ended' WHEN 'live' THEN 'live' ELSE 'draft' END, c
      FROM jsonb_array_elements(coalesce($2::jsonb->'campaigns', '[]')) c
      WHERE EXISTS (SELECT 1 FROM app.funds f WHERE f.org_id = $1::uuid AND f.id = c->>'fund')
      ON CONFLICT (org_id, id) DO UPDATE SET name = EXCLUDED.name, fund_id = EXCLUDED.fund_id, center_id = EXCLUDED.center_id, goal_cents = EXCLUDED.goal_cents, starts_on = EXCLUDED.starts_on,
        ends_on = EXCLUDED.ends_on, matching = EXCLUDED.matching, status = EXCLUDED.status, spec = EXCLUDED.spec`, params: [orgId, d] },
    { sql: `UPDATE app.campaigns SET status = 'archived' WHERE org_id = $1::uuid AND id NOT IN (SELECT c->>'id' FROM jsonb_array_elements(coalesce($2::jsonb->'campaigns', '[]')) c)`, params: [orgId, d] },
    { sql: `INSERT INTO app.campaign_pages (org_id, id, campaign_id, member_id, owner_name, title, story, goal_cents, status, decided_by)
      SELECT $1::uuid, p->>'id', p->>'campaignId', coalesce(p->'owner'->>'memberId', ''), coalesce(p->'owner'->>'name', ''), p->>'title', coalesce(p->>'story', ''), greatest((p->>'goalCents')::bigint, 1), p->>'status', coalesce(p->>'note', '')
      FROM jsonb_array_elements(coalesce($2::jsonb->'pages', '[]')) p
      WHERE EXISTS (SELECT 1 FROM app.campaigns c WHERE c.org_id = $1::uuid AND c.id = p->>'campaignId')
      ON CONFLICT (org_id, id) DO UPDATE SET title = EXCLUDED.title, story = EXCLUDED.story, goal_cents = EXCLUDED.goal_cents, status = EXCLUDED.status, owner_name = EXCLUDED.owner_name`, params: [orgId, d] },
  ];
}

/** officials → app.official_terms: serving / vacant holders and the history (ended terms). Rebuilt on every publish. */
export function officialsSql(orgId: string, doc: unknown): Statement[] {
  const d = JSON.stringify(doc);
  const cols = `org_id, id, year, kind, office, title, zone_id, zone_code, center_id, center_name, zips, at_large, name, member_id, public_email, how, term_start, term_end, oath_on, orientation_on, status, end_reason, board_terms, show_on_website, source`;
  const common = (h: string) => `(SELECT z.id FROM app.zones z WHERE z.org_id = $1::uuid AND z.code = ${h}->>'zone'), coalesce(${h}->>'zone', ''), (SELECT c.id FROM app.centers c WHERE c.org_id = $1::uuid AND c.name = ${h}->>'center'), coalesce(${h}->>'center', ''),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(${h}->'zips', '[]'))), coalesce(${h}->>'atLarge', ''), coalesce(${h}->>'name', ''), NULLIF(${h}->>'memberId', ''), `;
  return [
    { sql: `DELETE FROM app.official_terms WHERE org_id = $1::uuid`, params: [orgId] },
    { sql: `INSERT INTO app.official_terms (${cols})
      SELECT $1::uuid, h->>'id', coalesce(extract(year FROM NULLIF(h->>'termStart', '')::date)::int - 1, extract(year FROM current_date)::int), h->>'kind', coalesce(h->>'office', ''), '', ${common('h')}
        coalesce(h->>'publicEmail', ''), coalesce(h->>'how', 'elected'), NULLIF(h->>'termStart', '')::date, NULLIF(h->>'termEnd', '')::date, NULLIF(h->>'oathOn', '')::date, NULLIF(h->>'orientationOn', '')::date,
        coalesce(h->>'status', 'serving'), coalesce(h->'vacancy'->>'reason', ''), coalesce((h->>'boardTerms')::smallint, 0), coalesce((h->>'showOnWebsite')::boolean, true), 'admin'
      FROM jsonb_array_elements(coalesce($2::jsonb->'holders', '[]')) h`, params: [orgId, d] },
    { sql: `INSERT INTO app.official_terms (${cols})
      SELECT $1::uuid, 'h' || left(t->>'id', 59), (t->>'year')::int, t->>'kind', coalesce(t->>'office', ''), coalesce(t->>'title', ''), ${common('t')}
        '', coalesce(t->>'how', 'elected'), NULLIF(t->>'termStart', '')::date, NULLIF(t->>'termEnd', '')::date, NULL, NULL, 'ended', coalesce(t->>'endReason', ''), 0, coalesce((t->>'showOnWebsite')::boolean, true), coalesce(t->>'source', 'manual')
      FROM jsonb_array_elements(coalesce($2::jsonb->'history', '[]')) t
      ON CONFLICT (org_id, id) DO NOTHING`, params: [orgId, d] },
  ];
}

/** groups → app.groups + the manual members (join requests and automatic members are kept elsewhere – see modules/comms.ts). */
export function groupsSql(orgId: string, doc: unknown): Statement[] {
  const d = JSON.stringify(doc);
  return [
    { sql: `INSERT INTO app.groups (org_id, id, name, kind, rules, who_can_join, archived, spec)
      SELECT $1::uuid, g->>'id', g->>'name', g->>'kind', jsonb_build_object('match', coalesce(g->>'match', 'all'), 'rules', coalesce(g->'rules', '[]')), coalesce(g->>'joinPolicy', 'admins'), coalesce((g->>'archived')::boolean, false), g
      FROM jsonb_array_elements(coalesce($2::jsonb->'groups', '[]')) g
      ON CONFLICT (org_id, id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, rules = EXCLUDED.rules, who_can_join = EXCLUDED.who_can_join, archived = EXCLUDED.archived, spec = EXCLUDED.spec`, params: [orgId, d] },
    { sql: `UPDATE app.groups SET archived = true WHERE org_id = $1::uuid AND id NOT IN (SELECT g->>'id' FROM jsonb_array_elements(coalesce($2::jsonb->'groups', '[]')) g)`, params: [orgId, d] },
    { sql: `DELETE FROM app.group_members gm WHERE gm.org_id = $1::uuid AND gm.status = 'in' AND gm.how IN ('added', 'joined')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce($2::jsonb->'groups', '[]')) g CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(g->'memberIds', '[]')) m WHERE g->>'id' = gm.group_id AND m = gm.member_id AND g->>'kind' = 'manual')`, params: [orgId, d] },
    { sql: `INSERT INTO app.group_members (org_id, group_id, member_id, how, status)
      SELECT $1::uuid, g->>'id', m, 'added', 'in' FROM jsonb_array_elements(coalesce($2::jsonb->'groups', '[]')) g CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(g->'memberIds', '[]')) m
      WHERE g->>'kind' = 'manual' AND EXISTS (SELECT 1 FROM app.members x WHERE x.org_id = $1::uuid AND x.id = m)
      ON CONFLICT (org_id, group_id, member_id) DO UPDATE SET status = 'in', how = CASE WHEN app.group_members.how = 'joined' THEN 'joined' ELSE 'added' END`, params: [orgId, d] },
  ];
}

const BUILDERS: Record<string, (orgId: string, doc: unknown) => Statement[]> = {
  'org-structure': orgStructureSql, 'membership-settings': plansSql, 'admin-access': accessSql, 'donation-settings': fundsSql, events: eventsSql, fundraising: fundraisingSql, officials: officialsSql, groups: groupsSql,
};
/** After a publish (or at seed): copy the document into its tables. Returns false when the key has no tables. */
export async function project(db: Db, orgId: string, key: string, doc: unknown): Promise<boolean> {
  const b = BUILDERS[key]; if (!b) return false;
  await db.run(as(orgId), b(orgId, doc));
  if (key === 'membership-settings' || key === 'org-structure') await db.run(as(orgId), [{ sql: 'SELECT app.backfill_memberships($1::uuid)', params: [orgId] }, { sql: 'SELECT app.refresh_status($1::uuid)', params: [orgId] }]);
  return true;
}
export const PROJECTED_KEYS = Object.keys(BUILDERS);

/** Publish a document from inside the API (one event saved, an approval…): same as PUT /admin/documents/:key – a new
 *  version, then the projection. The caller has validated `data` with the document's schema. */
export async function saveDocument(db: Db, orgId: string, key: string, data: unknown, by: string, note = ''): Promise<number> {
  const r = await db.run(as(orgId), [{ sql: `INSERT INTO app.documents (org_id, key, data, published_by, note) VALUES ($1, $2, $3::jsonb, $4, $5)
    ON CONFLICT (org_id, key) DO UPDATE SET data = EXCLUDED.data, version = app.documents.version + 1, published_at = now(), published_by = EXCLUDED.published_by, note = EXCLUDED.note RETURNING version`, params: [orgId, key, JSON.stringify(data), by, note.slice(0, 200)] }]);
  await project(db, orgId, key, data);
  return Number((r[0]?.[0] as { version?: number } | undefined)?.version ?? 0);
}
