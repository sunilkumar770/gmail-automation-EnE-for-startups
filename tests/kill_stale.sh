#!/usr/bin/env bash
# Kill stale test processes (postgrest / deno edge / node test runners) by
# scanning /proc — works in sandboxes without ps/pkill/pgrep.
killed=0
for d in /proc/[0-9]*; do
  pid=${d#/proc/}
  [ "$pid" = "$$" ] && continue
  cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
  case "$cmd" in *kill_stale*) continue ;; esac
  case "$cmd" in
    *postgrest*|*"deno run"*|*edge_v2.mjs*|*routes_v2.mjs*|*full_lifecycle.mjs*|*parallel_drains.mjs*|*security_tests.mjs*)
      kill -9 "$pid" 2>/dev/null && killed=$((killed+1)) && echo "killed $pid: ${cmd:0:80}" ;;
  esac
done
echo "kill_stale: $killed process(es) terminated"
