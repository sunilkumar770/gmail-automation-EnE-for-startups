// ============================================================================
// GoRentals — notify-lifecycle Supabase Edge Function v2 (Deno)
// ============================================================================
// Deploy:  supabase functions deploy notify-lifecycle --no-verify-jwt
// Secrets: supabase secrets set RESEND_API_KEY=re_xxx \
//            EMAIL_INTERNAL_SECRET=<same 32-byte hex as Vault entry> \
//            RESEND_FROM_EMAIL="GoRentals <bookings@gorentals.com>"
// Optional: RATE_RPS (default 2), RATE_BURST, APP_URL, RESEND_REPLY_TO,
//            RESEND_API_URL (testing/proxy), DRAIN_* tunables
//
// ACTIONS (POST, X-Internal-Secret or Bearer auth):
//   HEALTHCHECK    operational snapshot (queue, caps, lease, inbox backlog)
//   DRAIN_QUEUE    claim → validate → render(pinned version) → rate-gated
//                  send → record; also reconciles due UNKNOWN rows using the
//                  ORIGINAL provider idempotency key (ambiguous-outcome safety)
//   PROCESS_EVENTS best-effort trigger of the provider-event inbox processor
//                  (cron is the backstop; the webhook route also calls it)
//   SCAN_REVIEWS / SCAN_REMINDERS   campaign scans (idempotent)
//   DB_WEBHOOK     Supabase DB-webhook mode (only active when
//                  email_config.enqueue_source='webhook')
//   ENQUEUE        operator/system enqueue (Zod-validated, then SQL-validated)
//   TEST_SEND      direct render+send for setup verification (no outbox row)
//   TRACE          operator: full correlation chain for a logical event
//   REPLAY         operator: guarded dead-letter replay
//
// v2 GUARANTEES (see AUDIT.md / README.md):
//   * effectively-once LOGICAL sending: UNIQUE(logical_event_id) outbox +
//     atomic claim (FOR UPDATE SKIP LOCKED) + drain lease + attempt ledger
//     with idempotency-key reuse on reconciliation
//   * ambiguous provider results go UNKNOWN → reconciled, never blind-retried
//   * fail-closed auth; PII hashed in logs; payload schema-enforced
// ============================================================================

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  getTemplate,
  UnknownTemplateVersionError,
  type RenderContext,
} from "./lib/templates.ts";
import { validatePayload, type RenderPayload } from "./lib/schemas.ts";
import { sendViaResend } from "./lib/resend.ts";
import { TokenBucket } from "./lib/ratelimit.ts";
import { hashRecipient, logInfo, logWarn, logError } from "./lib/log.ts";

// ----------------------------------------------------------------------------
// Environment & constants
// ----------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
// Blueprint compatibility: WEBHOOK_SECRET is accepted as an alias name.
const INTERNAL_SECRET = Deno.env.get("EMAIL_INTERNAL_SECRET") ?? Deno.env.get("WEBHOOK_SECRET") ?? "";
const EMAIL_LOCALE = Deno.env.get("EMAIL_LOCALE") ?? "en-IN"; // GoRentals market default
const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") ?? "GoRentals <bookings@gorentals.com>";
const REPLY_TO = Deno.env.get("RESEND_REPLY_TO") ?? "";
const APP_URL = (Deno.env.get("APP_URL") ?? "https://gorentals.com").replace(/\/+$/, "");
// Overridable for staging/proxy/testability; defaults to the public Resend API.
const RESEND_API_URL = Deno.env.get("RESEND_API_URL") ?? "https://api.resend.com/emails";

const FN_VERSION = "2.0.0";
const DRAIN_BATCH_SIZE = Number(Deno.env.get("DRAIN_BATCH_SIZE") ?? 25);
const DRAIN_MAX_ROWS = Number(Deno.env.get("DRAIN_MAX_ROWS") ?? 500);
const DRAIN_TIME_BUDGET_MS = Number(Deno.env.get("DRAIN_TIME_BUDGET_MS") ?? 100_000);
const RESEND_TIMEOUT_MS = Number(Deno.env.get("RESEND_TIMEOUT_MS") ?? 20_000);
const LEASE_SECONDS = 240;

