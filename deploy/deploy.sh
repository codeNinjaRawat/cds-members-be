#!/bin/sh
# Update the BE on the server (pm2). Run ON THE SERVER from the membership folder:   sh BE/deploy/deploy.sh
# Steps: pull → install → settings check → database backup → migrations → restart → health check.
# Stops at the first problem; the running API keeps serving until the restart step.
set -eu
cd "$(dirname "$0")/.."                     # BE
ROOT=$(cd .. && pwd)
mkdir -p "$ROOT/logs" "$ROOT/backups"
log() { printf '\n== %s\n' "$*"; }

log "1/7 Latest code"
# git checkout with a remote: pull. Copied folders (scp, deploy/SERVER.md): copy the new BE and admin/src/lib first.
if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then git pull --ff-only; else echo "no git remote – using the files as copied"; fi
if [ -d ../admin/.git ] && git -C ../admin rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then git -C ../admin pull --ff-only; fi   # shared contracts in admin/src/lib

log "2/7 Install (production packages only)"
npm ci --omit=dev --no-audit --no-fund
# the shared contracts import zod from admin/ – point it at the BE's copy when the admin is not installed here
[ -e ../admin/node_modules/zod ] || { mkdir -p ../admin/node_modules && ln -sfn "$(pwd)/node_modules/zod" ../admin/node_modules/zod; }

log "3/7 Settings check"
if [ -f .env.production ]; then export BE_ENV=production; SETTINGS=.env.production; elif [ -f .env ]; then SETTINGS=.env; else echo "No BE/.env.production (or BE/.env) – copy .env.production.example and fill it in."; exit 1; fi
echo "settings: BE/$SETTINGS"
NODE_ENV=production node --import tsx --import ./src/load-env.ts src/production.ts
NODE_ENV=production node --import tsx --import ./src/load-env.ts src/db/check.ts --connect

log "4/7 Database backup"
if command -v pg_dump >/dev/null 2>&1; then
  URL=$(node --import tsx --import ./src/load-env.ts -e "process.stdout.write(process.env.DATABASE_URL||'')" 2>/dev/null)
  F="$ROOT/backups/membership-$(date +%Y%m%d-%H%M%S).dump"
  pg_dump --format=custom --no-owner --file="$F" "$URL" && echo "saved $F"
  ls -1t "$ROOT"/backups/membership-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f   # keep the newest 14
else
  echo "pg_dump not installed – no backup taken (apt install postgresql-client). Continue only if you have another backup."
fi

log "5/7 Migrations (each runs once)"
NODE_ENV=production node --import tsx --import ./src/load-env.ts src/db/migrate.ts

log "6/7 Restart the API and the worker"
if pm2 describe membership-api >/dev/null 2>&1; then pm2 reload deploy/ecosystem.config.cjs --update-env; else pm2 start deploy/ecosystem.config.cjs; fi
pm2 save

log "7/7 Health check"
PORT=$(grep -E '^PORT=' "$SETTINGS" | cut -d= -f2); PORT=${PORT:-4330}
i=0; until curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do i=$((i+1)); [ $i -ge 30 ] && { echo "API not healthy after 60 s – pm2 logs membership-api"; exit 1; }; sleep 2; done
curl -fsS "http://127.0.0.1:$PORT/health"; echo
echo "Deployed."
