#!/usr/bin/env bash
# ============================================================================
# tests/run_all.sh — FULL verification pipeline (this is `npm test`)
# Order: build → typecheck → lint → unit → db → integration → e2e → chaos →
#        security. Any suite failure marks the run FAILED but the pipeline
# continues so one run reports everything.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.deno/bin:$PATH"
FAILED=0

step() { echo; echo "════════ $1 ════════"; }
quiet_kill() { bash tests/kill_stale.sh >/dev/null 2>&1 || true; }

step "0/9  kill stale test processes";        quiet_kill
step "1/9  build test artifacts";              npm run build:test || FAILED=1
step "2/9  typecheck (tsc + deno check)";      bash tests/typecheck.sh || FAILED=1
step "3/9  lint (eslint)";                     npx eslint app lib supabase/functions tests scripts/sign_webhook_test.mjs || FAILED=1
step "4/9  unit tests";                        node --test tests/unit/ || FAILED=1
step "5/9  database tests (incl. §25 schema-safety)"; bash tests/run_db_tests.sh || FAILED=1
step "6/9  integration: edge worker";          quiet_kill; TEST_DB=gr_v2_it node tests/integration/edge_v2.mjs || FAILED=1
step "7/9  integration: webhook+unsubscribe routes"; quiet_kill; TEST_DB=gr_v2_it node tests/integration/routes_v2.mjs || FAILED=1
step "8/9  e2e full lifecycle";                quiet_kill; TEST_DB=gr_v2_it node tests/e2e/full_lifecycle.mjs || FAILED=1
step "9/9  chaos + concurrency + security"
  quiet_kill; TEST_DB=gr_v2_it node tests/chaos/parallel_drains.mjs || FAILED=1
  TEST_DB=gr_v2_it bash tests/chaos/concurrency_claim_test.sh || FAILED=1
  TEST_DB=gr_v2_it ROUNDS=10 bash tests/chaos/concurrent_suppression.sh || FAILED=1
  quiet_kill; TEST_DB=gr_v2_it node tests/security/security_tests.mjs || FAILED=1

quiet_kill
echo
if [ "$FAILED" = "0" ]; then
  echo "████ ALL SUITES PASSED ████"
  exit 0
else
  echo "████ SUITE FAILURES PRESENT ████"
  exit 1
fi
