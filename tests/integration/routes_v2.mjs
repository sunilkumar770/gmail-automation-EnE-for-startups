// ============================================================================
// tests/integration/routes_v2.mjs — Next.js route handlers against the real
// PostgREST+Postgres stack (webhook inbox v2 + secure unsubscribe).
// ============================================================================
import { startHarness, psql, psqlOne, cleanTestData, check, testSummary, SERVICE_ROLE_KEY } from "./harness.mjs";
import { Webhook } from "svix";

const h = await startHarness();
cleanTestData();

process.env.NEXT_PUBLIC_SUPABASE_URL = h.supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
process.env.RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from("integration-test-secret-bytes-32!!").toString("base64");

const { POST: webhookPOST, GET: webhookGET } = await import("../.build/route-webhook.mjs");
const { GET: unsubGET, POST: unsubPOST } = await import("../.build/route-unsub.mjs");
const { NextRequest } = await import("next/server.js");

const WEBHOOK_URL = "https://gorentals.com/api/resend-webhook";
const UNSUB_URL = "https://gorentals.com/api/unsubscribe";
const wh = new Webhook(process.env.RESEND_WEBHOOK_SECRET);

function signRequest(bodyStr, opts = {}) {
  const msgId = opts.msgId ?? "itest-" + crypto.randomUUID();
  const ts = opts.ts ?? new Date();
  const signer = opts.wrongSecret
    ? new Webhook("whsec_" + Buffer.from("wrong-secret-bytes-32-chars-min!").toString("base64"))
    : wh;
  const signature = signer.sign(msgId, ts, bodyStr); // svix 1.99: sign(msgId, ts, payload)
  const headers = { "content-type": "application/json" };
  if (!opts.skipHeaders) {
    headers["svix-id"] = msgId;
    headers["svix-timestamp"] = String(Math.floor(ts.getTime() / 1000));
    headers["svix-signature"] = signature;
  }
  return new NextRequest(WEBHOOK_URL, { method: "POST", headers, body: bodyStr });
}

const ev = (type, over = {}) => JSON.stringify({
  type, created_at: new Date().toISOString(),
  data: { email_id: "prov-" + crypto.randomUUID().slice(0, 8), to: ["who@itest.local"], subject: "s", ...over },
});

// ---------------------------------------------------------------------------
// 1. Webhook security surface (§28)
// ---------------------------------------------------------------------------
{
  const r = await webhookPOST(signRequest(ev("email.delivered"), { wrongSecret: true }));
  check("forged signature → 400", r.status === 400, String(r.status));

  const body = ev("email.delivered");
  const req = signRequest(body);
  const tampered = new NextRequest(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": req.headers.get("svix-id"),
      "svix-timestamp": req.headers.get("svix-timestamp"),
      "svix-signature": req.headers.get("svix-signature"),
    },
    body: body.replace("delivered", "bounced"),
  });
  const rt = await webhookPOST(tampered);
  check("tampered body → 400", rt.status === 400, String(rt.status));

  const rm = await webhookPOST(signRequest(body, { skipHeaders: true }));
  check("missing svix headers → 400", rm.status === 400, String(rm.status));

  const rs = await webhookPOST(signRequest(body, { ts: new Date(Date.now() - 10 * 60_000) }));
  check("stale timestamp (replay window) → 400", rs.status === 400, String(rs.status));

  const bigBody = JSON.stringify({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: "x", blob: "A".repeat(300 * 1024) } });
  const rb = await webhookPOST(signRequest(bigBody));
  check("oversized payload → 413 (bounded body)", rb.status === 413, String(rb.status));

  const rg = await webhookGET();
  check("GET probe → 200 informational", rg.status === 200);

  const badSecret = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  const rn = await webhookPOST(signRequest(body));
  process.env.RESEND_WEBHOOK_SECRET = badSecret;
  check("unconfigured secret → 500 fail-loud", rn.status === 500, String(rn.status));
}

