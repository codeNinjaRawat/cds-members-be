/**
 * White-box: database settings for local, the server's DEV database and the live server – no database needed.
 * tsx tests/db-config.test.ts
 */
import { pgConfig, psqlUrl, sslSettings } from '../src/db/sql.js';
import { applyEnv, describeDb, parseEnv, profileName } from '../src/env-file.js';
import { judge, stripPsql, testsAllowed } from '../src/db/sql-tests.js';

let pass = 0, fail = 0; const ok = (c: boolean, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra))); };
const DEV = 'postgresql://membership_dev_owner:p4ss-word_1@3.18.46.122:5432/membership_dev';

// ssl words → one meaning in both drivers
ok(sslSettings(DEV, {}).mode === 'disable', 'no setting → no encryption (same machine default, as before)');
ok(pgConfig(DEV, {}).ssl === false, 'pg: disable → ssl false');
const req = pgConfig(DEV, { DATABASE_SSL: 'require' });
ok(JSON.stringify(req.ssl) === '{"rejectUnauthorized":false}', 'pg: require → encrypted, self-signed accepted', req.ssl);
ok(JSON.stringify(pgConfig(DEV + '?sslmode=no-verify', {}).ssl) === '{"rejectUnauthorized":false}', 'sslmode=no-verify in the address works too');
ok(JSON.stringify(pgConfig(DEV + '?sslmode=require', {}).ssl) === '{"rejectUnauthorized":false}', 'sslmode=require in the address: encrypted, no certificate check (pg alone would reject self-signed)');
ok((pgConfig(DEV + '?sslmode=require', { DATABASE_SSL: 'disable' }).ssl) === false, 'DATABASE_SSL wins over the address');
const vf = pgConfig(DEV, { DATABASE_SSL: 'verify-full' }).ssl as { rejectUnauthorized: boolean };
ok(vf.rejectUnauthorized === true, 'verify-full checks the certificate');
ok(!pgConfig(DEV + '?sslmode=require&uselibpqcompat=true', {}).connectionString.includes('sslmode'), 'ssl words removed from the address handed to pg', pgConfig(DEV + '?sslmode=require', {}).connectionString);
ok(pgConfig(DEV, {}).connectionString === DEV, 'address otherwise unchanged (user, password, host, database)');
let threw = false; try { sslSettings(DEV, { DATABASE_SSL: 'maybe' }); } catch { threw = true; } ok(threw, 'unknown ssl word is an error, not a silent downgrade');
ok(psqlUrl(DEV, { DATABASE_SSL: 'no-verify' }).endsWith('?sslmode=require'), 'psql: no-verify → require (psql does not know no-verify)', psqlUrl(DEV, { DATABASE_SSL: 'no-verify' }));
ok(psqlUrl(DEV, {}) === DEV, 'psql: nothing set → address unchanged');
ok(psqlUrl(DEV + '?sslmode=verify', {}).endsWith('sslmode=verify-full'), 'psql: verify → verify-full');
const enc = 'postgresql://u:a%40b%3Ac@h:5432/d'; ok(pgConfig(enc, { DATABASE_SSL: 'require' }).connectionString === enc, 'URL-encoded password kept as typed');
ok(pgConfig(DEV, { DATABASE_POOL_MAX: '5', DATABASE_CONNECT_TIMEOUT_MS: 'x' }).max === 5 && pgConfig(DEV, {}).connectionTimeoutMillis === 10000, 'pool size and timeout from settings, bad numbers → defaults');
ok(pgConfig(DEV, { DATABASE_APP_NAME: 'membership-api-pc' }).application_name === 'membership-api-pc' && pgConfig(DEV, {}).application_name === 'membership-api', 'application name shown in pgAdmin');

// env files and profiles
ok(JSON.stringify(parseEnv('# c\nA=1\nB="x # y"\nC=2  # note\nbad line\n1X=3\n')) === JSON.stringify([['A', '1'], ['B', 'x # y'], ['C', '2']]), 'env lines parsed (quotes, comments)');
ok(profileName(['node', 'x.ts', '--env=server-dev'], {}) === 'server-dev', '--env=server-dev picked up');
ok(profileName(['node', 'x.ts'], { BE_ENV: 'server-dev' }) === 'server-dev' && profileName(['node', 'x.ts', '--env=a'], { BE_ENV: 'b' }) === 'a', 'BE_ENV used, --env wins');
threw = false; try { profileName(['--env=../etc'], {}); } catch { threw = true; } ok(threw, 'profile name cannot walk out of BE/');
const env: Record<string, string> = { PORT: '9999' };
applyEnv(['DATABASE_URL=remote\nDATABASE_SSL=require', 'DATABASE_URL=local\nPORT=4330\nAUTH_PEPPER=x'], env);
ok(env.DATABASE_URL === 'remote' && env.DATABASE_SSL === 'require' && env.AUTH_PEPPER === 'x' && env.PORT === '9999', 'profile before .env, terminal before both', env);
ok(describeDb(DEV) === 'membership_dev_owner@3.18.46.122:5432/membership_dev' && !describeDb(DEV).includes('p4ss'), 'description never shows the password');

// SQL tests runner and connection hints
ok(testsAllowed('membership_dev', {}) && testsAllowed('membership_test', {}) && !testsAllowed('membership', {}) && testsAllowed('membership', { DATABASE_ALLOW_TESTS: '1' }), 'SQL tests refuse the live database');
ok(stripPsql('\\set ON_ERROR_STOP on\nSELECT 1;') === 'SELECT 1;', 'psql commands skipped');
const j = judge([{ rows: [{ test: 'a', ok: true }] }, { rows: [{ test: 'b', ok: false }] }, {}], ['ok: refused', 'FAIL: x']);
ok(j.passed === 2 && j.failed.length === 2, 'ok=false rows and FAIL notices count as failures', j);

console.log(`db-config: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
