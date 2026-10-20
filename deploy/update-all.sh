#!/bin/sh
# Update the dev server in one go: pull every app, install, migrate, build, restart, check.
#   members-update            (after the one-time setup below)
#   sh /opt/members/BE/deploy/update-all.sh [--force]
#   --force   rebuild and restart every app even when git has no new commits
# One-time setup (adds the short command):  sh /opt/members/BE/deploy/update-all.sh --install
set -e
ROOT=${ROOT:-/opt/members}
SELF="$ROOT/BE/deploy/update-all.sh"

if [ "$1" = "--install" ]; then
  grep -q "alias members-update=" ~/.bashrc 2>/dev/null || echo "alias members-update='sh $SELF'" >> ~/.bashrc
  echo "Done. Open a new terminal (or run: . ~/.bashrc), then type: members-update"; exit 0
fi
# git pull below may change this very file – run from a copy so the update is never cut in half
if [ -z "$UPDATE_ALL_COPY" ]; then cp "$SELF" /tmp/members-update.sh; UPDATE_ALL_COPY=1 exec sh /tmp/members-update.sh "$@"; fi
FORCE=0; [ "$1" = "--force" ] && FORCE=1

step() { printf '\n== %s\n' "$1"; }
pull() {   # pull one repo; returns 0 when something new came in (or --force)
  cd "$ROOT/$1"
  for l in .git/index.lock .git/HEAD.lock; do [ -e "$l" ] && rm -f "$l"; done   # stale locks from an interrupted git
  before=$(git rev-parse HEAD); git pull -q --ff-only
  after=$(git rev-parse HEAD)
  if [ "$before" != "$after" ]; then git --no-pager log --oneline "$before..$after" | sed 's/^/   + /'; return 0; fi
  [ "$FORCE" = 1 ] && { echo "   no new commits – rebuilding anyway (--force)"; return 0; }
  echo "   no new commits"; return 1
}

step "API (BE)"
if pull BE; then
  npm ci --omit=dev --no-audit --no-fund -s
  npm run -s migrate
  pm2 restart membership-api membership-worker --update-env >/dev/null 2>&1 || pm2 start deploy/ecosystem.config.cjs >/dev/null
  echo "   restarted membership-api + membership-worker"
fi

for app in web:isgh-web admin:isgh-admin saas:isgh-saas; do
  dir=${app%%:*}; name=${app##*:}
  [ -d "$ROOT/$dir" ] || continue
  step "$dir"
  if pull "$dir"; then
    npm ci --no-audit --no-fund -s
    if npm run -s build; then
      pm2 restart "$name" >/dev/null 2>&1 || pm2 start npm --name "$name" -- start >/dev/null
      echo "   built and restarted $name"
    else
      echo "!! $dir build FAILED – the old version keeps running. Send the error above to fix it."; FAILED=1
    fi
  fi
done

step "check"
for name in membership-api membership-worker isgh-web isgh-admin isgh-saas; do
  if pm2 describe "$name" 2>/dev/null | grep -q "status.*online"; then echo "   ok  $name"; else echo "!!    $name is not online – see: pm2 logs $name --lines 30 --nostream"; FAILED=1; fi
done
pm2 save >/dev/null
if curl -fsS http://127.0.0.1:4330/health >/dev/null; then echo "   ok  API health"; else echo "!!    API health check failed"; FAILED=1; fi
[ -z "$FAILED" ] && printf '\nAll done.\n' || { printf '\nFinished with problems (see !! above).\n'; exit 1; }