// ---------------------------------------------------------------------------
// 2. Durable inbox: persist-first, duplicates, unknown types (§7, §8)
// ---------------------------------------------------------------------------
{
  const body = ev("email.delivered", { email_id: "prov-inbox-1", to: ["inbox@itest.local"] });
  const fixedId = "itest-fixed-svix-1";
  const r1 = await webhookPOST(signRequest(body, { msgId: fixedId }));
  const j1 = await r1.json();
  check("valid event → 200 received+ingested", r1.status === 200 && j1.received === true && j1.provider_event_id === fixedId, JSON.stringify(j1));
  const n = psqlOne(`select count(*) from email_provider_events where provider_event_id='${fixedId}'`);
  check("exactly one inbox row", n === "1", n);

  // duplicate delivery (same svix-id) ×3 → harmless
  for (let i = 0; i < 3; i++) {
    const rd = await webhookPOST(signRequest(body, { msgId: fixedId }));
    const jd = await rd.json();
    if (i === 0) check("duplicate delivery → 200 duplicate:true", rd.status === 200 && jd.duplicate === true, JSON.stringify(jd));
  }
  const n2 = psqlOne(`select count(*) from email_provider_events where provider_event_id='${fixedId}'`);
  check("duplicates collapsed to one row (concurrent-safe unique)", n2 === "1", n2);

  const ru = await webhookPOST(signRequest(ev("email.opened")));
  const ju = await ru.json();
  check("unsubscribed type (opened) → acked 200", ru.status === 200 && ju.received === true, JSON.stringify(ju));
}

// ---------------------------------------------------------------------------
// 3. Out-of-order + before-send-result correlation (§9, P0-6)
// ---------------------------------------------------------------------------
{
  // seed an outbox row in SENDING with an attempt carrying provider id
  const oid = psqlOne(`insert into email_outbox (logical_event_id, template_key, template_version, recipient, payload, state)
    values ('ITEST_OOO:1','booking_confirmation',1,'ooo@itest.local','{"booking_id":"cccccccc-9999-0000-0000-0000000000aa"}','SENDING') returning id`);
  psql(`insert into email_send_attempts (outbox_id, attempt_number, provider_idempotency_key, status, provider_email_id, request_finished_at)
    values ('${oid}',1,'gr-ooo-1','accepted','prov-ooo-1', now())`);

  // delivered arrives FIRST
  await webhookPOST(signRequest(ev("email.delivered", { email_id: "prov-ooo-1", to: ["ooo@itest.local"] }, )));
  let st = psqlOne(`select state from email_outbox where id='${oid}'`);
  check("delivered applied", st === "DELIVERED", st);

  // late 'sent' must NOT regress state
  await webhookPOST(signRequest(ev("email.sent", { email_id: "prov-ooo-1", to: ["ooo@itest.local"] })));
  st = psqlOne(`select state from email_outbox where id='${oid}'`);
  check("late 'sent' does not regress DELIVERED (out-of-order safe)", st === "DELIVERED", st);

  // complaint after delivered IS allowed (rank upgrade) + suppresses
  await webhookPOST(signRequest(ev("email.complained", { email_id: "prov-ooo-1", to: ["ooo@itest.local"] })));
  st = psqlOne(`select state from email_outbox where id='${oid}'`);
  const sup = psqlOne("select source||'/'||reason from email_suppressions where email='ooo@itest.local' and removed_at is null");
  check("complaint upgrades delivered + suppresses (source=resend)", st === "COMPLAINED" && sup === "resend/complaint", `${st} ${sup}`);

  // WEBHOOK BEFORE SEND RESULT: event with only tags (no attempt row yet)
  const oid2 = psqlOne(`insert into email_outbox (logical_event_id, template_key, template_version, recipient, payload, state)
    values ('ITEST_RACE:1','booking_confirmation',1,'race@itest.local','{"booking_id":"cccccccc-9999-0000-0000-0000000000ab"}','SENDING') returning id`);
  const rRace = await webhookPOST(signRequest(ev("email.delivered", {
    email_id: "prov-race-9", to: ["race@itest.local"],
    tags: { logical_event_id: "itest_race:1" },   // provider echoes tag verbatim (lowercased input)
  })));
  check("webhook-before-send-result accepted (200)", rRace.status === 200);
  // tag lookup is case-insensitive in SQL via upper() — verify correlation worked
  const st2 = psqlOne(`select state from email_outbox where id='${oid2}'`);
  check("tag-based correlation resolved the race (state applied)", st2 === "DELIVERED", st2);

  // truly unknown provider id → orphan retained, 200 to provider
  const rOrph = await webhookPOST(signRequest(ev("email.delivered", { email_id: "prov-ghost-9", to: ["ghost@itest.local"] })));
  check("unknown provider id → still 200 (durable orphan)", rOrph.status === 200, String(rOrph.status));
  const orph = psqlOne("select processing_status||'/'||retry_count from email_provider_events where raw_payload::text like '%prov-ghost-9%' order by received_at desc limit 1");
  check("orphan durably retained + marked for retry", /^failed\/[1-9]/.test(orph), orph);
}