const RATE_RPS = Number(Deno.env.get("RATE_RPS") ?? 2);       // Resend free tier ≈ 2 rps
const RATE_BURST = Number(Deno.env.get("RATE_BURST") ?? 3);

const bucket = new TokenBucket({ rps: RATE_RPS, burst: RATE_BURST });

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", svc: "notify-lifecycle", event: "config_missing", detail: "SUPABASE_URL/SERVICE_ROLE_KEY absent" }));
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ----------------------------------------------------------------------------
// Types (SQL contracts — migration 001)
// ----------------------------------------------------------------------------
interface OutboxRow {
  id: string;
  logical_event_id: string;
  template_key: string;
  template_version: number;
  recipient: string;
  payload: RenderPayload;
  state: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  locked_at: string | null;
  locked_by: string | null;
  replay_count: number;
  created_at: string;
}

interface Prechecks {
  ok: boolean;
  suppressed?: boolean;
  rate_decision?: "allow" | "defer_day" | "defer_hour";
  daily_sends?: number;
  attempts?: number;
  max_attempts?: number;
  template_key?: string;
  template_version?: number;
  recipient?: string;
  payload?: RenderPayload;
  reconcile?: boolean;
  error?: string;
}

interface BeginSend {
  attempt_id: string;
  attempt_number: number;
  idempotency_key: string;
  reused_key: boolean;
}

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-internal-secret, authorization",
      "access-control-allow-methods": "POST, GET, OPTIONS",
    },
  });

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

async function rpc<T>(fn: string, params: Record<string, unknown>): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await supabase.rpc(fn, params);
  return { data: data as T | null, error: error ? `${error.message}${error.details ? " | " + error.details : ""}` : null };
}

async function transition(
  id: string, to: string, by: string, note: string, nextAttemptAt?: string,
): Promise<void> {
  const { error } = await rpc("email_outbox_transition", {
    p_id: id, p_to: to, p_by: by, p_note: note,
    p_next_attempt_at: nextAttemptAt ?? null,
  });
  if (error) logError({ event: "transition_failed", outbox_id: id, status: to, error_category: error });
}

// ----------------------------------------------------------------------------
// Per-row worker pipeline
// ----------------------------------------------------------------------------
type RowOutcome =
  | "sent" | "deferred" | "retry_wait" | "dead" | "unknown"
  | "suppressed" | "stop_429" | "skipped";

