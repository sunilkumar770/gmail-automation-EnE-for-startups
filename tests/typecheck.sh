#!/usr/bin/env bash
# ============================================================================
# tests/typecheck.sh — static analysis gate
#   * tsc --noEmit for Next.js routes + shared lib (strict)
#   * deno check for the edge function + its lib modules (strict)
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0

echo "== tsc (app + lib, strict) =="
npx tsc --noEmit -p tsconfig.json || FAIL=1

DENO_BIN="${DENO_BIN:-}"
if [ -z "$DENO_BIN" ]; then
  if command -v deno >/dev/null 2>&1; then DENO_BIN="$(command -v deno)";
  elif [ -x "$HOME/.deno/bin/deno" ]; then DENO_BIN="$HOME/.deno/bin/deno";
  else echo "deno not found — set DENO_BIN"; exit 1; fi
fi

echo "== deno check (supabase/functions/notify-lifecycle) =="
(cd supabase/functions/notify-lifecycle && "$DENO_BIN" check --allow-import index.ts) || FAIL=1

if [ "$FAIL" = "0" ]; then echo "TYPECHECK: PASS"; else echo "TYPECHECK: FAIL"; fi
exit $FAIL
