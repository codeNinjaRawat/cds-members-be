#!/bin/sh
# One command for the dev server: pull every app, migrate, build only what changed, restart, check.
#   sh /opt/members/BE/deploy/update-all.sh
set -e
ROOT=${ROOT:-/opt/members}
changed() { cd "$ROOT/$1"; before=$(git rev-parse HEAD); git pull -q; [ "$before" != "$(git rev-parse HEAD)" ]; }

echo "== API"; if changed BE; then npm ci --omit=dev -s; npm run -s migrate; pm2 restart membership-api membership-worker --update-env >/dev/null; echo "   updated"; else echo "   no change"; fi
for app in web:isgh-web admin:isgh-admin saas:isgh-saas; do
  dir=${app%%:*}; name=${app##*:}
  [ -d "$ROOT/$dir" ] || continue
  echo "== $dir"; if changed "$dir"; then npm ci -s && npm run -s build && pm2 restart "$name" >/dev/null && echo "   updated"; else echo "   no change"; fi
done
# anything not running is started again
for name in membership-api membership-worker isgh-web isgh-admin isgh-saas; do
  pm2 describe "$name" >/dev/null 2>&1 && pm2 describe "$name" | grep -q "status.*online" || echo "!! $name is not online – check: pm2 logs $name --lines 30"
done
pm2 save >/dev/null
curl -fsS http://127.0.0.1:4330/health >/dev/null && echo "== all done – API healthy" || echo "!! API health check failed"