// ---------------------------------------------------------------------------
// 4. Suppression webhooks: source-scoped semantics (§11, §12)
// ---------------------------------------------------------------------------
{
  await webhookPOST(signRequest(JSON.stringify({
    type: "suppression.added", created_at: new Date().toISOString(),
    data: { email: "sup.added@itest.local", reason: "hard_bounce" },
  })));
  let s = psqlOne("select source||'/'||reason from email_suppressions where email='sup.added@itest.local' and removed_at is null");
  check("suppression.added → source=resend", s === "resend/suppressed", s);

  // user unsubscribes (simulated below via token) then provider removes → must survive
  await webhookPOST(signRequest(JSON.stringify({
    type: "suppression.removed", created_at: new Date().toISOString(),
    data: { email: "sup.added@itest.local" },
  })));
  s = psqlOne("select count(*) from email_suppressions where email='sup.added@itest.local' and removed_at is null");
  check("suppression.removed clears resend-owned row", s === "0", s);

  // temporary bounce must NOT suppress or terminalize
  const oid = psqlOne(`insert into email_outbox (logical_event_id, template_key, template_version, recipient, payload, state)
    values ('ITEST_TB:1','booking_confirmation',1,'tempb@itest.local','{"booking_id":"cccccccc-9999-0000-0000-0000000000ac"}','SENDING') returning id`);
  psql(`insert into email_send_attempts (outbox_id, attempt_number, provider_idempotency_key, status, provider_email_id, request_finished_at)
    values ('${oid}',1,'gr-tb-1','accepted','prov-tb-1', now())`);
  await webhookPOST(signRequest(ev("email.bounced", {
    email_id: "prov-tb-1", to: ["tempb@itest.local"],
    bounce: { type: "Temporary", subType: "Undetermined" },
  })));
  const st = psqlOne(`select state from email_outbox where id='${oid}'`);
  const sup = psqlOne("select count(*) from email_suppressions where email='tempb@itest.local' and removed_at is null");
  check("temporary bounce → DELAYED (not terminal), no suppression", st === "DELAYED" && sup === "0", `${st}/${sup}`);
}

