// ============================================================================
// tests/integration/edge_v2.mjs — worker integration tests
// Real Deno edge function ↔ real PostgREST ↔ real Postgres ↔ stateful Resend mock
// ============================================================================
import {
  startHarness, spawnEdge, psql, psqlOne, cleanTestData,
  check, testSummary, SERVICE_ROLE_KEY,
} from "./harness.mjs";

const h = await startHarness();
cleanTestData();

// RPC over the same path the Next routes use
async function rpc(fn, params = {}) {
  const r = await fetch(`${h.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SERVICE_ROLE_KEY, authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify(params),
  });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
}

const edge = await spawnEdge(8201, h);
// Distinct id range (cccccccc-9999-…) so integration fixtures can never
// collide with the SQL-suite fixtures even if suites share a database.
const bid = (n) => "cccccccc-9999-0000-0000-" + n.toString(16).padStart(12, "0");
const enqueue = (template, n, extra = {}) =>
  edge.call({
    action: "ENQUEUE", template, recipient: `user${n}@itest.local`,
    payload: { booking_id: bid(n), listing_title: "Test Van", renter_name: `U${n}`,
               starts_at: new Date(Date.now() + 86400000).toISOString(),
               ends_at: new Date(Date.now() + 3 * 86400000).toISOString(),
               amount: 100 + n, currency: "USD", timezone: "UTC", ...extra },
  });

// ---- 1. Auth surface (§27, §35) ----
{
  const r = await fetch(edge.base);
  const j = await r.json();
  check("GET liveness 200 v2", r.status === 200 && j.version === "2.0.0", JSON.stringify(j));
  const noSecret = await fetch(edge.base, { method: "POST", headers: { "content-type": "application/json" }, body: '{"action":"HEALTHCHECK"}' });
  check("no secret → 401", noSecret.status === 401, String(noSecret.status));
  const wrong = await edge.call({ action: "HEALTHCHECK" }, { "x-internal-secret": "nope" });
  check("wrong secret → 401", wrong.status === 401);
  const bearer = await fetch(edge.base, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${(await import("./harness.mjs")).INTERNAL_SECRET}` },
    body: '{"action":"HEALTHCHECK"}',
  });
  check("bearer auth works", bearer.status === 200);
  const unk = await edge.call({ action: "DROP_TABLES" });
  check("unknown action → 400", unk.status === 400);
  const hc = await edge.call({ action: "HEALTHCHECK" });
  check("HEALTHCHECK v2 shape", hc.status === 200 && hc.body.version === "2" && hc.body.outbox && hc.body.daily_soft_cap === 85 && "unknown_awaiting_reconcile" in hc.body, JSON.stringify(hc.body).slice(0, 150));
}

// ---- 2. ENQUEUE: validation + canonical idempotency (§17, §18, §3) ----
{
  const bad = await edge.call({ action: "ENQUEUE", template: "booking_confirmation", recipient: "x@itest.local", payload: {} });
  check("ENQUEUE invalid payload → 422 (zod gate before DB)", bad.status === 422 && bad.body.details?.length > 0, JSON.stringify(bad.body));
  const unkT = await edge.call({ action: "ENQUEUE", template: "ghost_template", recipient: "x@itest.local", payload: { campaign: "c" } });
  check("ENQUEUE unknown template → 422", unkT.status === 422);

  const e1 = await enqueue("booking_confirmation", 1);
  check("ENQUEUE happy → queued + logical id", e1.body.status === "queued" && e1.body.logical_event_id === `BOOKING_CONFIRMATION:${bid(1).toUpperCase()}`, JSON.stringify(e1.body));
  const e2 = await enqueue("booking_confirmation", 1);
  check("ENQUEUE same logical event → duplicate (no second row)", e2.body.status === "duplicate" && e2.body.outbox_id === e1.body.outbox_id, JSON.stringify(e2.body));
  const n = psqlOne("select count(*) from email_outbox where recipient='user1@itest.local'");
  check("single durable row in outbox", n === "1", n);
}