async function processOutboxRow(row: OutboxRow, workerId: string): Promise<RowOutcome> {
  const recipientHash = await hashRecipient(row.recipient);
  const baseLog = {
    logical_event_id: row.logical_event_id,
    outbox_id: row.id,
    recipient_hash: recipientHash,
    template: `${row.template_key}@${row.template_version}`,
  };

  // 1) DB-side prechecks (suppression re-check + rate decision)
  const pre = await rpc<Prechecks>("outbox_pre_send_checks", { p_outbox_id: row.id });
  if (pre.error || !pre.data?.ok) {
    logError({ event: "precheck_failed", ...baseLog, error_category: pre.error ?? "not found" });
    return "skipped"; // stale recovery will handle the CLAIMED row
  }
  const checks = pre.data;

  if (checks.suppressed) {
    await transition(row.id, "SUPPRESSED", workerId, "suppressed at send-time");
    logInfo({ event: "row_suppressed", ...baseLog });
    return "suppressed";
  }
  if (checks.rate_decision && checks.rate_decision !== "allow") {
    const minutes = checks.rate_decision === "defer_hour" ? 15 : 1440;
    const next = new Date(Date.now() + minutes * 60_000).toISOString();
    await transition(row.id, "QUEUED", workerId,
      `rate-limited (${checks.rate_decision}; daily_sends=${checks.daily_sends})`, next);
    logInfo({ event: "row_deferred", ...baseLog, status: checks.rate_decision, daily_sends: checks.daily_sends });
    return "deferred";
  }

  // 2) Payload validation (Zod — second layer after the SQL registry check)
  const templateKey = checks.template_key ?? row.template_key;
  const templateVersion = checks.template_version ?? row.template_version;
  const payload = (checks.payload ?? row.payload ?? {}) as RenderPayload;
  const validation = validatePayload(templateKey, payload);
  if (!validation.ok) {
    await transition(row.id, "DEAD", workerId, `payload invalid: ${validation.errors.join("; ").slice(0, 400)}`);
    logError({ event: "row_dead_invalid_payload", ...baseLog, error_category: "payload_validation" });
    return "dead";
  }

  // 3) Renderer for the PINNED version (never silently upgrades queued mail)
  let def;
  try {
    def = getTemplate(templateKey, templateVersion);
  } catch (err) {
    if (err instanceof UnknownTemplateVersionError) {
      await transition(row.id, "DEAD", workerId, err.message);
      logError({ event: "row_dead_no_renderer", ...baseLog, error_category: "renderer_missing" });
      return "dead";
    }
    throw err;
  }

  // 4) Marketing: obtain a signed unsubscribe token (HMAC in Postgres, key in Vault)
  let unsubUrl: string | null = null;
  if (def.category === "marketing") {
    const tok = await rpc<string>("email_unsub_token", { p_email: row.recipient, p_topic: "marketing" });
    if (tok.error || !tok.data) {
      logError({ event: "unsub_token_failed", ...baseLog, error_category: tok.error ?? "empty" });
      // Compliance note: render WITHOUT one-click headers rather than fail the
      // send; the mailto unsubscribe is still available via the footer policy.
    } else {
      unsubUrl = `${APP_URL}/api/unsubscribe?t=${encodeURIComponent(tok.data)}`;
    }
  }

  const ctx: RenderContext = { recipient: row.recipient, appUrl: APP_URL, locale: EMAIL_LOCALE, unsubUrl };
  let rendered;
  try {
    rendered = def.render(validation.data, ctx);
  } catch (err) {
    await transition(row.id, "DEAD", workerId, `render failed: ${(err as Error)?.message}`);
    logError({ event: "row_dead_render", ...baseLog, error_category: "render_error" });
    return "dead";
  }

  // 5) Open the attempt (ledger row + idempotency key; reuse on reconcile)
  const begin = await rpc<BeginSend>("outbox_begin_send", { p_outbox_id: row.id, p_worker_id: workerId });
  if (begin.error || !begin.data) {
    logError({ event: "begin_send_failed", ...baseLog, error_category: begin.error ?? "empty" });
    return "skipped"; // CLAIMED row → stale recovery
  }
  const attempt = begin.data;

  // 6) Provider call behind the token bucket
  try {
    await bucket.take();
  } catch (err) {
    logWarn({ event: "rate_wait_exceeded", ...baseLog, error_category: (err as Error)?.message });
    // attempt already open → leave SENDING; stale recovery marks UNKNOWN
    return "skipped";
  }

  const tags = [
    { name: "logical_event_id", value: row.logical_event_id.slice(0, 100) },
    { name: "template", value: `${templateKey}@${templateVersion}` },
  ];
  if (payload.booking_id) tags.push({ name: "booking_id", value: String(payload.booking_id) });

  const outcome = await sendViaResend(
    RESEND_API_URL, RESEND_API_KEY,
    {
      from: FROM_EMAIL, to: row.recipient,
      subject: rendered.subject, html: rendered.html, text: rendered.text,
      replyTo: REPLY_TO || undefined, headers: rendered.headers,
      tags, idempotencyKey: attempt.idempotency_key,
    },
    RESEND_TIMEOUT_MS,
  );

  // 7) Record the outcome atomically (attempt + state + audit)
  const resultParams: Record<string, unknown> = {
    p_outbox_id: row.id,
    p_attempt_id: attempt.attempt_id,
  };
  let result: RowOutcome;
  if (outcome.kind === "accepted") {
    result = "sent";
    Object.assign(resultParams, {
      p_outcome: "accepted", p_provider_email_id: outcome.id,
      p_response_metadata: { status: 200, latency_ms: outcome.latencyMs, subject: rendered.subject },
    });
  } else {
    const meta = { status: outcome.status, latency_ms: outcome.latencyMs, code: outcome.code };
    if (outcome.cls === "ambiguous") {
      result = "unknown";
      Object.assign(resultParams, { p_outcome: "unknown", p_error_code: outcome.code, p_error_message: outcome.message, p_response_metadata: meta });
    } else if (outcome.cls === "retryable") {
      result = outcome.code === "rate_limited" ? "stop_429" : "retry_wait";
      Object.assign(resultParams, { p_outcome: "failed_retryable", p_error_code: outcome.code, p_error_message: outcome.message, p_response_metadata: meta });
    } else {
      result = "dead";
      Object.assign(resultParams, { p_outcome: "failed_permanent", p_error_code: outcome.code, p_error_message: outcome.message, p_response_metadata: meta });
      if (outcome.cls === "provider_suppressed") {
        await rpc("email_apply_suppression", {
          p_email: row.recipient, p_source: "resend", p_reason: "suppressed",
          p_detail: { outbox_id: row.id, code: outcome.code },
        });
      }
    }
  }
  const rec = await rpc<{ status?: string }>("outbox_record_result", resultParams);
  if (rec.error) {
    logError({ event: "record_result_failed", ...baseLog, attempt: attempt.attempt_number, error_category: rec.error });
    // Provider state is now ambiguous from the DB's perspective; stale recovery
    // will mark the attempt UNKNOWN and reconcile via the same key. No blind retry here.
    return "skipped";
  }

  if (outcome.kind === "failure" && outcome.cls === "retryable" && outcome.code === "rate_limited") {
    bucket.pause(outcome.retryAfterSec ?? 30);
  }

  logInfo({
    event: "send_result", ...baseLog,
    attempt: attempt.attempt_number,
    attempt_id: attempt.attempt_id,
    provider: "resend",
    provider_email_id: outcome.kind === "accepted" ? outcome.id : undefined,
    status: rec.data?.status ?? result,
    latency_ms: outcome.latencyMs,
    error_category: outcome.kind === "failure" ? outcome.code : undefined,
    reconciled: attempt.reused_key || undefined,
  });
  return result;
}

