// Integration test for app/api/resend-webhook/route.ts
import { createServer } from "node:http";
import { Webhook } from "svix";

const received = [];
let failMode = false;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ path: req.url, body: body ? JSON.parse(body) : null });
    if (failMode) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "db down" }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ handled: true, event: "bounced", log_inserted: true, suppressed: true, matched_booking: null }));
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const secret = "whsec_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
process.env.RESEND_WEBHOOK_SECRET = secret;
process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";

const { POST, GET } = await import("./route.mjs");
const { NextRequest } = await import("next/server.js");

const URL_ = "http://localhost:3000/api/resend-webhook";
const wh = new Webhook(secret);

function makeEvent(type = "email.bounced") {
  return {
    type,
    created_at: new Date().toISOString(),
    data: {
      email_id: crypto.randomUUID(),
      from: "GoRentals <bookings@gorentals.com>",
      to: ["victim@example.com"],
      subject: "Confirmed — your booking",
      bounce: { type: "Permanent", subType: "General", message: "550 user unknown" },
    },
  };
}

function makeReq(bodyStr, opts = {}) {
  const msgId = opts.msgId ?? "msg_" + Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64").replace(/[^a-zA-Z0-9]/g, "x");
  const ts = opts.ts ?? new Date();
  const sigWh = opts.wrongSecret ? new Webhook("whsec_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")) : wh;
  const sig = sigWh.sign(msgId, ts, bodyStr);
  const headers = { "content-type": "application/json" };
  if (!opts.skipHeaders) {
    headers["svix-id"] = msgId;
    headers["svix-timestamp"] = String(Math.floor(ts.getTime() / 1000));
    headers["svix-signature"] = sig;
  }
  return new NextRequest(URL_, { method: "POST", headers, body: bodyStr });
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

// 1. valid signature → 200 + RPC forwarded with the exact event
{
  const evt = makeEvent();
  const res = await POST(makeReq(JSON.stringify(evt)));
  const j = await res.json();
  check("valid bounce webhook → 200", res.status === 200, JSON.stringify(j));
  check("rpc result echoed", j.handled === true && j.suppressed === true, JSON.stringify(j));
  const rpcCall = received[received.length - 1];
  check("RPC path correct", rpcCall.path === "/rest/v1/rpc/handle_resend_webhook_event", rpcCall.path);
  check("event forwarded verbatim", rpcCall.body.p_event.data.email_id === evt.data.email_id);
}

// 2. replayed delivery (same headers+body) → still 200 (handler is idempotent)
{
  const evt = makeEvent("email.delivered");
  const bodyStr = JSON.stringify(evt);
  const req1 = makeReq(bodyStr);
  const h = { "svix-id": req1.headers.get("svix-id"), "svix-timestamp": req1.headers.get("svix-timestamp"), "svix-signature": req1.headers.get("svix-signature") };
  const res1 = await POST(new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json", ...h }, body: bodyStr }));
  const res2 = await POST(new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json", ...h }, body: bodyStr }));
  check("replay accepted both times (idempotent handler)", res1.status === 200 && res2.status === 200, `${res1.status}/${res2.status}`);
}

// 3. tampered body → 400
{
  const evt = makeEvent();
  const bodyStr = JSON.stringify(evt);
  const req = makeReq(bodyStr);
  const tampered = bodyStr.replace("email.bounced", "email.delivered");
  const res = await POST(new NextRequest(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": req.headers.get("svix-id"), "svix-timestamp": req.headers.get("svix-timestamp"), "svix-signature": req.headers.get("svix-signature") },
    body: tampered,
  }));
  check("tampered body → 400", res.status === 400, String(res.status));
}

// 4. wrong signing secret → 400
{
  const res = await POST(makeReq(JSON.stringify(makeEvent()), { wrongSecret: true }));
  check("wrong-secret signature → 400", res.status === 400, String(res.status));
}

// 5. missing svix headers → 400
{
  const res = await POST(makeReq(JSON.stringify(makeEvent()), { skipHeaders: true }));
  check("missing headers → 400", res.status === 400, String(res.status));
}

// 6. stale timestamp (10 min old → outside svix tolerance) → 400
{
  const res = await POST(makeReq(JSON.stringify(makeEvent()), { ts: new Date(Date.now() - 10 * 60 * 1000) }));
  check("stale timestamp replay → 400", res.status === 400, String(res.status));
}

// 7. unsubscribed event type (email.opened) → 200 ack, no RPC
{
  const before = received.length;
  const res = await POST(makeReq(JSON.stringify(makeEvent("email.opened"))));
  const j = await res.json();
  check("email.opened acked without RPC", res.status === 200 && j.handled === false && received.length === before, JSON.stringify(j));
}

// 8. complaint + suppression.* events forwarded
{
  for (const t of ["email.complained", "suppression.added", "suppression.removed"]) {
    const res = await POST(makeReq(JSON.stringify(makeEvent(t))));
    check(`${t} forwarded → 200`, res.status === 200, String(res.status));
  }
}

// 9. DB failure → 500 (so Resend retries)
{
  failMode = true;
  const res = await POST(makeReq(JSON.stringify(makeEvent())));
  check("RPC failure → 500 (Resend will retry)", res.status === 500, String(res.status));
  failMode = false;
}

// 10. GET → 200 liveness
{
  const res = await GET();
  const j = await res.json();
  check("GET liveness → 200", res.status === 200 && j.endpoint === "resend-webhook", JSON.stringify(j));
}

// 11. missing secret config → 500
{
  const saved = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  const res = await POST(makeReq(JSON.stringify(makeEvent())));
  check("unconfigured endpoint → 500 fail-loud", res.status === 500, String(res.status));
  process.env.RESEND_WEBHOOK_SECRET = saved;
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