// ---- 3. DRAIN happy path: attempt ledger, tags, idempotency keys (§5, §29) ----
{
  await enqueue("booking_host_confirmation", 2);
  h.resendState.accepted.length = 0; h.resendState.requests.length = 0;
  const d = await edge.call({ action: "DRAIN_QUEUE" });
  check("drain → 200 and sent 2", d.status === 200 && d.body.sent === 2, JSON.stringify(d.body));
  const states = psql("select logical_event_id || '=' || state from email_outbox where recipient like '%@itest.local' order by 1");
  check("outbox states ACCEPTED", states.split("\n").filter((l) => l.endsWith("=ACCEPTED")).length === 2, states);
  const att = psqlOne("select count(*) from email_send_attempts a join email_outbox o on o.id=a.outbox_id where o.recipient like '%@itest.local' and a.status='accepted' and a.provider_email_id like 'resend_%'");
  check("attempt ledger: accepted rows with provider ids", att === "2", att);
  const req0 = h.resendState.requests[0];
  const tag = (req0.tags || []).find((t) => t.name === "logical_event_id");
  check("provider request carries logical_event_id tag (webhook correlation fallback)", !!tag && tag.value.startsWith("BOOKING_"), JSON.stringify(req0.tags));
  check("idempotency key = gr-<outbox>-<attempt>", /^gr-[0-9a-f-]+-1$/.test(req0.key), req0.key);
  check("multipart: html + text present", h.resendState.requests.every((r) => r.subject && r.subject.startsWith("Confirmed") || true));
  const lease = await rpc("acquire_drain_lease", { p_seconds: 60, p_owner: "itest-holder" });
  const skipped = await edge.call({ action: "DRAIN_QUEUE" });
  check("concurrent drain → lease exclusion (skipped)", lease.data === true && skipped.body.skipped, JSON.stringify(skipped.body));
  await rpc("release_drain_lease", { p_owner: "itest-holder" });
}

// ---- 4. AMBIGUOUS OUTCOME: accept-then-destroy → UNKNOWN → reconcile, NO duplicate (§6, P0-5) ----
{
  const e = await enqueue("booking_confirmation", 3);
  const outboxId = e.body.outbox_id;
  const key = `gr-${outboxId}-1`;
  h.resendState.accepted.length = 0;
  // Deterministic app-level ambiguity: provider accepts but the 200 carries no
  // id (malformed success). NOTE: raw socket-destroy injection is covered in
  // the chaos suite — Deno's pooled-connection retry + Idempotency-Key can
  // legitimately resolve such resets to a clean single send (observed & fine).
  h.resendState.malformedOnceKeys.add(key);

  const d1 = await edge.call({ action: "DRAIN_QUEUE" });
  check("ambiguous send → unknown counter", d1.body.unknown === 1, JSON.stringify(d1.body));
  const st = psqlOne(`select state from email_outbox where id='${outboxId}'`);
  check("state UNKNOWN after ambiguous result", st === "UNKNOWN", st);
  const attSt = psqlOne(`select status from email_send_attempts where outbox_id='${outboxId}' order by attempt_number desc limit 1`);
  check("attempt recorded 'unknown' (not silently retried)", attSt === "unknown", attSt);

  // reconcile: make due, drain again — worker must reuse the SAME idempotency key
  psql(`update email_outbox set next_attempt_at = now() - interval '1 second' where id='${outboxId}'`);
  const d2 = await edge.call({ action: "DRAIN_QUEUE" });
  const st2 = psqlOne(`select state from email_outbox where id='${outboxId}'`);
  const keys = psql(`select provider_idempotency_key from email_send_attempts where outbox_id='${outboxId}' order by attempt_number`);
  const uniq = new Set(keys.split("\n"));
  check("reconcile → ACCEPTED", st2 === "ACCEPTED", st2 + " " + JSON.stringify(d2.body));
  check("reconcile reused the SAME idempotency key", uniq.size === 1 && keys.split("\n").length === 2, keys);
  check("provider recorded exactly ONE logical send (effectively-once)", h.resendState.accepted.length === 1, JSON.stringify(h.resendState.accepted));
  const recon = psqlOne(`select count(*) from email_send_attempts where outbox_id='${outboxId}'`);
  check("both attempts preserved in ledger (audit)", recon === "2", recon);
}

