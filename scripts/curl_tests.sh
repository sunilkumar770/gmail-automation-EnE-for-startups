#!/usr/bin/env bash
# ============================================================================
# GoRentals email system v2 — post-deploy verification suite (curl + psql)
# ----------------------------------------------------------------------------
# Usage:
#   export PROJECT_REF=abcdefghijklm            # Supabase project ref
#   export EMAIL_INTERNAL_SECRET=<vault value>  # same value as edge secret
#   export TEST_TO=you@yourdomain.com           # a REAL inbox you control
#   export DB_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'  # optional: SQL checks
#   export APP_WEBHOOK_URL=http://localhost:3000/api/resend-webhook   # optional (npm run dev)
#   export APP_BASE_URL=http://localhost:3000                          # optional (unsubscribe checks)
#   export RESEND_WEBHOOK_SECRET=whsec_...                             # optional
#   bash scripts/curl_tests.sh
# ============================================================================
set -uo pipefail

SUPABASE_URL="${SUPABASE_URL:-https://${PROJECT_REF:?set PROJECT_REF (or SUPABASE_URL)}.supabase.co}"
FN="$SUPABASE_URL/functions/v1/notify-lifecycle"
SECRET="${EMAIL_INTERNAL_SECRET:?set EMAIL_INTERNAL_SECRET (the Vault value)}"
PASS=0; FAIL=0

hr() { printf '%s\n' "------------------------------------------------------------"; }
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1 (HTTP $3)";
          else FAIL=$((FAIL+1)); echo "FAIL  $1 — expected HTTP $2, got $3"; fi; }
post_fn() { curl -sS -o /tmp/gr_curl_body -w '%{http_code}' -X POST "$FN" \
  -H 'content-type: application/json' -H "x-internal-secret: $1" -d "$2"; }

hr; echo "1. Liveness (public GET, no secret)"
code=$(curl -sS -o /tmp/gr_curl_body -w '%{http_code}' "$FN")
check "GET liveness" 200 "$code"; cat /tmp/gr_curl_body; echo

hr; echo "2. Invalid secret must be rejected (SECURITY)"
code=$(post_fn "definitely-the-wrong-secret" '{"action":"HEALTHCHECK"}')
check "wrong secret → 401" 401 "$code"; cat /tmp/gr_curl_body; echo

hr; echo "3. Missing secret must be rejected (SECURITY)"
code=$(curl -sS -o /tmp/gr_curl_body -w '%{http_code}' -X POST "$FN" -H 'content-type: application/json' -d '{"action":"DRAIN_QUEUE"}')
check "no secret → 401" 401 "$code"; cat /tmp/gr_curl_body; echo

hr; echo "4. HEALTHCHECK v2 (outbox states, caps, inbox backlog, lease)"
code=$(post_fn "$SECRET" '{"action":"HEALTHCHECK"}')
check "HEALTHCHECK → 200" 200 "$code"; cat /tmp/gr_curl_body; echo

hr; echo "5. Fake booking lifecycle via SQL (requires DB_URL)"
if [ -n "${DB_URL:-}" ]; then
  psql "$DB_URL" -q <<'SQL'
insert into auth.users (id, email) values ('99999999-0000-0000-0000-000000000001','curl.renter@example.com') on conflict (id) do nothing;
insert into public.profiles (id, email, full_name) values ('99999999-0000-0000-0000-000000000001','curl.renter@example.com','Curl Renter') on conflict (id) do nothing;
insert into public.listings (id, title) values ('99999999-1111-0000-0000-000000000001','Test Listing (curl)') on conflict (id) do nothing;
insert into public.bookings (id, listing_id, renter_id, status, start_date, end_date, total_amount)
values ('99999999-2222-0000-0000-000000000001','99999999-1111-0000-0000-000000000001',
        '99999999-0000-0000-0000-000000000001','confirmed',
        now()+interval '2 days', now()+interval '4 days', 199.00)
on conflict (id) do update set status='confirmed';
SQL
  n=$(psql "$DB_URL" -tA -c "select count(*) from public.email_outbox where payload->>'booking_id'='99999999-2222-0000-0000-000000000001' and template_key in ('booking_confirmation','booking_host_confirmation')")
  if [ "${n:-0}" -ge 1 ]; then PASS=$((PASS+1)); echo "PASS  trigger wrote durable outbox intent ($n row(s))"
  else FAIL=$((FAIL+1)); echo "FAIL  no outbox rows — check triggers / enqueue_source / reconciliation NOTICEs"; fi
else echo "SKIP  DB_URL not set"; fi

hr; echo "6. DRAIN_QUEUE (watch the stats JSON: sent/retry_wait/unknown/dead)"
code=$(post_fn "$SECRET" '{"action":"DRAIN_QUEUE"}')
check "DRAIN_QUEUE → 200" 200 "$code"; cat /tmp/gr_curl_body; echo

hr; echo "7. TRACE the fake booking's confirmation (requires DB_URL)"
if [ -n "${DB_URL:-}" ]; then
  code=$(post_fn "$SECRET" '{"action":"TRACE","logical_event_id":"BOOKING_CONFIRMATION:99999999-2222-0000-0000-000000000001"}')
  check "TRACE → 200" 200 "$code"; head -c 600 /tmp/gr_curl_body; echo
else echo "SKIP  DB_URL not set"; fi

