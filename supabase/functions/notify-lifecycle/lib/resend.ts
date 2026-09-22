// ============================================================================
// lib/resend.ts — Resend REST client with explicit outcome taxonomy
// ============================================================================
// Outcomes map 1:1 onto outbox_record_result:
//   accepted            → provider returned 200 + id
//   failure(retryable)  → 429 / 5xx            → RETRY_WAIT + backoff
//   failure(permanent)  → 400/401/404/422/403  → DEAD
//   failure(suppressed) → 403 suppression      → DEAD + mirror suppression
//   ambiguous           → timeout/network/408/200-without-id → UNKNOWN
//                         (reconciled later by re-POSTing the SAME
//                          Idempotency-Key — see outbox_begin_send key reuse)

import { classifyProviderFailure, type FailureClass } from "./retry.ts";

export interface ResendMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
  idempotencyKey: string;
}

export type ResendOutcome =
  | { kind: "accepted"; id: string; latencyMs: number }
  | {
      kind: "failure";
      cls: FailureClass;
      code: string;
      status: number | null;
      message: string;
      latencyMs: number;
      retryAfterSec?: number;
    };

export async function sendViaResend(
  apiUrl: string,
  apiKey: string,
  msg: ResendMessage,
  timeoutMs = 20_000,
): Promise<ResendOutcome> {
  const started = Date.now();
  if (!apiKey) {
    return {
      kind: "failure", cls: "permanent", code: "config_missing_api_key", status: null,
      message: "RESEND_API_KEY not configured on this edge function", latencyMs: 0,
    };
  }

  const body: Record<string, unknown> = {
    from: msg.from,
    to: [msg.to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text, // multipart/alternative plain-text part: deliverability + accessibility
    headers: { "X-Entity-Ref-ID": msg.idempotencyKey, ...(msg.headers ?? {}) },
  };
  if (msg.replyTo) body.reply_to = msg.replyTo;
  if (msg.tags && msg.tags.length) body.tags = msg.tags;

  let res: Response;
  try {
    res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        // Provider-side replay guard. Stable per logical attempt; reused verbatim
        // on reconciliation so an ambiguous timeout can never double-send.
        "Idempotency-Key": msg.idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    const c = classifyProviderFailure(null, "", { networkError: true });
    return {
      kind: "failure", cls: c.cls, code: isTimeout ? "client_timeout" : c.code,
      status: null, message: (e?.message ?? String(err)).slice(0, 400),
      latencyMs: Date.now() - started,
    };
  }

  const latencyMs = Date.now() - started;
  const raw = (await res.text().catch(() => "")).slice(0, 2000);

  if (res.ok) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.id === "string" && parsed.id) {
        return { kind: "accepted", id: parsed.id, latencyMs };
      }
    } catch {
      // fall through → ambiguous (200 without parseable id)
    }
    return {
      kind: "failure", cls: "ambiguous", code: "malformed_success", status: res.status,
      message: "200 without usable id — treating as ambiguous", latencyMs,
    };
  }

  const c = classifyProviderFailure(res.status, raw, {
    retryAfterHeader: res.headers.get("retry-after"),
  });
  return {
    kind: "failure", cls: c.cls, code: c.code, status: res.status,
    message: ("Resend " + res.status + ": " + raw).slice(0, 500),
    latencyMs, retryAfterSec: c.retryAfterSec,
  };
}