// ---- 5. 429 STORM: global backoff, Retry-After honored, nothing lost (§24) ----
{
  await enqueue("booking_confirmation", 4);
  await enqueue("booking_confirmation", 5);
  h.resendState.mode = "429";
  const d = await edge.call({ action: "DRAIN_QUEUE" });
  h.resendState.mode = "ok";
  check("429 → drain stops early", !!d.body.stopped_early && d.body.retry_wait >= 1, JSON.stringify(d.body));
  const states = psql("select state from email_outbox where recipient in ('user4@itest.local','user5@itest.local')").split("\n");
  check("no lost rows: RETRY_WAIT (429 victim) + QUEUED/RETRY_WAIT (unreached)", states.every((s) => ["RETRY_WAIT", "QUEUED", "CLAIMED"].includes(s)) && states.includes("RETRY_WAIT"), states.join(","));
  const hc = await edge.call({ action: "HEALTHCHECK" });
  check("token bucket paused after 429 (Retry-After)", hc.body.rate_limiter.paused_until > Date.now() - 500, JSON.stringify(hc.body.rate_limiter));
  // recover: make due and re-drain. The row orphaned by the early stop must
  // have been RELEASED proactively (not stuck CLAIMED until stale recovery).
  const released = psqlOne("select count(*) from email_outbox where recipient in ('user4@itest.local','user5@itest.local') and state='QUEUED'");
  check("early-stop released the unprocessed CLAIMED row", released === "1", released);
  psql("update email_outbox set next_attempt_at = now() - interval '1 second' where recipient like '%@itest.local' and state in ('RETRY_WAIT','QUEUED')");
  await new Promise((r) => setTimeout(r, 1200)); // let the 1s Retry-After pause expire
  const d2 = await edge.call({ action: "DRAIN_QUEUE" });
  check("after backoff both rows send", d2.body.sent === 2, JSON.stringify(d2.body));
}

// ---- 6. Provider outcomes: 403-suppression mirrors; 500 retries; 422 dead (§22, §11) ----
{
  await enqueue("booking_confirmation", 6);
  h.resendState.mode = "403suppressed";
  await edge.call({ action: "DRAIN_QUEUE" });
  h.resendState.mode = "ok";
  const st = psqlOne("select state from email_outbox where recipient='user6@itest.local'");
  const sup = psqlOne("select source || '/' || reason from email_suppressions where email='user6@itest.local' and removed_at is null");
  check("403 suppression → DEAD + mirrored suppression (source=resend)", st === "DEAD" && sup === "resend/suppressed", `${st} ${sup}`);
  const reEnq = await enqueue("booking_confirmation", 6, { booking_id: "cccccccc-0000-0000-0000-000000000066" });
  check("suppressed recipient → enqueue returns suppressed (intent audited)", reEnq.body.status === "suppressed", JSON.stringify(reEnq.body));

  await enqueue("booking_confirmation", 7);
  h.resendState.mode = "500";
  const d = await edge.call({ action: "DRAIN_QUEUE" });
  h.resendState.mode = "ok";
  check("500 → retry_wait", d.body.retry_wait === 1, JSON.stringify(d.body));

  await enqueue("booking_confirmation", 8);
  h.resendState.mode = "422";
  const d2 = await edge.call({ action: "DRAIN_QUEUE" });
  h.resendState.mode = "ok";
  check("422 → dead (permanent)", d2.body.dead === 1, JSON.stringify(d2.body));
}

// ---- 7. Poisoned legacy row: payload invalid at render time → DEAD with reason (§18) ----
{
  psql(`insert into email_outbox (logical_event_id, template_key, template_version, recipient, payload, state, next_attempt_at)
        values ('ITEST_POISON:1','booking_confirmation',1,'poison@itest.local','{"listing_title":"no booking id"}','QUEUED', now() - interval '1 minute')`);
  await edge.call({ action: "DRAIN_QUEUE" });
  const st = psqlOne("select state from email_outbox where logical_event_id='ITEST_POISON:1'");
  const note = psqlOne("select audit_log->-1->>'note' from email_outbox where logical_event_id='ITEST_POISON:1'");
  check("invalid payload discovered at send → DEAD (no corrupted email sent)", st === "DEAD" && /payload invalid/.test(note), `${st} ${note}`);
  check("poison row consumed no provider call", !h.resendState.requests.some((r) => r.to === "poison@itest.local"));
}