hr; echo "8. TEST_SEND to a real inbox (verifies Resend domain + from address)"
if [ -n "${TEST_TO:-}" ]; then
  code=$(post_fn "$SECRET" "{\"action\":\"TEST_SEND\",\"to\":\"$TEST_TO\",\"template\":\"booking_confirmation\"}")
  check "TEST_SEND → 200" 200 "$code"; cat /tmp/gr_curl_body; echo
  echo ">>> Check $TEST_TO inbox AND spam; Resend dashboard should show Delivered."
else echo "SKIP  TEST_TO not set"; fi

hr; echo "9. Resend webhook signature simulation (local Next.js dev server)"
if [ -n "${APP_WEBHOOK_URL:-}" ] && [ -n "${RESEND_WEBHOOK_SECRET:-}" ]; then
  node "$(dirname "$0")/sign_webhook_test.mjs" --secret "$RESEND_WEBHOOK_SECRET" --type email.bounced --url "$APP_WEBHOOK_URL"
  echo ">>> Expect {received:true, ...}; then a suppression row:"
  [ -n "${DB_URL:-}" ] && psql "$DB_URL" -c "select email, source, reason from public.email_suppressions where email='bounced.victim@example.com' and removed_at is null"
else echo "SKIP  needs APP_WEBHOOK_URL + RESEND_WEBHOOK_SECRET (npm i first)"; fi

hr; echo "10. Unsubscribe endpoint round-trip (requires DB_URL + APP_BASE_URL)"
if [ -n "${DB_URL:-}" ] && [ -n "${APP_BASE_URL:-}" ]; then
  TOK=$(psql "$DB_URL" -tA -c "select public.email_unsub_token('curl.unsub@example.com','marketing')")
  code=$(curl -sS -o /tmp/gr_curl_body -w '%{http_code}' "$APP_BASE_URL/api/unsubscribe?t=$TOK")
  check "GET unsubscribe (valid token) → 200" 200 "$code"
  code=$(curl -sS -o /tmp/gr_curl_body -w '%{http_code}' -X POST "$APP_BASE_URL/api/unsubscribe?t=$TOK" -d 'List-Unsubscribe=One-Click')
  check "POST one-click → 200" 200 "$code"
  s=$(psql "$DB_URL" -tA -c "select source from public.email_suppressions where email='curl.unsub@example.com' and removed_at is null")
  if [ "$s" = "user" ]; then PASS=$((PASS+1)); echo "PASS  suppression source=user (provider removals can't clear it)"
  else FAIL=$((FAIL+1)); echo "FAIL  expected source=user, got '$s'"; fi
  code=$(curl -sS -o /tmp/gr_curl_body -w '%{http_code}' "$APP_BASE_URL/api/unsubscribe?t=v1.forged.signature")
  check "GET forged token → 400" 400 "$code"
else echo "SKIP  needs DB_URL + APP_BASE_URL"; fi

hr; echo "11. Scheduled scans + event processor fire safely (idempotent)"
code=$(post_fn "$SECRET" '{"action":"SCAN_REMINDERS"}'); check "SCAN_REMINDERS → 200" 200 "$code"; cat /tmp/gr_curl_body; echo
code=$(post_fn "$SECRET" '{"action":"SCAN_REVIEWS"}');   check "SCAN_REVIEWS → 200" 200 "$code"; cat /tmp/gr_curl_body; echo
code=$(post_fn "$SECRET" '{"action":"PROCESS_EVENTS","limit":100}'); check "PROCESS_EVENTS → 200" 200 "$code"; cat /tmp/gr_curl_body; echo

hr; echo "12. pg_cron health (requires DB_URL): 7 jobs, recent runs succeeded"
if [ -n "${DB_URL:-}" ]; then
  psql "$DB_URL" -c "select jobname, schedule, active from cron.job where jobname like 'gorentals-email-%' order by jobname"
  psql "$DB_URL" -c "select j.jobname, r.status, left(coalesce(r.return_message,''),60) as msg, r.start_time from cron.job_run_details r join cron.job j on j.jobid=r.jobid where j.jobname like 'gorentals-email-%' order by r.start_time desc limit 8"
  leak=$(psql "$DB_URL" -tA -c "select count(*) from cron.job where command like '%${SECRET}%'")
  if [ "$leak" = "0" ]; then PASS=$((PASS+1)); echo "PASS  no secret literals in cron.job (Vault-only)"
  else FAIL=$((FAIL+1)); echo "FAIL  SECRET FOUND IN cron.job — rotate immediately"; fi
else echo "SKIP  DB_URL not set"; fi

hr; echo "13. Dead-letter review + safe replay example (requires DB_URL)"
if [ -n "${DB_URL:-}" ]; then
  psql "$DB_URL" -c "select o.logical_event_id, o.template_key||'@'||o.template_version as tpl, o.recipient, o.attempts, o.last_error, o.first_failed_at from public.email_outbox o where o.state='DEAD' order by o.updated_at desc limit 5"
  echo ">>> Replay a dead letter (audit preserved, attempts reset):"
  echo "    curl -sS -X POST '$FN' -H 'x-internal-secret: \$SECRET' -H 'content-type: application/json' -d '{\"action\":\"REPLAY\",\"outbox_id\":\"<uuid>\",\"note\":\"ticket #123\"}'"
else echo "SKIP  DB_URL not set"; fi

hr
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
