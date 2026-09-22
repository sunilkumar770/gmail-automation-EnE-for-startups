import { startMocks, state, resetState } from "./mock_servers.mjs";
import { spawn } from "node:child_process";
import os from "node:os";

const { server, port } = await startMocks();
const FN_PORT = 8123;
const SECRET = "test-internal-secret-value";

const child = spawn(
  os.homedir() + "/.deno/bin/deno",
  ["run", "--allow-net", "--allow-env", "--allow-read",
   process.cwd() + "/supabase/functions/notify-lifecycle/index.ts"],
  {
    env: {
      ...process.env,
      PORT: String(FN_PORT),
      SUPABASE_URL: `http://127.0.0.1:${port}`,
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role",
      EMAIL_INTERNAL_SECRET: SECRET,
      RESEND_API_KEY: "re_test_key",
      RESEND_API_URL: `http://127.0.0.1:${port}/emails`,
      RESEND_FROM_EMAIL: "GoRentals <bookings@gorentals.com>",
      APP_URL: "https://gorentals.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", d => process.env.VERBOSE && console.log("[fn]", String(d)));
child.stderr.on("data", d => process.env.VERBOSE && console.log("[fn:err]", String(d)));

const base = `http://127.0.0.1:${FN_PORT}`;
async function waitReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(base); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}
if (!await waitReady()) { console.log("FATAL: edge fn did not start"); child.kill(); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + "  " + extra); }
};
const post = (body, headers = {}) => fetch(base, {
  method: "POST",
  headers: { "content-type": "application/json", "x-internal-secret": SECRET, ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const mkRow = (id, over = {}) => ({
  id, template: "booking_confirmation", recipient: `user-${id}@example.com`,
  payload: { booking_id: "cccccccc-0000-0000-0000-000000000001", listing_title: "Camper Van", renter_name: "Ana", starts_at: "2026-09-20T10:00:00+00:00", ends_at: "2026-09-23T10:00:00+00:00", amount: 250 },
  status: "processing", priority: 1, attempts: 1, max_attempts: 3,
  send_at: new Date().toISOString(), locked_at: new Date().toISOString(), error_log: [], created_at: new Date().toISOString(),
  ...over,
});

// --- 1. GET liveness (public) ---
{
  const r = await fetch(base);
  const j = await r.json();
  check("GET liveness → 200 {ok:true}", r.status === 200 && j.ok === true && j.service === "notify-lifecycle", JSON.stringify(j));
}

// --- 2. Auth: missing secret → 401 ---
{
  const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "HEALTHCHECK" }) });
  check("no secret → 401", r.status === 401, String(r.status));
}
// --- 3. Auth: wrong secret → 401 ---
{
  const r = await post({ action: "HEALTHCHECK" }, { "x-internal-secret": "wrong-secret" });
  check("wrong secret → 401", r.status === 401, String(r.status));
}
// --- 4. Auth: Bearer works ---
{
  const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ action: "HEALTHCHECK" }) });
  const j = await r.json();
  check("bearer auth → HEALTHCHECK 200 + snapshot", r.status === 200 && j.ok === true && j.queue && j.daily_soft_cap === 85, JSON.stringify(j).slice(0, 120));
}
// --- 5. Unknown action → 400 ---
{
  const r = await post({ action: "DO_BAD_THINGS" });
  check("unknown action → 400", r.status === 400, String(r.status));
}