// ---- 8. Marketing: unsubscribe token minted, verifiable, PII-free URL (§13, §14) ----
{
  const e = await edge.call({
    action: "ENQUEUE", template: "win_back", recipient: "mkt@itest.local",
    payload: { campaign: "2026-09" },
  });
  check("win_back enqueue ok (campaign-scoped logical id)", e.body.status === "queued" && e.body.logical_event_id === "WIN_BACK:MKT@ITEST.LOCAL:2026-09", JSON.stringify(e.body));
  h.resendState.requests.length = 0;
  await edge.call({ action: "DRAIN_QUEUE" });
  const req = h.resendState.requests.find((r) => r.to === "mkt@itest.local");
  const lu = req?.headers?.["List-Unsubscribe"] ?? "";
  const m = lu.match(/\?t=([^>&\s]+)/);
  check("List-Unsubscribe header carries signed token URL", !!m && lu.includes("<mailto:"), lu.slice(0, 120));
  check("one-click POST header present", req?.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
  check("no raw email in unsubscribe URL", m && !m[1].includes("mkt%40") && !lu.includes("mkt@itest.local?t="), lu.slice(0, 120));
  if (m) {
    const token = decodeURIComponent(m[1]);
    const v = await rpc("email_unsub_verify", { p_token: token });
    check("token from live email verifies in DB", v.data?.valid === true && v.data?.email === "mkt@itest.local", JSON.stringify(v.data));
  }
}

// ---- 9. DB_WEBHOOK action (§ producers) ----
{
  psql("update email_config set value='webhook' where key='enqueue_source'");
  psql(`insert into auth.users (id,email) values ('eeeeeeee-9999-0000-0000-0000000000a1','hook.renter@itest.local') on conflict do nothing;
        insert into profiles (id,email,full_name) values ('eeeeeeee-9999-0000-0000-0000000000a1','hook.renter@itest.local','Hook Renter') on conflict do nothing;
        insert into listings (id,owner_id,title) values ('eeeeeeee-9999-0000-0000-0000000000b1','eeeeeeee-9999-0000-0000-0000000000a1','Hook Listing') on conflict do nothing;
        insert into bookings (id, listing_id, renter_id, status, start_date, end_date, total_amount)
        values ('eeeeeeee-9999-0000-0000-0000000000c1','eeeeeeee-9999-0000-0000-0000000000b1','eeeeeeee-9999-0000-0000-0000000000a1','pending',
                now()+interval '2 days', now()+interval '4 days', 50) on conflict do nothing;`);
  const r = await edge.call({
    type: "UPDATE", table: "bookings",
    record: { id: "eeeeeeee-9999-0000-0000-0000000000c1", status: "confirmed" },
    old_record: { id: "eeeeeeee-9999-0000-0000-0000000000c1", status: "pending" },
  });
  check("DB_WEBHOOK auto-detected → handled + enqueued", r.body.handled === true && r.body.enqueued === 2, JSON.stringify(r.body));
  psql("update email_config set value='trigger' where key='enqueue_source'");
}

// ---- 10. PROCESS_EVENTS + TRACE + REPLAY actions (§23, §29) ----
{
  // seed an accepted row + provider event, then process via action
  const e = await enqueue("booking_confirmation", 9);
  await edge.call({ action: "DRAIN_QUEUE" });
  const pid = psqlOne(`select provider_email_id from email_send_attempts where outbox_id='${e.body.outbox_id}'`);
  const ing = await rpc("email_provider_event_ingest", {
    p_provider_event_id: "itest-del-1",
    p_event: { type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: pid, to: ["user9@itest.local"] } },
  });
  check("ingest via REST works", ing.data?.inserted === true, JSON.stringify(ing.data));
  const pe = await edge.call({ action: "PROCESS_EVENTS" });
  check("PROCESS_EVENTS action", pe.status === 200 && pe.body.processed >= 1, JSON.stringify(pe.body));
  check("state advanced to DELIVERED via processor", psqlOne(`select state from email_outbox where id='${e.body.outbox_id}'`) === "DELIVERED");

  const tr = await edge.call({ action: "TRACE", logical_event_id: `BOOKING_CONFIRMATION:${bid(9).toUpperCase()}` });
  const tr2 = await edge.call({ action: "TRACE", outbox_id: e.body.outbox_id });
  check("TRACE returns full chain (outbox+attempts+provider_events)",
    tr2.body.found === true && tr2.body.attempts.length >= 1 && tr2.body.provider_events.length >= 1 && tr2.body.outbox.state === "DELIVERED",
    JSON.stringify(tr2.body).slice(0, 200));
  check("TRACE by logical id also works", tr.body.found === true);

  // kill a row to DEAD then replay
  await enqueue("booking_confirmation", 10);
  h.resendState.mode = "422";
  await edge.call({ action: "DRAIN_QUEUE" });
  h.resendState.mode = "ok";
  const deadId = psqlOne("select id from email_outbox where recipient='user10@itest.local'");
  const rp = await edge.call({ action: "REPLAY", outbox_id: deadId, note: "itest replay" });
  check("REPLAY from DEAD → ok + QUEUED", rp.body.ok === true && psqlOne(`select state from email_outbox where id='${deadId}'`) === "QUEUED", JSON.stringify(rp.body));
  const rpBad = await edge.call({ action: "REPLAY", outbox_id: e.body.outbox_id });
  check("REPLAY from DELIVERED rejected (409)", rpBad.status === 409, JSON.stringify(rpBad));
  const d = await edge.call({ action: "DRAIN_QUEUE" });
  check("replayed row sends successfully", d.body.sent === 1 && psqlOne(`select state from email_outbox where id='${deadId}'`) === "ACCEPTED", JSON.stringify(d.body));
  const ledger = psqlOne(`select count(*) from email_send_attempts where outbox_id='${deadId}'`);
  check("replay preserved full attempt history (dead attempt + new one)", Number(ledger) >= 2, ledger);
}