// ---------------------------------------------------------------------------
// 5. UNSUBSCRIBE endpoint (§13, §14, §35)
// ---------------------------------------------------------------------------
{
  async function rpcJson(fn, params) {
    const r = await fetch(`${h.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SERVICE_ROLE_KEY, authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify(params),
    });
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }

  const token = await rpcJson("email_unsub_token", { p_email: "Unsub.Test@itest.local", p_topic: "marketing" });
  check("token minted via RPC", typeof token === "string" && token.startsWith("v1."), String(token).slice(0, 20));
  check("token contains no raw email", !token.includes("unsub.test") && !token.includes("Unsub.Test"));

  const getUrl = `${UNSUB_URL}?t=${encodeURIComponent(token)}`;
  const rg = await unsubGET(new NextRequest(getUrl));
  const rgBody = await rg.text();
  check("GET valid token → 200 confirmation page (no side effect)", rg.status === 200 && /Unsubscribe from GoRentals marketing/i.test(rgBody), String(rg.status));
  check("GET did NOT suppress yet", psqlOne("select count(*) from email_suppressions where email='unsub.test@itest.local' and removed_at is null") === "0");

  // invalid variants — identical responses (enumeration-proof)
  const forged = "v1." + Buffer.from(JSON.stringify({ e: "victim@itest.local", s: "marketing", i: 1 })).toString("base64url") + "." + token.split(".")[2];
  const variants = {
    "no token": UNSUB_URL,
    "garbage": UNSUB_URL + "?t=not-a-token",
    "forged payload": UNSUB_URL + "?t=" + encodeURIComponent(forged),
    "wrong sig": UNSUB_URL + "?t=" + token.slice(0, -4) + "AAAA",
    "wrong version": UNSUB_URL + "?t=" + encodeURIComponent("v2." + token.slice(3)),
  };
  const bodies = [];
  for (const [name, url] of Object.entries(variants)) {
    const r = await unsubGET(new NextRequest(url));
    bodies.push(await r.text());
    check(`GET ${name} → 400`, r.status === 400, String(r.status));
  }
  check("all invalid GETs return byte-identical pages (no enumeration oracle)", bodies.every((b) => b === bodies[0]));

  // POST one-click (RFC 8058): query token + form body
  const rp = await unsubPOST(new NextRequest(getUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  }));
  const rpBody = await rp.text();
  check("POST one-click → 200 success page", rp.status === 200 && /unsubscribed/i.test(rpBody), String(rp.status));
  const sup = psqlOne("select source||'/'||reason from email_suppressions where email='unsub.test@itest.local' and removed_at is null");
  check("suppression written with source=user reason=unsubscribe", sup === "user/unsubscribe", sup);

  // replay → idempotent success, still one active row
  const rp2 = await unsubPOST(new NextRequest(getUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
  check("one-click replay → 200 idempotent", rp2.status === 200, String(rp2.status));
  check("still exactly one active suppression", psqlOne("select count(*) from email_suppressions where email='unsub.test@itest.local' and removed_at is null") === "1");

  // provider removal must NOT clear a user unsubscribe (§11 core rule)
  await rpcJson("email_remove_provider_suppression", { p_email: "unsub.test@itest.local" });
  check("provider removal cannot clear user unsubscribe", psqlOne("select count(*) from email_suppressions where email='unsub.test@itest.local' and removed_at is null") === "1");

  // JSON variant for programmatic callers
  const rj = await unsubPOST(new NextRequest(UNSUB_URL, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ t: token }),
  }));
  const jj = await rj.json();
  check("POST JSON {t} + Accept:json → JSON success", rj.status === 200 && jj.ok === true && jj.unsubscribed === true, JSON.stringify(jj));

  // future sends blocked end-to-end: enqueue for this address → suppressed
  const enq = await rpcJson("enqueue_email_v2", {
    p_template_key: "win_back", p_recipient: "unsub.test@itest.local",
    p_payload: { campaign: "2026-10" }, p_priority: null, p_logical_event_id: null,
  });
  check("post-unsubscribe enqueue → suppressed (blocked)", enq?.status === "suppressed", JSON.stringify(enq));

  // expired token
  const payloadB64 = Buffer.from(JSON.stringify({ e: "exp@itest.local", s: "marketing", i: 1, x: Math.floor(Date.now() / 1000) - 3600 })).toString("base64url");
  // sign via DB helper (HMAC key lives in Vault — never in JS land)
  const expiredTok = await rpcJson("email_unsub_token", { p_email: "exp@itest.local", p_topic: "marketing", p_ttl_days: -1 });
  // ttl<=0 means no-expiry by design; craft expiry by direct SQL signing instead:
  const crafted = psqlOne(`select 'v1.'||public.email_b64url_encode(convert_to('${JSON.stringify({ e: "exp@itest.local", s: "marketing", i: 0, x: Math.floor(Date.now() / 1000) - 60 })}','UTF8'))||'.'||public.email_b64url_encode(public.email_unsub_hmac(public.email_b64url_encode(convert_to('${JSON.stringify({ e: "exp@itest.local", s: "marketing", i: 0, x: Math.floor(Date.now() / 1000) - 60 })}','UTF8'))))`).trim();
  const rexp = await unsubPOST(new NextRequest(UNSUB_URL + "?t=" + encodeURIComponent(crafted), { method: "POST" }));
  check("expired (correctly signed) token → 400", rexp.status === 400, String(rexp.status));
  void expiredTok; void payloadB64;
}

const ok = testSummary("routes_v2 integration");
await h.stop();
process.exit(ok ? 0 : 1);
