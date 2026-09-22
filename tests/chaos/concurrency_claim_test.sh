#!/usr/bin/env bash
# ============================================================================
# tests/chaos/concurrency_claim_test.sh — §21 formal claim concurrency test
# WORKERS parallel SQL sessions race to claim ROWS queued rows via
# claim_outbox_batch (FOR UPDATE SKIP LOCKED), each holding its claim open.
#
# EXPECTED: total claimed == ROWS, every row claimed exactly once, all
# sessions finish in ~hold-time (non-blocking), per-worker ≤ batch limit.
# ============================================================================
set -uo pipefail
DB="${TEST_DB:-gr_v2_it}"
WORKERS="${WORKERS:-20}"
ROWS="${ROWS:-100}"
HOLD="${HOLD:-1.5}"
WORK=$(mktemp -d /tmp/claimtest.XXXXXX)
chmod 755 "$WORK"

run_sql_file() { su postgres -c "psql -d $DB -tA -q -v ON_ERROR_STOP=1 -f $1"; }

cat > "$WORK/seed.sql" <<SQL
delete from public.email_outbox where logical_event_id like 'CHAOS_CLAIM:%';
insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state, priority, next_attempt_at)
select 'CHAOS_CLAIM:'||g, 'booking_confirmation', 1, 'claim'||g||'@itest.local',
       '{"booking_id":"cccccccc-9999-2222-0000-000000000001"}', 'QUEUED', 5, now() - interval '1 minute'
from generate_series(1,$ROWS) g;
SQL
chmod 644 "$WORK/seed.sql"
echo "== seeding $ROWS queued rows =="
run_sql_file "$WORK/seed.sql" >/dev/null

echo "== launching $WORKERS concurrent claimers (each holds claims for ${HOLD}s) =="
for i in $(seq 1 "$WORKERS"); do
  cat > "$WORK/w$i.sql" <<SQL
begin;
select 'W$i='||count(*) from claim_outbox_batch(10, 'chaos-w$i');
select pg_sleep($HOLD);
commit;
SQL
  chmod 644 "$WORK/w$i.sql"
  run_sql_file "$WORK/w$i.sql" > "$WORK/w$i.out" 2>&1 &
done
START_NS=$(date +%s%N)
wait
END_NS=$(date +%s%N)
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))

TOTAL=0
for f in "$WORK"/w*.out; do
  line=$(grep -E "^W[0-9]+=" "$f" | head -1)
  [ -z "$line" ] && { echo "worker $(basename "$f") produced no count:"; head -2 "$f"; continue; }
  n="${line#*=}"
  TOTAL=$((TOTAL + n))
done
echo "per-worker: $(cat "$WORK"/w*.out | grep -E '^W[0-9]+=' | sort -t= -k2 -rn | tr '\n' ' ')"
echo "TOTAL claimed: $TOTAL / $ROWS   (wall ${ELAPSED_MS}ms across $WORKERS parallel sessions)"

cat > "$WORK/verify.sql" <<'SQL'
select 'CLAIMED_ROWS='||count(*) from email_outbox where logical_event_id like 'CHAOS_CLAIM:%' and state='CLAIMED';
select 'DISTINCT_WORKERS='||count(distinct locked_by) from email_outbox where logical_event_id like 'CHAOS_CLAIM:%' and state='CLAIMED';
select 'MAX_PER_WORKER='||coalesce(max(c),0) from (select count(*) c from email_outbox where logical_event_id like 'CHAOS_CLAIM:%' and state='CLAIMED' group by locked_by) x;
select 'ATTEMPT_CONSUMED='||count(*) from email_outbox where logical_event_id like 'CHAOS_CLAIM:%' and attempts > 0;
SQL
chmod 644 "$WORK/verify.sql"
mapfile -t V < <(run_sql_file "$WORK/verify.sql")
CLAIMED_ROWS=$(echo "${V[0]}" | cut -d= -f2)
DISTINCT_WORKERS=$(echo "${V[1]}" | cut -d= -f2)
MAX_PER_WORKER=$(echo "${V[2]}" | cut -d= -f2)
ATTEMPT_CONSUMED=$(echo "${V[3]}" | cut -d= -f2)

FAIL=0
[ "$TOTAL" = "$ROWS" ]                || { echo "FAIL: total claimed $TOTAL != $ROWS (double-claim or lost row)"; FAIL=1; }
[ "$CLAIMED_ROWS" = "$ROWS" ]         || { echo "FAIL: db shows $CLAIMED_ROWS claimed != $ROWS"; FAIL=1; }
[ "$MAX_PER_WORKER" -le 10 ]          || { echo "FAIL: worker holds $MAX_PER_WORKER > batch limit 10"; FAIL=1; }
[ "$DISTINCT_WORKERS" -ge 2 ]         || { echo "FAIL: only $DISTINCT_WORKERS worker(s) participated — test not exercising concurrency"; FAIL=1; }
[ "$ATTEMPT_CONSUMED" = "0" ]         || { echo "FAIL: claim consumed $ATTEMPT_CONSUMED attempts (claims must be free)"; FAIL=1; }
[ "$ELAPSED_MS" -lt 8000 ]            || { echo "FAIL: ${ELAPSED_MS}ms wall time suggests lock queueing (blocking)"; FAIL=1; }

echo "workers participated: $DISTINCT_WORKERS; max rows/worker: $MAX_PER_WORKER; attempts consumed by claim: $ATTEMPT_CONSUMED"

cat > "$WORK/cleanup.sql" <<'SQL'
delete from public.email_outbox where logical_event_id like 'CHAOS_CLAIM:%';
SQL
chmod 644 "$WORK/cleanup.sql"
run_sql_file "$WORK/cleanup.sql" >/dev/null
rm -rf "$WORK"

if [ "$FAIL" = "0" ]; then
  echo "CONCURRENCY CLAIM TEST PASSED ($WORKERS workers, $ROWS rows, disjoint claims, non-blocking, free claims)"
  exit 0
else
  echo "CONCURRENCY CLAIM TEST FAILED"
  exit 1
fi