// ----------------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------------
async function actionHealthcheck(): Promise<Response> {
  const snap = await rpc<Record<string, unknown>>("email_health_snapshot", {});
  if (snap.error) return json({ ok: false, error: snap.error }, 500);
  return json({
    ok: true, service: "notify-lifecycle", version: FN_VERSION,
    rate_limiter: { rps: RATE_RPS, burst: RATE_BURST, available_tokens: bucket.available(), paused_until: bucket.pausedUntilTimestamp },
    ...snap.data,
  });
}

async function actionDrainQueue(): Promise<Response> {
  const workerId = `edge-${crypto.randomUUID().slice(0, 8)}`;
  const lease = await rpc<boolean>("acquire_drain_lease", { p_seconds: LEASE_SECONDS, p_owner: workerId });
  if (lease.error) return json({ ok: false, error: `lease: ${lease.error}` }, 500);
  if (lease.data !== true) {
    return json({ ok: true, skipped: "another drain is in progress (lease held)" });
  }

  const stats: Record<string, number | string | null> = {
    claimed: 0, sent: 0, deferred: 0, retry_wait: 0, dead: 0,
    unknown: 0, suppressed: 0, skipped: 0, released_unprocessed: 0, stopped_early: null,
  };
  const started = Date.now();
  try {
    const deadline = started + DRAIN_TIME_BUDGET_MS;
    outer:
    while (Date.now() < deadline && (stats.claimed as number) < DRAIN_MAX_ROWS) {
      const batch = await rpc<OutboxRow[]>("claim_outbox_batch", {
        p_batch_size: DRAIN_BATCH_SIZE, p_worker_id: workerId,
      });
      if (batch.error) { stats.stopped_early = `claim: ${batch.error}`; break; }
      const rows = batch.data ?? [];
      if (rows.length === 0) break;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        stats.claimed = (stats.claimed as number) + 1;
        let outcome: RowOutcome = "skipped";
        try {
          outcome = await processOutboxRow(row, workerId);
        } catch (err) {
          logError({
            event: "row_exception", outbox_id: row.id, logical_event_id: row.logical_event_id,
            error_category: (err as Error)?.message ?? String(err),
          });
          // leave CLAIMED/SENDING → stale recovery decides QUEUED vs UNKNOWN
        }
        if (outcome !== "skipped") stats[outcome === "stop_429" ? "retry_wait" : outcome] =
          ((stats[outcome === "stop_429" ? "retry_wait" : outcome] as number) ?? 0) + 1;

        const stopping = outcome === "stop_429" ? "provider 429 — bucket paused"
          : Date.now() >= deadline ? "time budget exhausted" : null;
        if (stopping) {
          // Proactively RELEASE rows claimed in this batch but not yet processed,
          // so they don't idle in CLAIMED until stale recovery (no attempt was
          // consumed — CLAIMED→QUEUED is free).
          for (const rest of rows.slice(i + 1)) {
            await transition(rest.id, "QUEUED", workerId, `released: ${stopping}`,
              new Date(Date.now() + 5_000).toISOString());
            stats.released_unprocessed = ((stats.released_unprocessed as number) ?? 0) + 1;
          }
          stats.stopped_early = stopping;
          break outer;
        }
      }
      if (rows.length < DRAIN_BATCH_SIZE) break;
    }
  } finally {
    await rpc("release_drain_lease", { p_owner: workerId });
  }

  const result = { ok: true, action: "DRAIN_QUEUE", worker: workerId, duration_ms: Date.now() - started, ...stats };
  logInfo({ event: "drain_complete", ...result });
  return json(result);
}

