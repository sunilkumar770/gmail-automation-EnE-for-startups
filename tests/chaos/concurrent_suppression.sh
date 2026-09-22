#!/usr/bin/env bash
# ============================================================================
# tests/chaos/concurrent_suppression.sh — §12.10 concurrent suppression events
# Two sessions race: provider bounce (source=resend) ∥ user unsubscribe
# (source=user) on a fresh address. Regardless of arrival order the result
# must converge to source='user' with exactly ONE active row (rank-comparing
# ON CONFLICT upsert in email_apply_suppression).
# ============================================================================
set -uo pipefail
DB="${TEST_DB:-gr_v2_it}"
ROUNDS="${ROUNDS:-20}"
FAILS=0

q() { su postgres -c "psql -d $DB -tA -q -c \"$1\"" 2>/dev/null; }

for i in $(seq 1 "$ROUNDS"); do
  EMAIL="race$i@itest.local"
  q "delete from email_suppressions where email='$EMAIL'" >/dev/null
  q "select pg_sleep(random()*0.05); select public.email_apply_suppression('$EMAIL','resend','bounce')" >/dev/null &
  q "select pg_sleep(random()*0.05); select public.email_apply_suppression('$EMAIL','user','unsubscribe')" >/dev/null &
  wait
  SRC=$(q "select source from email_suppressions where email='$EMAIL' and removed_at is null" | tr -d '[:space:]')
  N=$(q "select count(*) from email_suppressions where email='$EMAIL' and removed_at is null" | tr -d '[:space:]')
  if [ "$SRC" != "user" ] || [ "$N" != "1" ]; then
    FAILS=$((FAILS+1)); echo "round $i: source='$SRC' active_rows='$N' (expected user/1)"
  fi
  q "delete from email_suppressions where email='$EMAIL'" >/dev/null
done

if [ "$FAILS" = "0" ]; then
  echo "CONCURRENT SUPPRESSION TEST PASSED ($ROUNDS/$ROUNDS converged to source=user, single active row)"
  exit 0
else
  echo "CONCURRENT SUPPRESSION TEST FAILED ($FAILS/$ROUNDS diverged)"
  exit 1
fi
