/**
 * Is this environment safe for a real server? The API and the worker call assertProduction() when they start; with
 * NODE_ENV=production they refuse to start while anything below is an error (a development shortcut left on, a
 * missing secret). `npm run check:production -- --env=production` prints the same report for BE/.env.production
 * before a deploy (exit 1 = fix first). Values are never printed – only which setting is wrong.
 */
export type Report = { errors: string[]; warnings: string[] };

const DEV_ONLY = ['AUTH_DEV_HEADER', 'AUTH_DEV_CODES', 'AUTH_DEV_FIXED_CODE', 'AUTH_DEV_NO_LIMITS', 'AUTH_GOOGLE_FAKE', 'LOCALHOST_ORG', 'DNS_FAKE'] as const;

export function productionReport(env: NodeJS.ProcessEnv = process.env): Report {
  const errors: string[] = []; const warnings: string[] = [];
  const on = (k: string) => !!env[k] && env[k] !== '0' && env[k] !== 'false';
  const strong = (k: string, min = 32) => { const v = env[k] ?? ''; if (v.length < min || /change|example|xxx|secret|your-/i.test(v)) errors.push(`${k}: set a long random value (at least ${min} characters – e.g. openssl rand -hex 32).`); };

  if (env.NODE_ENV !== 'production') errors.push('NODE_ENV: must be "production" on the server.');
  for (const k of DEV_ONLY) if (on(k)) errors.push(`${k}: development only – remove it on the server.`);

  // database
  const url = env.DATABASE_URL ?? '';
  if (!url) errors.push('DATABASE_URL: missing.');
  else {
    let host = '';
    try { host = new URL(url).hostname; } catch { errors.push('DATABASE_URL: not a valid address (a password with @ or # must be written %40 / %23).'); }
    if (/CHANGE|PASSWORD@/i.test(url)) errors.push('DATABASE_URL: still has the example password.');
    const ssl = (env.DATABASE_SSL ?? (url.match(/sslmode=([\w-]+)/)?.[1] ?? 'disable')).toLowerCase();
    if (host && !/^(localhost|127\.0\.0\.1|::1|db|postgres)$/.test(host) && ssl === 'disable') warnings.push('DATABASE_SSL: the database is on another machine – use require (or verify-full with a certificate).');
  }
  if (env.DB_ADAPTER === 'psql') errors.push('DB_ADAPTER: psql is for tests – leave it unset (pg).');

  // addresses and trust
  if (env.TENANT_FROM_HOST !== '1') errors.push('TENANT_FROM_HOST: must be 1 (the address decides the organization).');
  if (!env.BASE_DOMAIN || /localhost/.test(env.BASE_DOMAIN)) errors.push('BASE_DOMAIN: set the real domain (e.g. nextgrow.pro).');
  strong('EDGE_KEY');
  if (!(env.ALLOWED_ORIGINS ?? '').trim()) errors.push('ALLOWED_ORIGINS: list the sites allowed to write (https://member-web.example.org,https://member-admin.example.org,…).');
  else if (/localhost|http:\/\//.test(env.ALLOWED_ORIGINS ?? '')) warnings.push('ALLOWED_ORIGINS: contains http:// or localhost addresses.');
  if (env.TRUST_PROXY !== '1') warnings.push('TRUST_PROXY: set 1 when nginx (or another proxy) is in front, so visitors are told apart by their real address.');

  // sign-in
  strong('AUTH_PEPPER');
  if (env.COOKIE_SECURE !== '1') errors.push('COOKIE_SECURE: must be 1 (sign-in cookies only over https).');
  if (!env.PLATFORM_OWNER_EMAIL || /example\.(org|com)$/i.test(env.PLATFORM_OWNER_EMAIL)) warnings.push('PLATFORM_OWNER_EMAIL: set the real platform owner address.');

  // money, messages, files
  if ((env.PAYMENTS_PROVIDER ?? 'fake') !== 'stripe') {
    if (env.ALLOW_FAKE_PAYMENTS === '1') warnings.push('PAYMENTS_PROVIDER: fake payments are on (ALLOW_FAKE_PAYMENTS=1) – nobody is charged; only for a staging server.');
    else errors.push('PAYMENTS_PROVIDER: set stripe (+ STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET). For a staging server without payments set ALLOW_FAKE_PAYMENTS=1.');
  } else for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) if (!env[k]) errors.push(`${k}: missing (PAYMENTS_PROVIDER=stripe).`);
  const TOKENS: Record<string, string[]> = { postmark: ['POSTMARK_TOKEN'], sendgrid: ['SENDGRID_KEY'], resend: ['RESEND_KEY'], twilio: ['TWILIO_SID', 'TWILIO_TOKEN'] };
  for (const [k, p] of [['EMAIL_PROVIDER', env.EMAIL_PROVIDER], ['SMS_PROVIDER', env.SMS_PROVIDER]] as const) {
    if (p === 'fail') errors.push(`${k}: fail is for tests.`);
    for (const t of TOKENS[p ?? ''] ?? []) if (!env[t]) errors.push(`${t}: missing (${k}=${p}).`);
  }
  if ((env.EMAIL_PROVIDER ?? '') !== 'log' && env.EMAIL_PROVIDER && !env.MAIL_FROM) errors.push('MAIL_FROM: set the sending address.');
  if (env.FILES_STORAGE === 's3') for (const t of ['S3_BUCKET', 'S3_KEY', 'S3_SECRET']) if (!env[t]) errors.push(`${t}: missing (FILES_STORAGE=s3).`);
  if ((env.EMAIL_PROVIDER ?? 'log') === 'log') warnings.push('EMAIL_PROVIDER: log – no email is sent (sign-in codes too!). Pick postmark, sendgrid or resend.');
  if ((env.SMS_PROVIDER ?? 'log') === 'log') warnings.push('SMS_PROVIDER: log – no text message is sent.');
  if ((env.FILES_STORAGE ?? 'local') === 'local') warnings.push(`FILES_STORAGE: local – keep FILES_DIR (${env.FILES_DIR || './data/files'}) on a disk that survives updates and is backed up, or use s3.`);
  if (on('MEMBERS_CACHE_SECONDS')) warnings.push('MEMBERS_CACHE_SECONDS: only correct with ONE API process – remove it if you run more.');
  if (on('API_LOG')) warnings.push('API_LOG: every request is printed – fine while starting, noisy later.');
  return { errors, warnings };
}

export function printReport(r: Report, title = 'Production check'): void {
  console.log(`${title}: ${r.errors.length ? `${r.errors.length} problem(s) to fix` : 'ready'}${r.warnings.length ? `, ${r.warnings.length} note(s)` : ''}`);
  for (const e of r.errors) console.log(`  ✗ ${e}`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
}

/** Called by the API and the worker at start. Outside production it does nothing. */
export function assertProduction(what: string): void {
  if (process.env.NODE_ENV !== 'production') return;
  const r = productionReport();
  if (r.errors.length) { printReport(r, `${what} will not start`); process.exit(1); }
  if (r.warnings.length) printReport(r, `${what}`);
}

if (process.argv[1] && /production\.ts$/.test(process.argv[1])) {
  // npm run check:production [-- --env=production]: checks the settings as the server would see them
  const r = productionReport({ ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' });
  printReport(r);
  process.exit(r.errors.length ? 1 : 0);
}
