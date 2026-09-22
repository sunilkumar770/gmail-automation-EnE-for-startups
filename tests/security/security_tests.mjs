// ============================================================================
// tests/security/security_tests.mjs — §35 adversarial security battery
//   forged/replayed webhooks · forged unsubscribe tokens · unauthorized worker
//   actions · SQL injection via payload · template/header injection ·
//   recipient manipulation · arbitrary URL injection · secret leakage ·
//   RLS via real PostgREST with anon JWT · body-size bounds
// ============================================================================
import { startHarness, spawnEdge, psqlOne, cleanTestData, check, testSummary, makeJwt, SERVICE_ROLE_KEY, INTERNAL_SECRET } from "../integration/harness.mjs";
import { Webhook } from "svix";

const h = await startHarness();
cleanTestData();
const edge = await spawnEdge(8501, h);

process.env.NEXT_PUBLIC_SUPABASE_URL = h.supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
process.env.RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from("security-suite-secret-32-bytes!!").toString("base64");
const { POST: webhookPOST } = await import("../.build/route-webhook.mjs");
const { GET: unsubGET, POST: unsubPOST } = await import("../.build/route-unsub.mjs");
const { NextRequest } = await import("next/server.js");
const wh = new Webhook(process.env.RESEND_WEBHOOK_SECRET);

// ---------------------------------------------------------------------------
// 1. UNAUTHORIZED WORKER SURFACE (§27: strong auth on internal endpoint)
// ---------------------------------------------------------------------------
{
  const actions = ["DRAIN_QUEUE", "PROCESS_EVENTS", "ENQUEUE", "REPLAY", "TRACE", "TEST_SEND", "SCAN_REVIEWS", "DB_WEBHOOK"];
  let all401 = true;
  for (const a of actions) {
    const r = await fetch(edge.base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: a, template: "win_back", recipient: "attacker@evil.example", payload: { campaign: "x" }, outbox_id: "00000000-0000-0000-0000-000000000000" }) });
    if (r.status !== 401) { all401 = false; console.log(`  action ${a} → ${r.status}`); }
  }
  check("all privileged actions reject missing secret (401)", all401);

  const r2 = await edge.call({ action: "DRAIN_QUEUE" }, { "x-internal-secret": INTERNAL_SECRET.slice(0, -1) + "X" });
  check("near-miss secret rejected (401)", r2.status === 401, String(r2.status));

  const r3 = await fetch(edge.base, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer not-the-secret" }, body: '{"action":"HEALTHCHECK"}' });
  check("bearer wrong secret rejected", r3.status === 403 || r3.status === 401, String(r3.status));

  const before = psqlOne("select count(*) from email_outbox");
  const r4 = await fetch(edge.base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "INSERT", table: "bookings", record: { id: "x", status: "confirmed" } }) });
  check("unauthenticated DB-webhook shape rejected (401) + no side effects", r4.status === 401 && psqlOne("select count(*) from email_outbox") === before);
}