// --- 6. DRAIN happy path: 2 rows → both sent, lease released ---
{
  resetState();
  state.rows = [mkRow("q-1"), mkRow("q-2")];
  const r = await post({ action: "DRAIN_QUEUE" });
  const j = await r.json();
  check("drain → 200, claimed 2, sent 2", r.status === 200 && j.claimed === 2 && j.sent === 2, JSON.stringify(j));
  check("lease acquired+released", state.rpcCalls.includes("acquire_drain_lease") && state.released.length === 1);
  check("results recorded as 'sent' with resend ids", state.results.length === 2 && state.results.every(x => x.p_outcome === "sent" && String(x.p_resend_email_id).startsWith("resend_mock_")), JSON.stringify(state.results.map(x=>x.p_outcome)));
  const sent = state.resent[0];
  check("resend payload: html + text fallback + from", !!sent.html && !!sent.text && sent.from.includes("gorentals.com") && sent.to.length === 1, JSON.stringify(Object.keys(sent)));
  check("idempotency key header used", sent.headers["X-Entity-Ref-ID"].startsWith("gorentals-q-"));
  check("tags include template", sent.tags.some(t => t.name === "template" && t.value === "booking_confirmation"));
}

// --- 7. DRAIN when lease held → skipped, no claims ---
{
  resetState();
  state.leaseFree = false;
  state.rows = [mkRow("q-3")];
  const r = await post({ action: "DRAIN_QUEUE" });
  const j = await r.json();
  check("lease held → skipped without claiming", j.ok === true && !!j.skipped && !state.rpcCalls.includes("claim_email_batch"), JSON.stringify(j));
}

// --- 8. Suppressed row → skipped_suppressed ---
{
  resetState();
  state.rows = [mkRow("q-4")];
  state.precheck.suppressed = true;
  const r = await post({ action: "DRAIN_QUEUE" });
  const j = await r.json();
  check("suppressed → skipped, zero resend calls", j.skipped_suppressed === 1 && state.resent.length === 0 && state.results[0].p_outcome === "skipped_suppressed", JSON.stringify(j));
}

// --- 9. already_logged → skipped_duplicate, no resend call ---
{
  resetState();
  state.rows = [mkRow("q-5")];
  state.precheck.already_logged = true;
  const r = await post({ action: "DRAIN_QUEUE" });
  const j = await r.json();
  check("already_logged → duplicate skip, no send", j.skipped_duplicate === 1 && state.resent.length === 0 && state.results[0].p_outcome === "skipped_duplicate", JSON.stringify(j));
}

// --- 10. Rate limit → defer with correct minutes ---
{
  resetState();
  state.rows = [mkRow("q-6", { template: "review_request", priority: 7 })];
  state.precheck.rate_decision = "defer_day"; state.precheck.daily_sends = 90;
  await (await post({ action: "DRAIN_QUEUE" })).json();
  check("soft cap → defer 1440 min, no send", state.results[0].p_outcome === "defer" && state.results[0].p_detail.defer_minutes === 1440 && state.resent.length === 0, JSON.stringify(state.results[0]));

  resetState();
  state.rows = [mkRow("q-7")];
  state.precheck.rate_decision = "defer_hour"; state.precheck.daily_sends = 100;
  await (await post({ action: "DRAIN_QUEUE" })).json();
  check("hard cap → defer 15 min", state.results[0].p_detail.defer_minutes === 15, JSON.stringify(state.results[0]));
}

// --- 11. Resend 429 → retry + global backoff (drain stops early) ---
{
  resetState();
  state.rows = [mkRow("q-8"), mkRow("q-9")];
  state.resendMode = "429";
  const j = await (await post({ action: "DRAIN_QUEUE" })).json();
  check("429 → retry + stopped_early", state.results[0].p_outcome === "retry" && !!j.stopped_early && j.retried === 1, JSON.stringify(j));
  check("429 aborts remaining rows", state.resent.length === 1, "resent=" + state.resent.length);
}

// --- 12. Resend 403 suppressed → dead + resend_suppressed detail ---
{
  resetState();
  state.rows = [mkRow("q-10")];
  state.resendMode = "403suppressed";
  await (await post({ action: "DRAIN_QUEUE" })).json();
  check("403 suppression → dead + mirror flag", state.results[0].p_outcome === "dead" && state.results[0].p_detail.resend_suppressed === true, JSON.stringify(state.results[0]));
}

