/**
 * Geography: the ZIP loader (Census Gazetteer + a city list, merged) and what the website does with it.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/geo.test.ts
 */
import { readFileSync } from 'node:fs';
process.env.AUTH_DEV_HEADER = '1';
const { createApi } = await import('../src/http/server.js');
const { openDb, one } = await import('../src/db/sql.js');
const { loadZips, parseZipFile } = await import('../src/db/load-zips.js');

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400))); };
const db = openDb(); const OWNER = { org: null, role: 'owner' as const };
const server = createApi(db); await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as any }; };

const gaz = readFileSync(new URL('./fixtures/zcta-sample.txt', import.meta.url), 'utf8'); const csv = readFileSync(new URL('./fixtures/zips-sample.csv', import.meta.url), 'utf8');
ok(parseZipFile(gaz).length === 3 && parseZipFile(gaz)[0].lat === 29.698466 && parseZipFile(gaz)[0].city === '', 'Gazetteer read (tab-separated, no city)');
ok(parseZipFile(csv).some((r) => r.code === '96815' && r.city === 'Honolulu' && r.state === 'HI'), 'city list read (CSV with quotes)');
ok(await loadZips(db, gaz) === 3 && await loadZips(db, csv) === 3, 'both loaded');
const z = await one<{ city: string; state: string; lat: string; timezone: string }>(db, OWNER, `SELECT city, state, lat::text, timezone FROM geo.postal_codes WHERE code = '78701'`);
ok(z!.city === 'Austin' && z!.state === 'TX' && z!.lat.startsWith('30.27') && z!.timezone === 'America/Chicago', 'the second file fills what the first left empty', z);
await loadZips(db, 'zip,city\n78701,\n');
ok((await one<{ city: string }>(db, OWNER, `SELECT city FROM geo.postal_codes WHERE code = '78701'`))!.city === 'Austin', 'an empty value never blanks a known one');

const inside = await get('/public/place?zip=77036');
ok(inside.status === 200 && !!inside.body.center_name && inside.body.place?.city === 'Houston', `77036 → ${inside.body.center_name}, Houston`, inside.body);
const outside = await get('/public/place?zip=78701');
ok(outside.body.why.includes('outside') && outside.body.place?.city === 'Austin' && Array.isArray(outside.body.nearest), 'outside every zone: says where it is', outside.body);
const centersWithPlace = (await one<{ n: number }>(db, OWNER, `SELECT count(*)::int AS n FROM app.centers WHERE lat IS NOT NULL`))!.n;
ok(centersWithPlace === 0 || outside.body.nearest.length > 0, `nearest masjids offered (${outside.body.nearest.map((x: any) => `${x.name} ${x.miles} mi`).join(', ') || 'no masjid has a location yet'})`);

server.close(); await db.close();
console.log(`geo ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
export {};