// ---------------------------------------------------------------------------
// 2. SQL INJECTION through payload / recipient / logical id (§35)
// ---------------------------------------------------------------------------
{
  const inj = "'; DROP TABLE email_outbox; --";
  const r = await edge.call({
    action: "ENQUEUE", template: "booking_confirmation", recipient: "sec1@itest.local",
    payload: { booking_id: "cccccccc-9999-3333-0000-000000000001", listing_title: inj, starts_at: "2026-10-01T10:00:00Z", amount: 1, currency: "USD", timezone: "UTC" },
  });
  check("SQLi payload accepted as inert data (parameterized)", r.status === 200 && r.body.status === "queued", JSON.stringify(r.body));
  const stored = psqlOne("select payload->>'listing_title' from email_outbox where recipient='sec1@itest.local'");
  check("SQLi string stored verbatim (no execution, no mangling)", stored === inj, stored);
  const tables = psqlOne("select count(*) from pg_tables where schemaname='public' and tablename in ('email_outbox','email_send_attempts','email_provider_events','email_suppressions','email_templates')");
  check("all core tables intact after injection attempt", tables === "5", tables);

  // render path must escape it
  const r2 = await edge.call({ action: "TEST_SEND", to: "sec1@itest.local", template: "booking_confirmation", payload: { booking_id: "cccccccc-9999-3333-0000-000000000002", listing_title: inj, starts_at: "2026-10-01T10:00:00Z", amount: 1, currency: "USD", timezone: "UTC" } });
  check("TEST_SEND with injected payload accepted by renderer (200)", r2.status === 200 && r2.body.ok === true, JSON.stringify(r2.body).slice(0, 120));
  // mock Resend is in ok mode → accepted; inspect captured html
  const req = h.resendState.requests[h.resendState.requests.length - 1];
  // The injected string survives as INERT escaped text (that's correct); what
  // must never happen: live quote break-out or tag injection.
  check("SQLi/XSS payload rendered escaped (quote → &#39;, no live tags)",
    !!req && req.html.includes("&#39;") && !/<script/i.test(req.html) && !req.html.includes("'; DROP"),
    req ? "html captured" : "no request");

  // recipient-level injection → rejected, not queued
  const before = psqlOne("select count(*) from email_outbox where recipient like '%evil%'");
  const r3 = await edge.call({ action: "ENQUEUE", template: "win_back", recipient: "victim@x.com\r\nBcc:ceo@evil.example", payload: { campaign: "inj" } });
  const after = psqlOne("select count(*) from email_outbox where recipient like '%evil%'");
  check("CRLF recipient rejected (no row created)", r3.status >= 400 && before === after, `${r3.status}`);
}

// ---------------------------------------------------------------------------
// 3. HEADER INJECTION via listing title → subject sanitization (§35)
// ---------------------------------------------------------------------------
{
  h.resendState.requests.length = 0;
  await edge.call({
    action: "ENQUEUE", template: "booking_confirmation", recipient: "sec2@itest.local",
    payload: { booking_id: "cccccccc-9999-3333-0000-000000000003", listing_title: "Van\r\nBcc: victim@evil.example\r\nX-Inject: 1", starts_at: "2026-10-01T10:00:00Z", amount: 1, currency: "USD", timezone: "UTC" },
  });
  await edge.call({ action: "DRAIN_QUEUE" });
  const req = h.resendState.requests.find((r) => r.to === "sec2@itest.local");
  check("subject contains no CR/LF (header injection neutralized)", !!req && !/[\r\n]/.test(req.subject), JSON.stringify(req?.subject ?? null));
  check("no injected headers reached the provider", !!req && Object.keys(req.headers ?? {}).every((k) => !/bcc|x-inject/i.test(k)), JSON.stringify(Object.keys(req?.headers ?? {})));
}

