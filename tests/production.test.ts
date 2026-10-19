/**
 * Production readiness: the settings check (white box) and the real start (black box) – the API refuses to start with a
 * development shortcut in production, starts with good settings, answers /health, and stops cleanly on SIGTERM.
 * DATABASE_URL=… DB_ADAPTER=psql tsx tests/production.test.ts
 */
import { spawn } from 'node:child_process';
import { productionReport } from '../src/production.js';

let pass = 0, fail = 0; const ok = (c: unknown, m: string, extra?: unknown) => { c ? pass++ : (fail++, console.log('FAIL', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400))); };
const key = 'a'.repeat(64);
const good: NodeJS.ProcessEnv = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://membership_owner:Xy7%40longpass@127.0.0.1:5432/membership', TENANT_FROM_HOST: '1', BASE_DOMAIN: 'nextgrow.pro',
  EDGE_KEY: key, AUTH_PEPPER: key.replace(/a/g, 'b'), COOKIE_SECURE: '1', ALLOWED_ORIGINS: 'https://member-web.nextgrow.pro', TRUST_PROXY: '1', PLATFORM_OWNER_EMAIL: 'owner@nextgrow.pro',
  PAYMENTS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', EMAIL_PROVIDER: 'postmark', POSTMARK_TOKEN: 't', MAIL_FROM: 'no-reply@nextgrow.pro', SMS_PROVIDER: 'log' };

/* white box: the rules */
const g = productionReport(good);
ok(g.errors.length === 0, 'good production settings pass', g.errors);
for (const k of ['AUTH_DEV_HEADER', 'AUTH_DEV_CODES', 'AUTH_DEV_FIXED_CODE', 'AUTH_DEV_NO_LIMITS', 'AUTH_GOOGLE_FAKE', 'LOCALHOST_ORG', 'DNS_FAKE'])
  ok(productionReport({ ...good, [k]: '1' }).errors.some((e) => e.startsWith(k)), `${k} is refused in production`);
ok(productionReport({ ...good, AUTH_PEPPER: 'short' }).errors.some((e) => e.startsWith('AUTH_PEPPER')), 'short pepper refused');
ok(productionReport({ ...good, EDGE_KEY: 'CHANGE' }).errors.some((e) => e.startsWith('EDGE_KEY')), 'example edge key refused');
ok(productionReport({ ...good, COOKIE_SECURE: '' }).errors.some((e) => e.startsWith('COOKIE_SECURE')), 'insecure cookies refused');
ok(productionReport({ ...good, TENANT_FROM_HOST: '' }).errors.some((e) => e.startsWith('TENANT_FROM_HOST')), 'tenant must come from the address');
ok(productionReport({ ...good, BASE_DOMAIN: 'localhost' }).errors.some((e) => e.startsWith('BASE_DOMAIN')), 'localhost domain refused');
ok(productionReport({ ...good, DB_ADAPTER: 'psql' }).errors.some((e) => e.startsWith('DB_ADAPTER')), 'psql adapter refused');
ok(productionReport({ ...good, PAYMENTS_PROVIDER: 'fake' }).errors.some((e) => e.startsWith('PAYMENTS_PROVIDER')), 'fake payments refused…');
ok(productionReport({ ...good, PAYMENTS_PROVIDER: 'fake', ALLOW_FAKE_PAYMENTS: '1' }).errors.length === 0, '…unless a staging server says so');
ok(productionReport({ ...good, EMAIL_PROVIDER: 'postmark', POSTMARK_TOKEN: '' }).errors.some((e) => e.startsWith('POSTMARK_TOKEN')), 'provider without its token refused');
ok(productionReport({ ...good, EMAIL_PROVIDER: 'log' }).warnings.some((w) => w.startsWith('EMAIL_PROVIDER')), 'no email provider is a warning');
ok(productionReport({ ...good, DATABASE_URL: 'postgresql://u:p@db.example.net:5432/m', DATABASE_SSL: 'disable' }).warnings.some((w) => w.startsWith('DATABASE_SSL')), 'remote database without encryption warned');
ok(!JSON.stringify(productionReport({ ...good, AUTH_PEPPER: 'tooShortSecretValue' })).includes('tooShortSecretValue'), 'no secret value is ever printed');

/* black box: the real process */
const run = (env: NodeJS.ProcessEnv, port: number) => spawn(process.execPath, ['--import', 'tsx', 'src/http/server.ts'], { env: { PATH: process.env.PATH, ...env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
const exitOf = (p: ReturnType<typeof run>) => new Promise<{ code: number | null; out: string }>((res) => { let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.on('exit', (code) => res({ code, out })); });

const bad = run({ ...good, DATABASE_URL: process.env.DATABASE_URL, AUTH_DEV_CODES: '1' }, 4391);
const b = await exitOf(bad);
ok(b.code === 1 && /will not start/.test(b.out) && /AUTH_DEV_CODES/.test(b.out), 'the API refuses to start with a development switch', b);

// good settings against the test database (psql adapter refused in production → allowed only here through the check's own rule? no: use pg if present)
const hasPg = await import('pg' as string).then(() => true).catch(() => false);
if (hasPg) {
  const p = run({ ...good, DATABASE_URL: process.env.DATABASE_URL }, 4392); const done = exitOf(p);
  let h: Response | null = null; for (let i = 0; i < 40 && !h; i++) { await new Promise((r) => setTimeout(r, 250)); h = await fetch('http://127.0.0.1:4392/health').catch(() => null); }
  ok(h?.status === 200, 'starts and answers /health in production');
  const body = await h?.json().catch(() => ({})) as Record<string, unknown>;
  ok(body && !('database' in (body.db as object ?? {})), 'health hides database details in production', body);
  p.kill('SIGTERM'); const e = await done;
  ok(e.code === 0 && /SIGTERM/.test(e.out), 'stops cleanly on SIGTERM', e);
} else {
  // no pg driver here: the same start / health / SIGTERM path in development mode with the test adapter
  const p = run({ DATABASE_URL: process.env.DATABASE_URL, DB_ADAPTER: 'psql' }, 4393); const done = exitOf(p);
  let h: Response | null = null; for (let i = 0; i < 60 && !h; i++) { await new Promise((r) => setTimeout(r, 250)); h = await fetch('http://127.0.0.1:4393/health').catch(() => null); }
  ok(h?.status === 200, 'starts on HOST=127.0.0.1 and answers /health');
  p.kill('SIGTERM'); const e = await done;
  ok(e.code === 0 && /SIGTERM/.test(e.out), 'stops cleanly on SIGTERM', e);
}
console.log(`production ${pass}/${pass + fail}`); process.exit(fail ? 1 : 0);
