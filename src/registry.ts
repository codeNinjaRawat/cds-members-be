/**
 * The documents the API serves and stores – the same zod schemas and starter content the admin uses
 * (admin/src/lib/store/registry.ts; contracts are synced there from web/src/lib by scripts/sync-contracts.mjs).
 * The API never trusts a browser: every PUT is parsed with the schema, every GET of a public document goes
 * through the public projection below so member data never leaves the server.
 */
import { REGISTRY, type DocKey } from '@/lib/store/registry';
import { permissionForDoc, type Permission } from '@/lib/community/access';
import { publicOfficials, publicPastLeadership } from '@/lib/community/officials';
import { recordsFor } from '@/lib/community/records';
import { EventsSchema, canSee, publicEvents } from '@/lib/community/events';

export { REGISTRY, type DocKey };
export const DOC_KEYS = Object.keys(REGISTRY) as DocKey[];
export const isDocKey = (k: string): k is DocKey => (DOC_KEYS as string[]).includes(k);
export const permissionToPublish = (k: DocKey): Permission => permissionForDoc(k);

/** Public projections: what GET /public/... may return of a document (null = the document is not public at all). */
export const PUBLIC: Partial<Record<DocKey, (data: unknown, ctx: { today: string; zoneName: (id: string) => string }) => unknown>> = {
  'membership-settings': (d) => d,
  'org-structure': (d) => d,
  'prayer-times': (d) => d,
  'site-config': (d) => d, home: (d) => d, pages: (d) => d, news: (d) => d, themes: (d) => d, giving: (d) => d, 'join-form': (d) => d,
  // registration codes, approval notes and members-only events never leave through the plain document (GET /public/events has live seats)
  events: (d) => { const p = publicEvents(EventsSchema.parse(d)); return { ...p, events: p.events.filter((e) => canSee(e, { signedIn: false })) }; },
  groups: (d) => d, fundraising: (d) => d, 'sign-in': (d) => d,
  officials: (d, c) => { const o = REGISTRY.officials.schema.parse(d); return { people: publicOfficials(o, c.today), past: publicPastLeadership(o, c.zoneName), website: o.website }; },
  records: (d) => { const r = REGISTRY.records.schema.parse(d); return r.website.enabled ? { website: r.website, items: recordsFor(r, 'public') } : null; },
};