async function actionProcessEvents(limit = 500): Promise<Response> {
  const r = await rpc<Record<string, number>>("process_provider_events", { p_limit: limit });
  if (r.error) return json({ ok: false, error: r.error }, 500);
  return json({ ok: true, action: "PROCESS_EVENTS", ...r.data });
}

async function actionScan(which: "reviews" | "reminders"): Promise<Response> {
  const r = await rpc<Record<string, unknown>>(
    which === "reviews" ? "scan_review_requests" : "scan_booking_reminders",
    which === "reviews" ? { p_days_after: 3 } : { p_days_before: 1 },
  );
  if (r.error) return json({ ok: false, error: r.error }, 500);
  return json({ ok: true, action: which === "reviews" ? "SCAN_REVIEWS" : "SCAN_REMINDERS", ...r.data });
}

async function actionDbWebhook(event: Record<string, unknown>): Promise<Response> {
  const r = await rpc<Record<string, unknown>>("handle_db_webhook_event", { p_event: event });
  if (r.error) return json({ ok: false, error: r.error }, 500);
  return json({ ok: true, ...r.data }); // 200 even when inert — no retry storms
}

async function actionEnqueue(body: Record<string, unknown>): Promise<Response> {
  const template = String(body.template ?? "");
  const recipient = String(body.recipient ?? "");
  if (!template || !recipient) return json({ ok: false, error: "template and recipient are required" }, 400);

  // Zod gate BEFORE hitting the DB (spec §18: validate before enqueue)
  const v = validatePayload(template, body.payload ?? {});
  if (!v.ok) return json({ ok: false, error: "payload validation failed", details: v.errors }, 422);

  const r = await rpc<Record<string, unknown>>("enqueue_email_v2", {
    p_template_key: template,
    p_recipient: recipient,
    p_payload: v.data as Record<string, unknown>,
    p_priority: body.priority != null ? Number(body.priority) : null,
    p_logical_event_id: typeof body.logical_event_id === "string" ? body.logical_event_id : null,
  });
  if (r.error) return json({ ok: false, error: r.error }, 500);
  return json({ ok: true, ...r.data });
}