// ---------------------------------------------------------------------------
// 4. ARBITRARY URL INJECTION (§35) — CTA URLs derive from appUrl + uuid only
// ---------------------------------------------------------------------------
{
  h.resendState.requests.length = 0;
  await edge.call({ action: "TEST_SEND", to: "sec3@itest.local", template: "review_request", payload: { booking_id: "cccccccc-9999-3333-0000-000000000004", listing_title: "x", ends_at: "2026-09-01T00:00:00Z" } });
  const req = h.resendState.requests.find((r) => r.to === "sec3@itest.local");
  const hrefs = [...(req?.html ?? "").matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  // first-party = APP_URL under test (gorentals.test) or the brand footer
  // (gorentals.com) or mailto unsubscribe — nothing attacker-controllable.
  const firstParty = (u) => u.startsWith("https://gorentals.test/") || u === "https://gorentals.com" || u.startsWith("mailto:");
  check("all rendered hrefs are first-party (no javascript:/attacker URLs)",
    hrefs.length > 0 && hrefs.every(firstParty),
    hrefs.join(" | "));
  check("no javascript: scheme anywhere in html", !(req?.html ?? "").toLowerCase().includes("javascript:"));
}

// ---------------------------------------------------------------------------
// 5. WEBHOOK FORGERY / REPLAY / ABUSE (§28, §35)
// ---------------------------------------------------------------------------
{
  const goodBody = JSON.stringify({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: "prov-sec-1", to: ["sec@itest.local"] } });
  const id = "itest-sec-forged-1";
  const ts = new Date();
  const goodSig = wh.sign(id, ts, goodBody);

  // forged: valid-looking headers, signature by wrong key
  const evil = new Webhook("whsec_" + Buffer.from("attacker-key-32-bytes-minimum!!!").toString("base64"));
  const rForged = await webhookPOST(new NextRequest("https://gorentals.com/api/resend-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(ts.getTime() / 1000)), "svix-signature": evil.sign(id, ts, goodBody) },
    body: goodBody,
  }));
  check("forged webhook (wrong key) → 400", rForged.status === 400, String(rForged.status));
  check("forged webhook persisted NOTHING", psqlOne(`select count(*) from email_provider_events where provider_event_id='${id}'`) === "0");

  // unsigned garbage → 400, no rows
  const nBefore = psqlOne("select count(*) from email_provider_events");
  const rGarbage = await webhookPOST(new NextRequest("https://gorentals.com/api/resend-webhook", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{\"type\":\"email.bounced\"}",
  }));
  check("unsigned garbage → 400 + zero rows", rGarbage.status === 400 && psqlOne("select count(*) from email_provider_events") === nBefore);

  // honest replay: sign once, deliver 5× sequentially → 1 row (concurrent covered in chaos)
  const req = new NextRequest("https://gorentals.com/api/resend-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(ts.getTime() / 1000)), "svix-signature": goodSig },
    body: goodBody,
  });
  const first = await webhookPOST(req);
  let dupes = 0;
  for (let i = 0; i < 4; i++) {
    const rq = new NextRequest("https://gorentals.com/api/resend-webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(ts.getTime() / 1000)), "svix-signature": goodSig },
      body: goodBody,
    });
    const r = await webhookPOST(rq);
    const j = await r.json();
    if (r.status === 200 && j.duplicate === true) dupes++;
  }
  check("valid signature accepted; 4 replays → duplicate:true", first.status === 200 && dupes === 4, `${first.status}/${dupes}`);
  check("replays collapsed to ONE inbox row", psqlOne(`select count(*) from email_provider_events where provider_event_id='${id}'`) === "1");
}

