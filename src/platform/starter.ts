/**
 * B6b Starter content. The built-in documents (REGISTRY initial) are ISGH's – fine for ISGH (client #1) and useful as
 * presets, but a new organization must never show ISGH's name, address, centers, people, numbers or needs. When an
 * organization has not published a document yet, document() asks here: ISGH gets the built-in one; everyone else gets it
 * re-branded with their own name, short name, address and site, with ISGH-only lists emptied. The template decides the
 * rest: 'bylaws-society' keeps the elected-body pages and Board approval, 'simple-masjid' drops them, 'blank' keeps only
 * the legal pages. Every starter is checked with the document's schema.
 */
import type { Db } from '../db/sql.js';
import { one } from '../db/sql.js';
import { PLATFORM } from '../http/core.js';

type Org = { name: string; shortName: string; slug: string; email: string; phone: string; address: string; city: string; state: string; template: 'bylaws-society' | 'simple-masjid' | 'blank'; founding: boolean };
const cache = new Map<string, { at: number; org: Org | null }>();
async function orgOf(db: Db, orgId: string): Promise<Org | null> {
  const c = cache.get(orgId); if (c && Date.now() - c.at < 60_000) return c.org;
  const r = await one<{ name: string; short_name: string; slug: string; email: string; phone: string; address: string; city: string; state: string; template: Org['template']; founding: boolean }>(db, PLATFORM,
    `SELECT name, short_name, slug, email::text, phone, address, city, state, template, (founding OR client_no = 1) AS founding FROM platform.organizations WHERE id = $1::uuid`, [orgId]);
  const org = r ? { name: r.name, shortName: r.short_name || r.slug.toUpperCase(), slug: r.slug, email: r.email || `office@${r.slug}.org`, phone: r.phone, address: r.address, city: r.city, state: r.state, template: r.template, founding: r.founding } : null;
  cache.set(orgId, { at: Date.now(), org }); return org;
}
export const forgetOrg = (orgId: string) => cache.delete(orgId);

