/**
 * Load ZIP / postal codes into geo.postal_codes (shared by every organization; read-only for the API).
 *   npm run geo:load -- <file> [--country US]
 * The file is CSV or tab-separated with a header row; columns are found by name:
 *   code:  zip | zcta | GEOID | postal_code       lat: lat | latitude | INTPTLAT      lng: lng | lon | longitude | INTPTLONG
 *   city:  city | primary_city | place            state: state_id | state | stusps      county: county_name | county
 *   timezone: timezone | tz
 * Works with the US Census ZCTA Gazetteer (2023_Gaz_zcta_national.txt: center points, no city or state) and with ZIP
 * lists that carry city / state / county / time zone (for example simplemaps' uszips.csv, CC BY 4.0). Load the Gazetteer
 * first and a city list after it: a later file fills the columns an earlier one left empty and never blanks them.
 */
import { readFileSync } from 'node:fs';
import { openDb } from './sql.js';

const PLATFORM = { org: null, role: 'app_platform' as const };
export function parseZipFile(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const split = (l: string) => { if (sep === '\t') return l.split('\t').map((x) => x.trim()); const out: string[] = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; };
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const c = { code: col('zip', 'zcta', 'geoid', 'postal_code', 'zcta5'), lat: col('lat', 'latitude', 'intptlat'), lng: col('lng', 'lon', 'longitude', 'intptlong'), city: col('city', 'primary_city', 'place'), state: col('state_id', 'stusps', 'state'), county: col('county_name', 'county'), tz: col('timezone', 'tz') };
  if (c.code < 0) throw new Error(`No ZIP column in: ${head.join(', ')}`);
  return lines.slice(1).map(split).map((r) => ({ code: (r[c.code] ?? '').padStart(5, '0'), lat: c.lat >= 0 ? Number(r[c.lat]) || null : null, lng: c.lng >= 0 ? Number(r[c.lng]) || null : null,
    city: c.city >= 0 ? r[c.city] ?? '' : '', state: c.state >= 0 ? (r[c.state] ?? '').slice(0, 2).toUpperCase() : '', county: c.county >= 0 ? r[c.county] ?? '' : '', timezone: c.tz >= 0 ? r[c.tz] ?? '' : '' }))
    .filter((r) => /^[0-9]{5}$/.test(r.code));
}
export async function loadZips(db: ReturnType<typeof openDb>, text: string, country = 'US') {
  const list = parseZipFile(text); let n = 0;
  for (let i = 0; i < list.length; i += 2000) {
    const part = list.slice(i, i + 2000);
    await db.run(PLATFORM, [{ sql: `INSERT INTO geo.postal_codes (country, code, city, state, county, lat, lng, timezone)
      SELECT $1, r.code, coalesce(r.city, ''), coalesce(r.state, ''), coalesce(r.county, ''), r.lat, r.lng, coalesce(r.timezone, '')
      FROM jsonb_to_recordset($2::jsonb) AS r(code text, city text, state text, county text, lat numeric, lng numeric, timezone text)
      ON CONFLICT (country, code) DO UPDATE SET city = coalesce(NULLIF(EXCLUDED.city, ''), geo.postal_codes.city), state = coalesce(NULLIF(EXCLUDED.state, ''), geo.postal_codes.state),
        county = coalesce(NULLIF(EXCLUDED.county, ''), geo.postal_codes.county), lat = coalesce(EXCLUDED.lat, geo.postal_codes.lat), lng = coalesce(EXCLUDED.lng, geo.postal_codes.lng),
        timezone = coalesce(NULLIF(EXCLUDED.timezone, ''), geo.postal_codes.timezone)`, params: [country, JSON.stringify(part)] }]);
    n += part.length;
  }
  return n;
}
if (process.argv[1] && /load-zips\.ts$/.test(process.argv[1])) {
  const file = process.argv[2]; if (!file) { console.error('npm run geo:load -- <file> [--country US]'); process.exit(1); }
  const ci = process.argv.indexOf('--country'); const country = ci > 0 ? process.argv[ci + 1] : 'US';
  const db = openDb(); const n = await loadZips(db, readFileSync(file, 'utf8'), country); await db.close();
  console.log(`geo: ${n} postal codes loaded for ${country}`);
}
