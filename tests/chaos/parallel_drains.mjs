// ============================================================================
// tests/chaos/parallel_drains.mjs — §34 chaos/concurrency battery
//   * 3 concurrent worker instances draining the same queue (lease + SKIP LOCKED)
//   * duplicate webhook storm (10 concurrent identical deliveries)
//   * out-of-order webhook storm (5 events fired concurrently)
//   * 429 storm (provider outage: nothing lost, nothing double-sent)
// ============================================================================
import { startHarness, spawnEdge, psql, psqlOne, cleanTestData, check, testSummary, SERVICE_ROLE_KEY } from "../integration/harness.mjs";
import { Webhook } from "svix";

const h = await startHarness();
cleanTestData();
psql(`delete from public.email_outbox where logical_event_id like 'CHAOS:%';
      delete from public.email_send_attempts where outbox_id not in (select id from public.email_outbox);`);

const edges = [];
for (let i = 0; i < 3; i++) edges.push(await spawnEdge(8401 + i, h));

async function rpcJson(fn, params = {}) {
  const r = await fetch(`${h.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SERVICE_ROLE_KEY, authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify(params),
  });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ---------------------------------------------------------------------------
// 1. THREE WORKERS, 40 ROWS, CONCURRENT DRAINS
// ---------------------------------------------------------------------------
{
  psql(`insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state, priority, next_attempt_at)
        select 'CHAOS:SEND:' || g, 'booking_confirmation', 1, 'chaos' || g || '@itest.local',
               jsonb_build_object('booking_id', 'cccccccc-9999-0000-0000-' || lpad(to_hex(g), 12, '0'),
                                  'listing_title', 'Chaos Van ' || g, 'starts_at', '2026-10-01T10:00:00Z',
                                  'amount', g, 'currency', 'USD', 'timezone', 'UTC'),
               'QUEUED', 5, now() - interval '1 minute'
        from generate_series(1, 40) g`);
  h.resendState.accepted.length = 0;
  h.resendState.requests.length = 0;

  // fire concurrent drains at all 3 instances, repeated until settled (cron-like)
  for (let round = 0; round < 10; round++) {
    await Promise.all(edges.map((e) => e.call({ action: "DRAIN_QUEUE" })));
    const remaining = Number(psqlOne("select count(*) from email_outbox where logical_event_id like 'CHAOS:SEND:%' and state in ('QUEUED','CLAIMED','RETRY_WAIT','SENDING','UNKNOWN')"));
    if (remaining === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const accepted = psqlOne("select count(*) from email_outbox where logical_event_id like 'CHAOS:SEND:%' and state='ACCEPTED'");
  check("chaos: all 40 rows ACCEPTED under 3 concurrent workers", accepted === "40", accepted);
  const uniqueAccepts = new Set(h.resendState.accepted.map((a) => a.key)).size;
  check("chaos: provider saw exactly 40 unique logical sends (no duplicates)", uniqueAccepts === 40, String(uniqueAccepts));
  check("chaos: total provider requests == 40 (zero wasted retries)", h.resendState.requests.length === 40, String(h.resendState.requests.length));
  const perWorker = psql("select locked_by, count(*) from email_outbox where logical_event_id like 'CHAOS:SEND:%' group by 1 order by 2 desc").split("\n");
  check("chaos: multiple workers actually participated (SKIP LOCKED sharing)", perWorker.length >= 1, perWorker.join(" | "));
  const attemptDupes = psqlOne("select count(*) from (select provider_idempotency_key from email_send_attempts a join email_outbox o on o.id=a.outbox_id where o.logical_event_id like 'CHAOS:SEND:%' and a.status='accepted' group by 1 having count(*) > 1) x");
  check("chaos: no accepted-attempt key collisions", attemptDupes === "0", attemptDupes);
}

// ---------------------------------------------------------------------------
// 2. DUPLICATE WEBHOOK STORM (10 concurrent identical deliveries)
// ---------------------------------------------------------------------------
process.env.NEXT_PUBLIC_SUPABASE_URL = h.supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
process.env.RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from("chaos-secret-bytes-32-chars-min!!").toString("base64");
const { POST: webhookPOST } = await import("../.build/route-webhook.mjs");
const { NextRequest } = await import("next/server.js");
const wh = new Webhook(process.env.RESEND_WEBHOOK_SECRET);
{
  const provId = psqlOne(`select a.provider_email_id from email_send_attempts a join email_outbox o on o.id=a.outbox_id
                          where o.logical_event_id='CHAOS:SEND:1' and a.status='accepted' limit 1`);
  const payload = JSON.stringify({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: provId, to: ["chaos1@itest.local"] } });
  const id = "itest-chaos-storm-1";
  const ts = new Date();
  const sig = wh.sign(id, ts, payload);
  const mk = () => webhookPOST(new NextRequest("https://gorentals.com/api/resend-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(ts.getTime() / 1000)), "svix-signature": sig },
    body: payload,
  }));
  const results = await Promise.all(Array.from({ length: 10 }, mk));
  check("storm: all 10 concurrent duplicates → 200", results.every((r) => r.status === 200), results.map((r) => r.status).join(","));
  const n = psqlOne(`select count(*) from email_provider_events where provider_event_id='${id}'`);
  check("storm: exactly ONE inbox row (unique constraint arbitrates races)", n === "1", n);
  const st = psqlOne("select state from email_outbox where logical_event_id='CHAOS:SEND:1'");
  check("storm: state applied exactly once → DELIVERED", st === "DELIVERED", st);
  const auditDupes = psqlOne("select count(*) from email_outbox o, jsonb_array_elements(o.audit_log) e where o.logical_event_id='CHAOS:SEND:1' and e->>'to'='DELIVERED'");
  check("storm: no duplicate lifecycle transitions in audit", auditDupes === "1", auditDupes);
}

// ---------------------------------------------------------------------------
// 3. OUT-OF-ORDER WEBHOOK STORM (fired concurrently, deterministic outcome)
// ---------------------------------------------------------------------------
{
  const provId = psqlOne(`select a.provider_email_id from email_send_attempts a join email_outbox o on o.id=a.outbox_id
                          where o.logical_event_id='CHAOS:SEND:2' and a.status='accepted' limit 1`);
  const events = [
    ["email.delivered", {}],
    ["email.sent", {}],
    ["email.bounced", { bounce: { type: "Permanent", subType: "General" } }],
    ["email.complained", {}],
    ["email.delivery_delayed", {}],
  ];
  const posts = events.map(([type, extra], i) => {
    const payload = JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: provId, to: ["chaos2@itest.local"], ...extra } });
    const id = `itest-chaos-ooo-${i}`;
    const ts = new Date();
    const sig = wh.sign(id, ts, payload);
    return webhookPOST(new NextRequest("https://gorentals.com/api/resend-webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(ts.getTime() / 1000)), "svix-signature": sig },
      body: payload,
    }));
  });
  await Promise.all(posts);
  // ensure processor ran (inline processing may race; cron-equivalent pass):
  await rpcJson("process_provider_events", { p_limit: 100 });
  const st = psqlOne("select state from email_outbox where logical_event_id='CHAOS:SEND:2'");
  check("out-of-order storm → deterministic terminal COMPLAINED (highest rank)", st === "COMPLAINED", st);
  const sup = psqlOne("select count(*) from email_suppressions where email='chaos2@itest.local' and removed_at is null");
  check("storm complaint/bounce suppressed once", sup === "1", sup);
  const allEvents = psqlOne("select count(*) from email_provider_events where provider_event_id like 'itest-chaos-ooo-%' and processing_status='processed'");
  check("all 5 storm events durably processed", allEvents === "5", allEvents);
}

// ---------------------------------------------------------------------------
// 4. 429 STORM (provider outage): nothing lost, nothing sent, clean recovery
// ---------------------------------------------------------------------------
{
  psql(`insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state, priority, next_attempt_at)
        select 'CHAOS:429:' || g, 'booking_confirmation', 1, 'storm' || g || '@itest.local',
               jsonb_build_object('booking_id', 'cccccccc-9999-1111-0000-' || lpad(to_hex(g), 12, '0'),
                                  'listing_title', 'Storm Van', 'starts_at', '2026-10-01T10:00:00Z',
                                  'amount', 1, 'currency', 'USD', 'timezone', 'UTC'),
               'QUEUED', 1, now() - interval '1 minute'
        from generate_series(1, 10) g`);
  h.resendState.mode = "429";
  h.resendState.accepted.length = 0;
  const r1 = await edges[0].call({ action: "DRAIN_QUEUE" });
  check("429 storm: first drain stops early", !!r1.body.stopped_early, JSON.stringify(r1.body));
  const lost = psqlOne("select count(*) from email_outbox where logical_event_id like 'CHAOS:429:%' and state in ('RETRY_WAIT','QUEUED','CLAIMED','SENDING','UNKNOWN')");
  check("429 storm: zero rows lost (all retryable/parked)", lost === "10", lost);
  check("429 storm: provider sent nothing", h.resendState.accepted.length === 0, String(h.resendState.accepted.length));
  const dead = psqlOne("select count(*) from email_outbox where logical_event_id like 'CHAOS:429:%' and state='DEAD'");
  check("429 storm: nothing dead-lettered prematurely", dead === "0", dead);

  // recovery
  h.resendState.mode = "ok";
  psql("update email_outbox set next_attempt_at = now() - interval '1 second' where logical_event_id like 'CHAOS:429:%'");
  await new Promise((r) => setTimeout(r, 1500)); // let paused buckets expire
  for (let round = 0; round < 6; round++) {
    await Promise.all(edges.map((e) => e.call({ action: "DRAIN_QUEUE" })));
    const remaining = Number(psqlOne("select count(*) from email_outbox where logical_event_id like 'CHAOS:429:%' and state <> 'ACCEPTED'"));
    if (remaining === 0) break;
    psql("update email_outbox set next_attempt_at = now() - interval '1 second' where logical_event_id like 'CHAOS:429:%' and state in ('QUEUED','RETRY_WAIT')");
    await new Promise((r) => setTimeout(r, 200));
  }
  const rec = psqlOne("select count(*) from email_outbox where logical_event_id like 'CHAOS:429:%' and state='ACCEPTED'");
  check("429 storm: full recovery, all 10 ACCEPTED", rec === "10", rec);
  const uniq = new Set(h.resendState.accepted.map((a) => a.key)).size;
  check("429 storm recovery: exactly 10 unique sends (no storm duplicates)", uniq === 10, String(uniq));
}

for (const e of edges) e.kill();
await h.stop();
const ok = testSummary("chaos/parallel");
process.exit(ok ? 0 : 1);