/** ISGH's identity → the organization's, in every string of a document. */
function brand<T>(v: T, o: Org): T {
  const site = `${o.slug}.${process.env.BASE_DOMAIN ?? 'nextgrow.pro'}`;
  const place = [o.city, o.state].filter(Boolean).join(', ');
  const swap = (s: string) => s
    .replace(/Islamic Society of Greater Houston/g, o.name).replace(/\bISGH\b/g, o.shortName).replace(/\bisgh\b/g, o.slug)
    .replace(/[a-z.-]*isgh\.org/gi, site).replace(/3110\+Eastside\+St[^&"\s]*/g, encodeURIComponent([o.address, o.city, o.state].filter(Boolean).join(' ')).replace(/%20/g, '+')).replace(/3110 Eastside St(reet)?,?\s*/g, o.address ? `${o.address}, ` : '')
    .replace(/Houston, TX( \d{5})?/g, place).replace(/Greater Houston/g, o.city || o.name).replace(/\bHouston\b/g, o.city || '').replace(/\(713\) 524-6615/g, o.phone);
  const walk = (x: unknown): unknown => typeof x === 'string' ? swap(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
  return walk(v) as T;
}
/** Bulk email must show a postal address with ZIP (CAN-SPAM). Without one we write 00000 – sending refuses it until it is fixed. */
const footerOf = (o: Org) => { const addr = [o.address, o.city, o.state].filter(Boolean).join(', '); return `${o.name} · ${/\d{5}/.test(addr) ? addr : `${addr ? `${addr} ` : ''}ZIP 00000 (add your postal address in Communication › Sending)`}`; };
const ELECTED_PAGES = ['elections', 'centers/zones', 'constitution-bylaws', 'reports'];
const LEGAL_PAGES = ['privacy', 'terms', 'accessibility', 'contact'];

/** What a new organization starts with for one document (undefined = the key has no starter: use the built-in one). */
function starterOf(key: string, initial: any, o: Org): unknown {
  const b = brand(structuredClone(initial), o);
  switch (key) {
    case 'site-config': return { ...b, org: { ...b.org, name: o.name, shortName: o.shortName, address: [o.address, [o.city, o.state].filter(Boolean).join(', ')].filter(Boolean).length ? [o.address, [o.city, o.state].filter(Boolean).join(', ')].filter(Boolean) : [o.name], phone: { display: o.phone, tel: o.phone.replace(/[^\d+]/g, '') }, email: o.email, founded: undefined, taxNote: undefined }, footer: { ...b.footer, social: [] }, announcement: null };
    case 'home': return { ...b, zones: [], stats: [] };
    case 'pages': return Object.fromEntries(Object.entries(b).filter(([slug]) => o.template === 'blank' ? LEGAL_PAGES.includes(slug) : o.template === 'simple-masjid' ? !ELECTED_PAGES.includes(slug) : true));
    case 'news': return [];
    case 'giving': return { ...b, totals: [], impact: [], needs: [] };
    case 'membership-settings': return { ...b, serviceArea: { ...b.serviceArea, states: o.state ? [o.state] : b.serviceArea.states } };
    case 'org-config': return { ...b, discounts: { ...b.discounts, codes: [] } };
    // nothing connected yet: no keys, no accounts, no sending domain of anyone else
    case 'integrations': return { ...b, email: { ...b.email, enabled: false, domain: o.email.split('@')[1] ?? `${o.slug}.org`, fromTransactional: o.email, fromBulk: `news@${o.email.split('@')[1] ?? `${o.slug}.org`}`, dns: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' } },
      sms: { ...b.sms, enabled: false, from: /^\+1\d{10}$/.test(`+1${o.phone.replace(/\D/g, '').slice(-10)}`) ? `+1${o.phone.replace(/\D/g, '').slice(-10)}` : '+15555550100', registration: { ...b.sms.registration, status: 'not-started' } }, giving: { ...b.giving, accounts: [] },
      stripe: { enabled: false, mode: 'test', publishableKey: '', ach: false, applePayDomainVerified: false, statementDescriptor: `${o.shortName.toUpperCase().replace(/[^A-Z0-9 .-]/g, '')} GIFTS`.slice(0, 22).padEnd(5, ' ').trim().padEnd(5, 'X') }, google: { enabled: false, clientId: '', redirectUris: [] } };
    case 'communication': return { ...b, sender: { ...b.sender, fromName: o.shortName, replyTo: o.email, ccAdmins: [], footer: footerOf(o) } };
    case 'donation-settings': return { ...b, mainCenter: '', centers: {},   // per-masjid payment accounts belong to the organization that set them up
      platforms: Object.fromEntries(Object.entries(b.platforms).map(([k, v]: [string, any]) => [k, { ...v, enabled: false, lastSync: '' }])) };
    case 'finance-settings': return { ...b, accounts: [], budgets: [], openingCents: {}, plan: { approvedOn: '' }, audit: { ...b.audit, presentedOn: '' } };
    case 'benefits': return { ...b, partners: [], offers: [] };
    // prayer times need the organization's own place (latitude / longitude): off until it is set
    case 'prayer-times': return { ...b, centers: [], special: b.special.filter((x: any) => !x.center), location: { ...b.location, label: o.city || o.name }, website: { ...b.website, enabled: false } };
    case 'work-settings': return { ...b, helpdesk: { ...b.helpdesk, categories: b.helpdesk.categories.map((c: any) => ({ ...c, owner: c.owner?.kind === 'admin' ? { kind: 'none', id: '' } : c.owner })) } };
    case 'admin-access': return { ...b, admins: [] };
    case 'org-structure': return { zones: [], centers: [] };
    case 'officials': return { ...b, holders: [], history: [], website: { ...b.website, enabled: false } };
    case 'elections': return { rules: b.rules, elections: [] };
    case 'records': return { ...b, items: [], website: { ...b.website, enabled: false } };
    case 'events': return { ...b, events: [] };
    case 'fundraising': return { ...b, campaigns: [], pages: [], website: { enabled: false } };
    case 'groups': return { ...b, groups: [] };
    default: return b;   // settings documents (zakat rules, sign-in, join form, themes…) – ISGH's values are presets, re-branded
  }
}

/** Removes every list entry that is a marked sample (any text in it contains "(demo)"). */
function dropDemo(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => !(x && typeof x === 'object' && JSON.stringify(x).includes('(demo)'))).map(dropDemo);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dropDemo(x)]));
  return v;
}

/** The document an organization sees before it publishes one. */
export async function starterFor(db: Db, orgId: string, key: string): Promise<unknown> {
  const { REGISTRY } = await import('../registry.js');
  const entry = (REGISTRY as Record<string, { initial: unknown; schema: { safeParse: (x: unknown) => { success: boolean; data?: unknown; error?: { issues: { path: (string | number)[]; message: string }[] } } } }>)[key];
  if (!entry) return null;
  const o = await orgOf(db, orgId);
  if (!o || (o.founding && key === 'admin-access')) return entry.initial;
  if (o.founding && key !== 'admin-access') {
    // the founding organization keeps its own built-in content, minus the sample entries marked "(demo)"
    // (made-up events, partners, people…) – a live site must never show invented records
    const clean = dropDemo(structuredClone(entry.initial));
    const p = entry.schema.safeParse(clean);
    return p.success ? p.data : entry.initial;
  }
  const s = starterOf(key, entry.initial, o);
  const p = entry.schema.safeParse(s);
  if (!p.success) throw new Error(`Starter “${key}” for ${o.slug} does not fit its schema: ${p.error!.issues[0]?.path.join('.')} ${p.error!.issues[0]?.message}`);
  return p.data;
}
/** For the platform test and the panel: every starter of a template, checked. */
export async function allStarters(db: Db, orgId: string) {
  const { DOC_KEYS } = await import('../registry.js');
  const out: Record<string, unknown> = {};
  for (const k of DOC_KEYS) if (k !== 'admin-access') out[k] = await starterFor(db, orgId, k);   // the access list is written when the organization is created (its owner)
  return out;
}
