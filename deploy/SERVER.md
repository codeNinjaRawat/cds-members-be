# Deploy the API at https://be.nextgrow.pro (server 3.18.46.122)

First setup on the DEV database. The full reference (live database, BE/.env.production, Docker, go-live list): deploy/README.md.

Same server as the website/admin/SaaS panel (DEPLOY.md). The API listens on **127.0.0.1:4330**; nginx exposes it as
`be.nextgrow.pro`. Start with the **DEV database** (`membership_dev`); move to `membership` (live) when the office goes live.

## 1. Code on the server (first time)
```bash
sudo mkdir -p /srv/membership && sudo chown $USER /srv/membership
# from your PC (PowerShell), copy the two folders the API needs – BE and admin/src/lib (shared contracts):
#   scp -r C:\Users\HP\musk2\membership\BE          ubuntu@3.18.46.122:/srv/membership/
#   scp -r C:\Users\HP\musk2\membership\admin\src\lib ubuntu@3.18.46.122:/srv/membership/admin/src/
# (or git clone / git pull once the repo has a remote)
cd /srv/membership/BE && npm ci --omit=dev          # tsx is a normal dependency now
mkdir -p /srv/membership/admin/node_modules && ln -sfn /srv/membership/BE/node_modules/zod /srv/membership/admin/node_modules/zod
```
Node 22 (`node -v`), pm2 (`npm i -g pm2`), nginx and the wildcard certificate are already on the server.

## 2. Settings – /srv/membership/BE/.env (never in git)
```bash
cp .env.example .env && nano .env
```
Set at least:
```
DATABASE_URL=postgresql://membership_dev_owner:YOUR_DEV_PASSWORD@127.0.0.1:5432/membership_dev
DATABASE_SSL=disable                     # same machine
PORT=4330
BASE_DOMAIN=nextgrow.pro
TENANT_FROM_HOST=1
DEFAULT_ORG=isgh
TRUST_PROXY=1
COOKIE_SECURE=1
PUBLIC_API_URL=https://be.nextgrow.pro
ALLOWED_ORIGINS=https://member-web.nextgrow.pro,https://member-admin.nextgrow.pro,https://saas.nextgrow.pro
EDGE_KEY=<openssl rand -hex 32>          # same value goes into web/admin/saas as MS_EDGE_KEY
AUTH_PEPPER=<openssl rand -hex 32>       # choose once, never change
PLATFORM_OWNER_EMAIL=<your email>
EMAIL_PROVIDER=log                        # until Postmark/SendGrid/Resend is chosen: codes are written to the pm2 log
SMS_PROVIDER=log
PAYMENTS_PROVIDER=fake                    # until Stripe keys exist
ALLOW_FAKE_PAYMENTS=1                     # staging only – the API refuses fake payments in production otherwise
NODE_ENV=production
HOST=127.0.0.1
MAIL_LOG=1                                # with EMAIL_PROVIDER=log: each email's subject (with the sign-in code) goes to the pm2 log
FILES_STORAGE=local
FILES_DIR=/srv/membership/files
```
`mkdir -p /srv/membership/files`.

## 3. Database
```bash
cd /srv/membership/BE
npm run check:production  # every setting the server needs (✗ = must fix); the API refuses to start otherwise
npm run db:check          # reachable, roles, extensions – fix anything it lists
npm run migrate           # sql/*.sql once each (safe to re-run)
npm run seed              # ISGH starter documents + demo members
npm run seed:isgh         # ISGH's real zones and masjids (needs psql on the server)
```

## 4. Start
```bash
cd /srv/membership && pm2 start BE/deploy/ecosystem.config.cjs && pm2 save
pm2 logs membership-api --lines 50       # expect: listening on 4330, database ok
curl -s http://127.0.0.1:4330/health      # {"ok":true,...}
```

## 5. nginx + HTTPS
```bash
sudo cp /srv/membership/BE/deploy/nginx-be.conf /etc/nginx/sites-available/be.nextgrow.pro
sudo ln -sfn /etc/nginx/sites-available/be.nextgrow.pro /etc/nginx/sites-enabled/be.nextgrow.pro
sudo nginx -t && sudo systemctl reload nginx
curl -s https://be.nextgrow.pro/health
```
DNS: `*.nextgrow.pro` already points at the server, so `be.nextgrow.pro` needs no new record (an explicit A record is fine too).

## 6. Point the apps at it
- Website / admin / SaaS panel on the same server: in each app's `.env.production` set `ISGH_USE_MOCK_API=false`,
  `ISGH_API_URL=http://127.0.0.1:4330`, `MS_EDGE_KEY=<the EDGE_KEY>` → rebuild (`npm run build`) → `pm2 restart isgh-web isgh-admin isgh-saas`.
- Member app: `APP_API_URL=https://be.nextgrow.pro APP_MODE=live eas build …` (the default API address is now be.nextgrow.pro;
  demo mode ignores it). Sign-in codes appear in `pm2 logs membership-api` while EMAIL_PROVIDER=log.

## 7. Each update
```bash
# copy/pull the new BE folder, then:
cd /srv/membership && sh BE/deploy/deploy.sh      # pull, install, settings check, backup, migrate, reload, health
```

## Checks
`curl https://be.nextgrow.pro/health` · `curl -H "x-org: isgh" https://be.nextgrow.pro/app/bootstrap` (the app's first call) ·
`pm2 status` · `pm2 logs membership-worker`.
Before real members: close port 5432 to the internet, give the API its own DB login, switch EMAIL/SMS/PAYMENTS providers, back up the database nightly.