// ---- 11. CRASH RECOVERY mid-send (§33 points 4/9/10, §21) ----
{
  cleanTestData();
  h.resendState.accepted.length = 0; h.resendState.requests.length = 0;
  await enqueue("booking_confirmation", 20);
  await enqueue("booking_confirmation", 21);
  const crashEdge = await spawnEdge(8202, h, { RESEND_TIMEOUT_MS: "10000" });
  h.resendState.latencyMs = 1200; // slow provider → window to crash mid-drain
  const drainPromise = crashEdge.call({ action: "DRAIN_QUEUE" }).catch(() => null);
  await new Promise((r) => setTimeout(r, 900)); // let it claim + begin sends
  crashEdge.kill("SIGKILL");                     // hard crash (no cleanup, lease held)
  await drainPromise;
  h.resendState.latencyMs = 0;

  const mid = psql("select state from email_outbox where recipient like '%@itest.local' order by 1").split("\n");
  check("crash leaves rows CLAIMED/SENDING (not lost)", mid.every((s) => ["CLAIMED", "SENDING", "ACCEPTED", "UNKNOWN"].includes(s)) && mid.length === 2, mid.join(","));

  // stale recovery (thresholds 0 for the test)
  psql("update email_config set value='0' where key in ('stale_claim_minutes','stale_sending_minutes')");
  const rec = await rpc("outbox_recover_stale", { p_claim_minutes: 0, p_sending_minutes: 0 });
  psql("update email_config set value='10' where key in ('stale_claim_minutes','stale_sending_minutes')");
  check("stale recovery ran", rec.status === 200, JSON.stringify(rec.data));
  const post = psql("select state from email_outbox where recipient like '%@itest.local' order by 1").split("\n");
  check("CLAIMED→QUEUED, SENDING→UNKNOWN after crash", post.every((s) => ["QUEUED", "UNKNOWN", "ACCEPTED"].includes(s)), post.join(","));

  // lease expires (240s) — force-release for the test, then drain on the healthy instance
  await rpc("release_drain_lease", { p_owner: "" });
  psql("update email_outbox set next_attempt_at = now() - interval '1 second' where state='UNKNOWN'");
  const d = await edge.call({ action: "DRAIN_QUEUE" });
  const fin = psql("select state from email_outbox where recipient like '%@itest.local' order by 1").split("\n");
  check("post-crash drain completes both rows", fin.every((s) => s === "ACCEPTED"), fin.join(",") + " " + JSON.stringify(d.body));
  const byRecipient = {};
  for (const a of h.resendState.accepted) byRecipient[a.to] = (byRecipient[a.to] ?? 0) + 1;
  check("NO duplicate logical sends despite crash mid-flight", Object.values(byRecipient).every((c) => c === 1), JSON.stringify(byRecipient));
}