async function actionTestSend(body: Record<string, unknown>): Promise<Response> {
  const to = String(body.to ?? "").toLowerCase().trim();
  if (!to.includes("@")) return json({ ok: false, error: "valid 'to' address required" }, 400);
  const template = String(body.template ?? "booking_confirmation");
  const version = Number(body.version ?? 1);

  const supp = await rpc<boolean>("email_is_suppressed", { p_email: to });
  if (supp.data === true) return json({ ok: false, error: "recipient is suppressed" }, 422);

  let def;
  try {
    def = getTemplate(template, version);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 400);
  }

  const sample: RenderPayload = (body.payload as RenderPayload) ?? {
    user_id: crypto.randomUUID(),
    name: "Test",
    booking_id: crypto.randomUUID(),
    listing_title: "Beachfront Camper Van (TEST)",
    renter_name: "Test",
    owner_name: "Olivia",
    starts_at: new Date(Date.now() + 86_400_000).toISOString(),
    ends_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    amount: 250, currency: "USD", timezone: "UTC",
    campaign: "test",
  };
  const v = validatePayload(template, sample);
  if (!v.ok) return json({ ok: false, error: "payload validation failed", details: v.errors }, 422);

  let unsubUrl: string | null = null;
  if (def.category === "marketing") {
    const tok = await rpc<string>("email_unsub_token", { p_email: to, p_topic: "marketing" });
    if (tok.data) unsubUrl = `${APP_URL}/api/unsubscribe?t=${encodeURIComponent(tok.data)}`;
  }
  const rendered = def.render(v.data, { recipient: to, appUrl: APP_URL, locale: EMAIL_LOCALE, unsubUrl });

  await bucket.take().catch(() => undefined);
  const outcome = await sendViaResend(RESEND_API_URL, RESEND_API_KEY, {
    from: FROM_EMAIL, to, subject: `[TEST] ${rendered.subject}`,
    html: rendered.html, text: rendered.text, replyTo: REPLY_TO || undefined,
    headers: rendered.headers,
    tags: [{ name: "category", value: "test" }, { name: "template", value: `${template}@${version}` }],
    idempotencyKey: `gorentals-test-${crypto.randomUUID()}`,
  }, RESEND_TIMEOUT_MS);

  if (outcome.kind !== "accepted") {
    return json({ ok: false, cls: outcome.cls, code: outcome.code, status: outcome.status, error: outcome.message }, 502);
  }
  // best-effort audit into the legacy log (deduped; harmless on repeats)
  await rpc("email_log_event", {
    p_booking_id: null, p_template: `test_send:${template}@${version}`, p_recipient: to,
    p_status_event: "accepted", p_resend_email_id: outcome.id,
    p_subject: `[TEST] ${rendered.subject}`, p_detail: { via: "TEST_SEND" },
  });
  logInfo({ event: "test_send", template: `${template}@${version}`, recipient_hash: await hashRecipient(to), provider_email_id: outcome.id });
  return json({ ok: true, resend_email_id: outcome.id, to, template, version });
}

async function actionTrace(body: Record<string, unknown>): Promise<Response> {
  const r = await rpc<Record<string, unknown>>("email_trace", {
    p_logical_event_id: typeof body.logical_event_id === "string" ? body.logical_event_id : null,
    p_outbox_id: typeof body.outbox_id === "string" ? body.outbox_id : null,
  });
  if (r.error) return json({ ok: false, error: r.error }, 500);
  return json({ ok: true, ...r.data });
}

async function actionReplay(body: Record<string, unknown>): Promise<Response> {
  const id = String(body.outbox_id ?? "");
  if (!id) return json({ ok: false, error: "outbox_id required" }, 400);
  const r = await rpc<Record<string, unknown>>("email_replay", {
    p_outbox_id: id, p_note: String(body.note ?? "operator replay via edge fn"),
  });
  if (r.error) return json({ ok: false, error: r.error }, 409);
  logWarn({ event: "replay_requested", outbox_id: id, status: "QUEUED" });
  return json({ ok: true, ...r.data });
}

