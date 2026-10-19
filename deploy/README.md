# Deploying the BE (API + worker) on the server

The API and the worker run next to the website, admin and SaaS panel on the same server (DEPLOY.md at the
membership root). The three apps call the API on `http://127.0.0.1:4330` with the edge key, so the API is **not**
public. nginx exposes only what outside services need: payment/email/text-message webhooks, signed file addresses,
the member app (`/app/*`) and `/health`.

```
browser ──https──► nginx ──► website :3000 ─┐
                         ├─► admin   :3001 ─┼──► API 127.0.0.1:4330 ──► PostgreSQL (live database)
                         ├─► panel   :3002 ─┘          ▲
 Stripe / email / app ──► be.<domain> (webhooks, /app, /files/raw, /health only)      worker (jobs, outbox)
```

## What the server needs (once)
- Node **20.6 or newer** (`node -v`), npm, git, pm2 (`npm i -g pm2`), nginx, `postgresql-client` (for backups).
- The live database: `membership` on the server's PostgreSQL (memory/database-environments.md › live).
- The membership folder checked out with **BE and admin** side by side (the API reads the shared contracts in `admin/src/lib`).

## 1. Settings – `BE/.env.production` (on the server only)
```bash
cd membership/BE
cp .env.production.example .env.production
nano .env.production            # replace every CHANGE; secrets: openssl rand -hex 32
npm ci --omit=dev
npm run check:production -- --env=production
```
`check:production` lists what is wrong (✗ = must fix, ! = note) and never prints a value. The API and the worker run
the same check when they start and **refuse to start** in production while any ✗ is left – for example a development
switch (`AUTH_DEV_CODES`, `AUTH_DEV_FIXED_CODE`, `AUTH_DEV_NO_LIMITS`, `LOCALHOST_ORG`, `AUTH_DEV_HEADER`, …), a short
secret, insecure cookies or fake payments. A staging server without card payments sets `ALLOW_FAKE_PAYMENTS=1`.

Never copy a PC's `BE/.env` to the server – it holds the development switches.

## 2. The apps talk to the API
In `web/.env.production`, `admin/.env.production` and `saas/.env.production` (then rebuild each app):
```
ISGH_USE_MOCK_API=false
ISGH_API_URL=http://127.0.0.1:4330
MS_EDGE_KEY=<the same value as EDGE_KEY in BE/.env.production>
ISGH_API_TIMEOUT_MS=15000
```
The admin and the panel keep their own cookie names only on a PC (`ADMIN_SESSION_COOKIE`, `PANEL_SESSION_COOKIE`) –
on the server every app has its own address, so leave them out.

## 3. First start
```bash
cd membership
sh BE/deploy/deploy.sh
```
`deploy.sh` does, in order, and stops at the first problem: pull → `npm ci --omit=dev` → settings check → database
connection → **backup** (`pg_dump` into `membership/backups`, newest 14 kept) → migrations → `pm2` start/reload
(`BE/deploy/ecosystem.config.cjs`: `membership-api` + `membership-worker`) → waits for `/health`.

First time only, after that: the organizations and starter content – `BE_ENV=production npm run seed` (adds ISGH and
its documents; the demo members are skipped once real members exist), then the real members:
`BE_ENV=production node --import tsx --import ./src/load-env.ts src/db/import-wildapricot.ts <export.xml> --dry-run`
(then without `--dry-run`). Keep the export file off the server afterwards.

`pm2 startup` once makes pm2 (and both processes) come back after a server restart.

## 4. nginx for the public API addresses
```bash
sudo cp BE/deploy/nginx-be.conf /etc/nginx/sites-available/be.nextgrow.pro
sudo ln -sfn ../sites-available/be.nextgrow.pro /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
Add DNS `be.<domain>` (the wildcard already covers it). Webhook addresses for the providers:
`https://be.<domain>/webhooks/pay/stripe`, `/webhooks/email`, `/webhooks/sms`.

## 5. Every update
```bash
cd membership && sh BE/deploy/deploy.sh
```
Zero data loss on restart: the API finishes open requests (up to 10 s) and the worker finishes its running batch
before stopping.

## Checking on it
| What | How |
|---|---|
| Is it up? | `curl http://127.0.0.1:4330/health` (503 = the database is not reachable) |
| Logs | `pm2 logs membership-api` · `pm2 logs membership-worker` (files in `membership/logs`) |
| Restart | `pm2 reload membership-api` |
| Roll back | `git -C BE checkout <previous commit> && sh BE/deploy/deploy.sh` (migrations only add; restore a backup with `pg_restore -d membership --clean <file>.dump` if one must be undone) |

## Docker instead of pm2
`BE/deploy/docker-compose.prod.yml` runs the same two processes (host network, files in `/srv/membership-files`):
```bash
docker compose -f BE/deploy/docker-compose.prod.yml build
docker compose -f BE/deploy/docker-compose.prod.yml run --rm api node --import tsx src/production.ts
docker compose -f BE/deploy/docker-compose.prod.yml run --rm api node --import tsx src/db/migrate.ts
docker compose -f BE/deploy/docker-compose.prod.yml up -d
```

## Before real members use it
- **Port 5432 closed** to the internet (only this server / an SSH tunnel), and `DATABASE_SSL=require` if the database
  is on another machine.
- A **separate API login** instead of the owner: `CREATE ROLE membership_api LOGIN PASSWORD '…' IN ROLE app_api, app_platform;`
  then DATABASE_URL uses it; migrations and backups keep the owner (`MIGRATE` by hand with the owner's address).
- Real **email** provider (sign-in codes are emails) and **Stripe** live keys; `PLATFORM_OWNER_EMAIL` set.
- Files: `FILES_DIR` on a disk that is backed up, or `FILES_STORAGE=s3`.
- Backups also off the server (copy `membership/backups` to object storage nightly).