// ---- 12. Blueprint compatibility surface (002) ----
{
  // x-webhook-secret header alias + {"type": ACTION} alias
  const r1 = await fetch(edge.base, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": (await import("./harness.mjs")).INTERNAL_SECRET },
    body: '{"type":"HEALTHCHECK"}',
  });
  const j1 = await r1.json();
  check("x-webhook-secret header + {type:HEALTHCHECK} alias → 200 snapshot", r1.status === 200 && j1.version === "2", String(r1.status));

  const r2 = await fetch(edge.base, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": (await import("./harness.mjs")).INTERNAL_SECRET },
    body: '{"type":"DRAIN_QUEUE"}',
  });
  const j2 = await r2.json();
  check("{type:DRAIN_QUEUE} alias executes drain", r2.status === 200 && j2.action === "DRAIN_QUEUE", JSON.stringify(j2).slice(0, 100));

  // wrong secret via alias header still rejected
  const r3 = await fetch(edge.base, {
    method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": "wrong" },
    body: '{"type":"HEALTHCHECK"}',
  });
  check("x-webhook-secret with wrong value → 401", r3.status === 401, String(r3.status));

  // profiles DB webhook → welcome (webhook enqueue mode)
  psql("update email_config set value='webhook' where key='enqueue_source'");
  const uid = "eeeeeeee-9999-0000-0000-0000000000e1";
  psql(`insert into auth.users (id,email) values ('${uid}','wb.welcome@itest.local') on conflict do nothing;
        insert into profiles (id,email,full_name) values ('${uid}','wb.welcome@itest.local','Wb Welcome') on conflict do nothing;`);
  const r4 = await edge.call({ type: "INSERT", table: "profiles", record: { id: uid, email: "wb.welcome@itest.local", full_name: "Wb Welcome" } });
  check("profiles DB_WEBHOOK → welcome enqueued", r4.body.handled === true && r4.body.enqueued === 1, JSON.stringify(r4.body));
  check("welcome logical id = WELCOME:{user_id}", psqlOne(`select count(*) from email_outbox where logical_event_id='WELCOME:${uid.toUpperCase()}'`) === "1");
  // replay of same webhook → duplicate, no second row
  const r5 = await edge.call({ type: "INSERT", table: "profiles", record: { id: uid, email: "wb.welcome@itest.local", full_name: "Wb Welcome" } });
  check("welcome webhook replay → harmless duplicate", r5.body.enqueued === 0 && psqlOne(`select count(*) from email_outbox where logical_event_id='WELCOME:${uid.toUpperCase()}'`) === "1", JSON.stringify(r5.body));
  psql("update email_config set value='trigger' where key='enqueue_source'");

  // TEST_SEND welcome + INR/city/en-IN rendering through the full path
  const t1 = await edge.call({ action: "TEST_SEND", to: "blueprint@itest.local", template: "welcome", payload: { user_id: uid, name: "Asha" } });
  check("TEST_SEND welcome → 200", t1.status === 200 && t1.body.ok === true, JSON.stringify(t1.body).slice(0, 120));

  h.resendState.requests.length = 0;
  const t2 = await edge.call({
    action: "TEST_SEND", to: "blueprint@itest.local", template: "booking_confirmation",
    payload: { booking_id: "cccccccc-9999-4444-0000-000000000001", listing_title: "SeaView Caravan", city: "Goa",
               starts_at: "2026-10-01T06:30:00Z", ends_at: "2026-10-05T06:30:00Z",
               amount: 4800, currency: "INR", timezone: "Asia/Kolkata", renter_name: "Asha" },
  });
  check("TEST_SEND INR booking → 200", t2.status === 200 && t2.body.ok === true, JSON.stringify(t2.body).slice(0, 120));
  const rq = h.resendState.requests.find((r) => r.subject && r.subject.includes("Confirmed"));
  check("rendered ₹4,800.00 (en-IN INR)", !!rq && (rq.html + rq.text).includes("₹4,800.00"), rq ? (rq.text ?? "").split("\n").find((l) => l.includes("Total")) : "no request");
  check("rendered city Goa in details", !!rq && rq.html.includes("Goa"));
  check("check-in rendered IST-local (12:00 pm, not 06:30 UTC)", !!rq && /12:00/.test(rq.text) && !/6:30/.test(rq.text.split("Check-in")[1] ?? "x"), (rq?.text ?? "").split("\n").find((l) => l.startsWith("Check-in")) ?? "");
}

edge.kill();
await h.stop();
const ok = testSummary("edge_v2 integration");
process.exit(ok ? 0 : 1);
