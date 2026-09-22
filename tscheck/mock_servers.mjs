// Stateful mock: PostgREST RPCs + Resend API, for edge-function integration tests.
import { createServer } from "node:http";

export const state = {
  leaseFree: true,
  leaseOwner: null,
  rows: [],            // queue rows returned by claim_email_batch (one-shot)
  precheck: { ok: true, suppressed: false, already_logged: false, rate_decision: "allow", daily_sends: 10, attempts: 1, max_attempts: 3 },
  results: [],         // captured email_send_result calls
  rpcCalls: [],        // every rpc name called
  resent: [],          // captured Resend sends
  resendMode: "ok",    // ok | 429 | 403suppressed | 500 | 422 | networkfail
  released: [],
  suppressed: new Set(),
};

export function resetState() {
  Object.assign(state, {
    leaseFree: true, leaseOwner: null, rows: [],
    precheck: { ok: true, suppressed: false, already_logged: false, rate_decision: "allow", daily_sends: 10, attempts: 1, max_attempts: 3 },
    results: [], rpcCalls: [], resent: [], resendMode: "ok", released: [],
    suppressed: new Set(),
  });
}

export async function startMocks() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(obj === undefined ? "" : JSON.stringify(obj));
      };
      // ---- Mock Resend ----
      if (req.url === "/emails") {
        const parsed = JSON.parse(body);
        state.resent.push(parsed);
        switch (state.resendMode) {
          case "429": return send(429, { statusCode: 429, message: "Too many requests" });
          case "403suppressed": return send(403, { statusCode: 403, message: "Recipient is on the suppression list" });
          case "500": return send(500, { statusCode: 500, message: "Internal error" });
          case "422": return send(422, { statusCode: 422, message: "Invalid recipient" });
          default: return send(200, { id: "resend_mock_" + Math.random().toString(36).slice(2, 10) });
        }
      }
      // ---- Mock PostgREST RPC ----
      const m = req.url.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
      if (!m) return send(404, { message: "not found: " + req.url });
      const fn = m[1];
      const args = body ? JSON.parse(body) : {};
      state.rpcCalls.push(fn);
      switch (fn) {
        case "acquire_drain_lease":
          if (state.leaseFree) { state.leaseFree = false; state.leaseOwner = args.p_owner; return send(200, true); }
          return send(200, false);
        case "release_drain_lease":
          state.released.push(args.p_owner); state.leaseFree = true;
          res.writeHead(204); return res.end();
        case "claim_email_batch": {
          const rows = state.rows; state.rows = [];   // one-shot
          return send(200, rows);
        }
        case "email_send_precheck": return send(200, state.precheck);
        case "email_send_result":
          state.results.push(args);
          return send(200, { ok: true, status: args.p_outcome === "sent" ? "sent" : "queued" });
        case "email_health_snapshot":
          return send(200, { queue: { queued: 3, processing: 0, sent: 42, dead: 1 }, daily_sends: 12, daily_soft_cap: 85, daily_hard_cap: 100, suppression_count: state.suppressed.size, enqueue_source: "trigger", edge_function_url_set: true, server_now: new Date().toISOString() });
        case "handle_db_webhook_event":
          return send(200, { handled: true, enqueued: 2 });
        case "enqueue_email":
          return send(200, "f47ac10b-58cc-4372-a567-0e02b2c3d479");
        case "email_is_suppressed":
          return send(200, state.suppressed.has(String(args.p_email).toLowerCase()));
        case "email_log_event":
          return send(200, true);
        case "scan_review_requests":
          return send(200, { considered: 5, enqueued: 5 });
        case "scan_booking_reminders":
          return send(200, { considered: 2, enqueued: 2 });
        default: return send(404, { message: "unknown rpc " + fn });
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}
