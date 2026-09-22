#!/usr/bin/env bash
# ============================================================================
# tests/run_db_tests.sh — database layer verification
#   1. provisions TEST_DB (stubs + migrations 000/001) if missing
#   2. runs the 22-test v2 SQL suite (idempotent, re-runnable)
#   3. NEGATIVE test (§25): incompatible column type must FAIL LOUDLY
#   4. POSITIVE test (§25): text columns with garbage data must degrade to
#      NULL via regex-guarded casts — never a runtime explosion
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
DB="${TEST_DB:-gr_v2_fresh}"
FAIL=0

run() { su postgres -c "psql -d $1 -q -v ON_ERROR_STOP=1 -f $2" > "$3" 2>&1; }

echo "== [1/4] provisioning $DB =="
EXISTS=$(su postgres -c "psql -tAc \"select count(*) from pg_database where datname='$DB'\"" | tr -d '[:space:]')
if [ "$EXISTS" != "1" ]; then su postgres -c "createdb $DB"; fi
HAS=$(su postgres -c "psql -d $DB -tAc \"select count(*) from pg_class where relname='email_outbox'\"" 2>/dev/null | tr -d '[:space:]')
MIGS="scripts/test_harness_stubs.sql supabase/migrations/000_email_system_init.sql supabase/migrations/001_email_system_v2.sql supabase/migrations/002_business_defaults_and_producers.sql"
if [ "$HAS" != "1" ]; then
  for f in $MIGS; do run "$DB" "$f" "/tmp/dbt_$(basename "$f").log" || { echo "FAILED: $f"; grep ERROR "/tmp/dbt_$(basename "$f").log" | head -3; exit 1; }; done
  echo "   provisioned (stubs + 000 + 001 + 002)."
else
  # keep schema current (migrations are idempotent)
  for f in $MIGS; do run "$DB" "$f" "/tmp/dbt_$(basename "$f").log" || { echo "RE-APPLY FAILED: $f"; grep ERROR "/tmp/dbt_$(basename "$f").log" | head -3; exit 1; }; done
  echo "   existing DB re-migrated (idempotent)."
fi

echo "== [2/4] v2 SQL suite (22 tests) =="
su postgres -c "psql -d $DB -q -v ON_ERROR_STOP=1 -f tests/db/v2_sql_tests.sql" > /tmp/dbt_suite.log 2>&1
if [ $? -eq 0 ]; then
  echo "   PASSED ($(grep -c 'PASS' /tmp/dbt_suite.log) assertions)"
else
  echo "   FAILED:"; grep -E 'ERROR|ASSERT' /tmp/dbt_suite.log | head -5; FAIL=1
fi

echo "== [3/4] NEGATIVE: incompatible column type must fail loudly =="
su postgres -c "dropdb --if-exists gr_badtype && createdb gr_badtype"
run gr_badtype scripts/test_harness_stubs.sql /tmp/bt_stubs.log
su postgres -c "psql -d gr_badtype -q" > /dev/null 2>&1 <<'SQL'
create table profiles (id uuid primary key, email text, full_name text);
create table listings (id uuid primary key, owner_id uuid, title text);
create table bookings (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references listings(id),
  renter_id uuid,
  status boolean default false,          -- WRONG TYPE for a status column
  start_date timestamptz, end_date timestamptz,
  total_amount numeric(12,2), created_at timestamptz default now()
);
SQL
run gr_badtype supabase/migrations/000_email_system_init.sql /tmp/bt_000.log
BT_OUT=$(su postgres -c "psql -d gr_badtype -v ON_ERROR_STOP=1 -f $(pwd)/supabase/migrations/001_email_system_v2.sql" 2>&1)
if echo "$BT_OUT" | grep -q "SCHEMA MAPPING"; then
  echo "   PASSED — 001 rejected boolean status with a clear SCHEMA MAPPING error:"
  echo "$BT_OUT" | grep "SCHEMA MAPPING" | head -1 | sed 's/^/     /'
else
  echo "   FAILED — expected a loud SCHEMA MAPPING error; got:"; echo "$BT_OUT" | tail -3 | sed 's/^/     /'; FAIL=1
fi

echo "== [4/4] POSITIVE: garbage text data degrades to NULL (regex-guarded casts) =="
su postgres -c "dropdb --if-exists gr_textsafe && createdb gr_textsafe"
run gr_textsafe scripts/test_harness_stubs.sql /tmp/ts_stubs.log
su postgres -c "psql -d gr_textsafe -q" > /dev/null 2>&1 <<'SQL'
create table profiles (id uuid primary key, email text, full_name text);
create table listings (id uuid primary key, owner_id uuid, title text);
create table bookings (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid, renter_id uuid,
  status text default 'pending',
  start_date text,                        -- text dates (guarded cast)
  end_date text,
  total_amount text,                      -- text amounts (guarded cast)
  created_at timestamptz default now()
);
insert into auth.users (id,email) values ('abababab-0000-0000-0000-000000000001','good@example.com'),('abababab-0000-0000-0000-000000000002','bad@example.com');
insert into listings (id, owner_id, title) values ('cbcbcbcb-0000-0000-0000-000000000001','abababab-0000-0000-0000-000000000001','L');
insert into bookings (id, listing_id, renter_id, status, start_date, end_date, total_amount) values
 ('dbdbdbdb-0000-0000-0000-000000000001','cbcbcbcb-0000-0000-0000-000000000001','abababab-0000-0000-0000-000000000001','confirmed','2026-10-01T10:00:00Z','2026-10-05T10:00:00Z','123.45'),
 ('dbdbdbdb-0000-0000-0000-000000000002','cbcbcbcb-0000-0000-0000-000000000001','abababab-0000-0000-0000-000000000002','confirmed','not-a-date','also-bad','abc');
SQL
run gr_textsafe supabase/migrations/000_email_system_init.sql /tmp/ts_000.log
run gr_textsafe supabase/migrations/001_email_system_v2.sql /tmp/ts_001.log || { echo "   FAILED — 001 should accept guarded text columns"; grep ERROR /tmp/ts_001.log | head -2; FAIL=1; }
run gr_textsafe supabase/migrations/002_business_defaults_and_producers.sql /tmp/ts_002.log || { echo "   FAILED — 002 should accept guarded text columns"; grep ERROR /tmp/ts_002.log | head -2; FAIL=1; }
if [ "$FAIL" = "0" ] || [ -s /tmp/ts_001.log ]; then
  OUT=$(su postgres -c "psql -d gr_textsafe -tA -c \"select starts_at is not null as good_parsed, amount is not null from email_bookings_ctx where booking_id='dbdbdbdb-0000-0000-0000-000000000001'\" -c \"select starts_at is null as bad_nulled, amount is null from email_bookings_ctx where booking_id='dbdbdbdb-0000-0000-0000-000000000002'\"" 2>&1)
  if echo "$OUT" | grep -q "^t|t$" && echo "$OUT" | grep -q "^t|t$"; then
    echo "   PASSED — valid text parsed; garbage → NULL; view never explodes"
  else
    # both queries return t|t; count occurrences
    N=$(echo "$OUT" | grep -c "^t|t")
    if [ "$N" = "2" ]; then echo "   PASSED — valid text parsed; garbage → NULL; view never explodes";
    else echo "   FAILED — unexpected ctx output: $OUT"; FAIL=1; fi
  fi
fi

echo
if [ "$FAIL" = "0" ]; then echo "DB TESTS: ALL PASSED"; else echo "DB TESTS: FAILURES PRESENT"; fi
exit $FAIL