// ----------------------------------------------------------------------------
// HTTP router (fail-closed auth)
// ----------------------------------------------------------------------------
const VALID_ACTIONS = new Set([
  "HEALTHCHECK", "DRAIN_QUEUE", "PROCESS_EVENTS", "SCAN_REVIEWS", "SCAN_REMINDERS",
  "DB_WEBHOOK", "ENQUEUE", "TEST_SEND", "TRACE", "REPLAY",
]);

function detectDbWebhook(body: unknown): string | null {
  if (body && typeof body === "object" && "table" in body && "record" in body && "type" in body) {
    return "DB_WEBHOOK";
  }
  return null;
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return json({ ok: true }, 204);
  if (req.method === "GET") {
    return json({ ok: true, service: "notify-lifecycle", version: FN_VERSION, time: new Date().toISOString() });
  }
  if (req.method !== "POST") return json({ ok: false, error: "use POST" }, 405);

  if (!INTERNAL_SECRET) {
    return json({ ok: false, error: "EMAIL_INTERNAL_SECRET not configured" }, 503);
  }

  // Bound the request body (DoS guard) — 1 MB is generous for JSON commands.
  const MAX_BODY = 1_048_576;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
    return json({ ok: false, error: "payload too large" }, 413);
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: "payload too large" }, 413);

  let body: Record<string, unknown> | null = null;
  try {
    body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
  } catch {
    body = null;
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const provided =
    req.headers.get("x-internal-secret") ??
    req.headers.get("x-webhook-secret") ??   // blueprint alias header
    (authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : null);
  if (!provided || !timingSafeEqual(provided, INTERNAL_SECRET)) {
    return json({ ok: false, error: "invalid or missing internal secret" }, 401);
  }

  // action resolution: explicit `action` → blueprint-style {"type":"HEALTHCHECK"}
  // (only when it names a known action; DB-webhook `type` values are INSERT/
  // UPDATE/DELETE and fall through to detectDbWebhook) → query param → shape.
  const typeAlias = typeof body?.type === "string" && VALID_ACTIONS.has(body.type.toUpperCase())
    ? body.type.toUpperCase() : undefined;
  const action = String(
    (body?.action as string | undefined) ??
    typeAlias ??
    url.searchParams.get("action") ??
    detectDbWebhook(body) ??
    "",
  ).toUpperCase();

  switch (action) {
    case "HEALTHCHECK":     return await actionHealthcheck();
    case "DRAIN_QUEUE":     return await actionDrainQueue();
    case "PROCESS_EVENTS":  return await actionProcessEvents(Number(body?.limit ?? 500));
    case "SCAN_REVIEWS":    return await actionScan("reviews");
    case "SCAN_REMINDERS":  return await actionScan("reminders");
    case "DB_WEBHOOK":      return await actionDbWebhook((body ?? {}) as Record<string, unknown>);
    case "ENQUEUE":         return await actionEnqueue((body ?? {}) as Record<string, unknown>);
    case "TEST_SEND":       return await actionTestSend((body ?? {}) as Record<string, unknown>);
    case "TRACE":           return await actionTrace((body ?? {}) as Record<string, unknown>);
    case "REPLAY":          return await actionReplay((body ?? {}) as Record<string, unknown>);
    default:
      return json({
        ok: false, error: `unknown action '${action}'`,
        valid_actions: ["HEALTHCHECK", "DRAIN_QUEUE", "PROCESS_EVENTS", "SCAN_REVIEWS", "SCAN_REMINDERS",
                        "DB_WEBHOOK", "ENQUEUE", "TEST_SEND", "TRACE", "REPLAY"],
      }, 400);
  }
}

Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000) }, async (req: Request): Promise<Response> => {
  try {
    return await handleRequest(req);
  } catch (err) {
    logError({ event: "unhandled", error_category: (err as Error)?.message ?? String(err) });
    return json({ ok: false, error: "internal error" }, 500); // never leak internals
  }
});