// --- 13. Resend 500 → retryable; 422 → dead ---
{
  resetState();
  state.rows = [mkRow("q-11")];
  state.resendMode = "500";
  await (await post({ action: "DRAIN_QUEUE" })).json();
  check("500 → retry", state.results[0].p_outcome === "retry", JSON.stringify(state.results[0]));

  resetState();
  state.rows = [mkRow("q-12")];
  state.resendMode = "422";
  await (await post({ action: "DRAIN_QUEUE" })).json();
  check("422 → dead (non-retryable)", state.results[0].p_outcome === "dead", JSON.stringify(state.results[0]));
}

// --- 14. Unknown template → dead without calling Resend ---
{
  resetState();
  state.rows = [mkRow("q-13", { template: "nonexistent_template" })];
  await (await post({ action: "DRAIN_QUEUE" })).json();
  check("unknown template → dead, no send", state.results[0].p_outcome === "dead" && /unknown template/.test(state.results[0].p_error) && state.resent.length === 0, JSON.stringify(state.results[0]));
}

// --- 15. Marketing template gets List-Unsubscribe headers ---
{
  resetState();
  state.rows = [mkRow("q-14", { template: "review_request", priority: 7 })];
  await (await post({ action: "DRAIN_QUEUE" })).json();
  const h = state.resent[0].headers;
  check("review_request has List-Unsubscribe + One-Click", h["List-Unsubscribe"]?.includes("unsubscribe") && h["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", JSON.stringify(h));
}

// --- 16. DB webhook auto-detection (no action field) ---
{
  resetState();
  const r = await post({ type: "INSERT", table: "bookings", record: { id: "cccccccc-0000-0000-0000-000000000001", status: "confirmed" } });
  const j = await r.json();
  check("db webhook auto-detected → RPC", state.rpcCalls.includes("handle_db_webhook_event") && j.handled === true && j.enqueued === 2, JSON.stringify(j));
}

// --- 17. Scans ---
{
  resetState();
  const j1 = await (await post({ action: "SCAN_REVIEWS" })).json();
  check("SCAN_REVIEWS → rpc + result", j1.ok === true && j1.enqueued === 5 && state.rpcCalls.includes("scan_review_requests"), JSON.stringify(j1));
  const j2 = await (await post({ action: "SCAN_REMINDERS" })).json();
  check("SCAN_REMINDERS → rpc + result", j2.ok === true && j2.enqueued === 2, JSON.stringify(j2));
}

// --- 18. ENQUEUE action ---
{
  resetState();
  const j = await (await post({ action: "ENQUEUE", template: "win_back", recipient: "someone@example.com", payload: { dedupe_key: "wk-2026-09" }, priority: 9 })).json();
  check("ENQUEUE → queued_id", j.ok === true && j.queued_id === "f47ac10b-58cc-4372-a567-0e02b2c3d479" && state.rpcCalls.includes("enqueue_email"), JSON.stringify(j));
  const j2 = await (await post({ action: "ENQUEUE", template: "" })).json();
  check("ENQUEUE validation → 400", j2.ok === false, JSON.stringify(j2));
}

// --- 19. TEST_SEND ---
{
  resetState();
  const j = await (await post({ action: "TEST_SEND", to: "qa@example.com", template: "booking_confirmation" })).json();
  check("TEST_SEND → resend id + [TEST] subject", j.ok === true && String(j.resend_email_id).startsWith("resend_mock_") && state.resent[0].subject.startsWith("[TEST]"), JSON.stringify(j));
  state.suppressed.add("qa@example.com");
  const j2 = await (await post({ action: "TEST_SEND", to: "qa@example.com" })).json();
  check("TEST_SEND respects suppression → 422", j2.ok === false, JSON.stringify(j2));
}

// --- 20. Malformed body → 401 (no secret path) / graceful with secret ---
{
  const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-internal-secret": SECRET }, body: "{not json" });
  check("malformed JSON body → 400 unknown action (no crash)", r.status === 400, String(r.status));
}

console.log(`\n${pass} passed, ${fail} failed`);
child.kill();
server.close();
process.exit(fail ? 1 : 0);