// ---------------------------------------------------------------------------
// 6. UNSUBSCRIBE TOKEN ATTACKS (§13, §35)
// ---------------------------------------------------------------------------
{
  const tokA = await (await fetch(`${h.supabaseUrl}/rest/v1/rpc/email_unsub_token`, {
    method: "POST", headers: { "content-type": "application/json", apikey: SERVICE_ROLE_KEY, authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ p_email: "alice@itest.local", p_topic: "marketing" }),
  })).json();
  const tokB = await (await fetch(`${h.supabaseUrl}/rest/v1/rpc/email_unsub_token`, {
    method: "POST", headers: { "content-type": "application/json", apikey: SERVICE_ROLE_KEY, authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ p_email: "bob@itest.local", p_topic: "marketing" }),
  })).json();

  // swap payload of A with B's signature → must fail (tamper)
  const aParts = tokA.split(".");
  const bParts = tokB.split(".");
  const swapped = `v1.${aParts[1]}.${bParts[2]}`;
  const rSwap = await unsubPOST(new NextRequest("https://gorentals.com/api/unsubscribe?t=" + swapped, { method: "POST" }));
  check("payload/signature swap between users → 400", rSwap.status === 400, String(rSwap.status));
  check("swap attack suppressed NOBODY", psqlOne("select count(*) from email_suppressions where removed_at is null and email in ('alice@itest.local','bob@itest.local')") === "0");

  // bit-flip in signature → 400
  const sigBytes = Buffer.from(bParts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  sigBytes[5] ^= 0xff;
  const flipped = `v1.${bParts[1]}.${sigBytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  const rFlip = await unsubPOST(new NextRequest("https://gorentals.com/api/unsubscribe?t=" + flipped, { method: "POST" }));
  check("single-bit-flipped signature → 400", rFlip.status === 400, String(rFlip.status));

  // honest B token works and only affects B
  const rB = await unsubPOST(new NextRequest("https://gorentals.com/api/unsubscribe?t=" + encodeURIComponent(tokB), { method: "POST" }));
  check("valid token → 200", rB.status === 200, String(rB.status));
  check("only the token's owner suppressed", psqlOne("select email from email_suppressions where removed_at is null and email in ('alice@itest.local','bob@itest.local')") === "bob@itest.local");

  // enumeration: 20 random-email tokens cannot be forged; invalid responses identical
  const bodies = new Set();
  for (let i = 0; i < 20; i++) {
    const fake = `v1.${Buffer.from(JSON.stringify({ e: `probe${i}@victim.example`, s: "marketing", i: 1 })).toString("base64url")}.${bParts[2]}`;
    const r = await unsubGET(new NextRequest("https://gorentals.com/api/unsubscribe?t=" + encodeURIComponent(fake)));
    bodies.add(r.status + "|" + (await r.text()).length);
  }
  check("20 forged-token probes → single identical response class (no oracle)", bodies.size === 1, [...bodies].join(","));
}

// ---------------------------------------------------------------------------
// 7. RLS via REAL PostgREST with anon JWT (§27)
// ---------------------------------------------------------------------------
{
  const anonKey = makeJwt("anon");
  const hdrs = { "content-type": "application/json", apikey: anonKey, authorization: `Bearer ${anonKey}` };
  const r1 = await fetch(`${h.supabaseUrl}/rest/v1/email_outbox?select=*&limit=1`, { headers: hdrs });
  const b1 = await r1.text();
  check("anon cannot read email_outbox via PostgREST", r1.status >= 400 || b1 === "[]", `${r1.status} ${b1.slice(0, 80)}`);
  const r2 = await fetch(`${h.supabaseUrl}/rest/v1/rpc/enqueue_email_v2`, {
    method: "POST", headers: hdrs,
    body: JSON.stringify({ p_template_key: "win_back", p_recipient: "anon-attack@itest.local", p_payload: { campaign: "x" } }),
  });
  check("anon cannot execute enqueue RPC", r2.status >= 400, String(r2.status));
  check("anon attack created no rows", psqlOne("select count(*) from email_outbox where recipient='anon-attack@itest.local'") === "0");
  const r3 = await fetch(`${h.supabaseUrl}/rest/v1/email_suppressions?select=*`, { headers: hdrs });
  check("anon cannot read suppression list (PII)", r3.status >= 400 || (await r3.text()) === "[]");
  const r4 = await fetch(`${h.supabaseUrl}/rest/v1/rpc/email_unsub_token`, { method: "POST", headers: hdrs, body: JSON.stringify({ p_email: "x@y.z" }) });
  check("anon cannot mint unsubscribe tokens", r4.status >= 400, String(r4.status));
}

// ---------------------------------------------------------------------------
// 8. SECRET LEAKAGE (§27/§29): responses, errors, logs
// ---------------------------------------------------------------------------
{
  const secret = INTERNAL_SECRET;
  const resendKey = "re_test_key"; // value configured in harness env
  const r = await fetch(edge.base, { method: "POST", headers: { "content-type": "application/json", "x-internal-secret": "wrong" }, body: "{broken json" });
  const body = await r.text();
  check("auth-failure body leaks nothing", !body.includes(secret) && !body.includes(resendKey), body.slice(0, 120));

  const r2 = await edge.call({ action: "NO_SUCH_ACTION" });
  const b2 = JSON.stringify(r2.body);
  check("unknown-action body leaks nothing", !b2.includes(secret) && !b2.includes(resendKey), b2.slice(0, 120));

  // oversized body → 413 without echoing content
  const big = JSON.stringify({ action: "ENQUEUE", template: "win_back", recipient: "big@itest.local", payload: { campaign: "x".repeat(2 * 1024 * 1024) } });
  const r3 = await fetch(edge.base, { method: "POST", headers: { "content-type": "application/json", "x-internal-secret": secret }, body: big });
  check("oversized edge body → 413", r3.status === 413, String(r3.status));

  // accumulated worker logs: no raw recipients, no secrets, no tokens
  const allLogs = edge.logs.join("\n");
  check("worker logs contain no internal secret", allLogs.length > 0 && !allLogs.includes(secret));
  check("worker logs contain no resend api key", !allLogs.includes(resendKey));
  check("worker logs contain no raw recipient addresses (hashed instead)", !allLogs.includes("@itest.local"), "raw PII in logs");
  check("worker logs contain no full unsubscribe tokens", !/v1\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(allLogs));
}

edge.kill();
await h.stop();
const ok = testSummary("security");
process.exit(ok ? 0 : 1);
