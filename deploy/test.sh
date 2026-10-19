#!/bin/sh
# Every test against a fresh database (CI or a laptop): DATABASE_URL must point at an EMPTY database.
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/membership_test sh deploy/test.sh
set -e
cd "$(dirname "$0")/.."
npx tsx src/db/migrate.ts
npx tsx src/db/seed.ts
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -f tests/rls.sql > /dev/null && echo "tests/rls.sql ok"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -f tests/rls_all.sql > /dev/null && echo "tests/rls_all.sql ok"
# order matters a little: later suites add organizations and change members (governance last)
for t in api auth members website geo helpdesk events giving zakat comms jobs checkout files platform tenancy site documents records portal app dashboards governance; do
  npx tsx tests/$t.test.ts | tail -1
done
# the member app's own client and schemas against the API (needs ../mobile next to BE)
[ -d ../mobile/src ] && npx tsx tests/app-contracts.test.ts | tail -1
