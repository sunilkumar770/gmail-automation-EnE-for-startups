// ============================================================================
// lib/retry.ts — Failure classification + backoff policy
// ============================================================================
// Classification drives outbox_record_result outcomes:
//   retryable  → RETRY_WAIT (backoff schedule, DEAD after max_attempts)
//   permanent  → DEAD immediately (invalid recipient/request/auth/template)
//   ambiguous  → UNKNOWN (provider MAY have accepted — reconcile with the
//                SAME idempotency key; NEVER blind-retry, §6 master spec)
//   suppressed → DEAD + mirror into email_suppressions (source='resend')

export type FailureClass = "retryable" | "permanent" | "ambiguous" | "provider_suppressed";

export interface FailureClassification {
  cls: FailureClass;
  code: string;
  retryAfterSec?: number;
}

/** Backoff schedule (minutes) by attempt number — mirrored in SQL email_backoff_next
 *  ([1m, 5m, 15m, 1h, 6h] ±20% jitter). Documented here for operators. */
export const BACKOFF_SCHEDULE_MINUTES = [1, 5, 15, 60, 360] as const;
export const DEFAULT_MAX_ATTEMPTS = 5;

export function backoffMinutesFor(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 1), BACKOFF_SCHEDULE_MINUTES.length) - 1;
  return BACKOFF_SCHEDULE_MINUTES[idx];
}

/**
 * Classify a provider interaction result.
 * @param status     HTTP status (null when the request never completed)
 * @param bodyText   raw response body (already truncated by caller)
 * @param networkError true for fetch throw / timeout / connection reset
 */
export function classifyProviderFailure(
  status: number | null,
  bodyText: string,
  opts: { networkError?: boolean; retryAfterHeader?: string | null } = {},
): FailureClassification {
  if (opts.networkError || status === null) {
    // The provider may or may not have accepted the message. This is the
    // textbook ambiguous outcome — reconcile, do not blind-retry.
    return { cls: "ambiguous", code: "network_error" };
  }
  if (status === 429) {
    const ra = parseRetryAfter(opts.retryAfterHeader);
    return { cls: "retryable", code: "rate_limited", retryAfterSec: ra };
  }
  if (status === 408) {
    // Request timeout: a proxy may have forwarded it — treat as ambiguous.
    return { cls: "ambiguous", code: "request_timeout" };
  }
  if (status >= 500 && status <= 599) {
    return { cls: "retryable", code: `server_error_${status}` };
  }
  const lower = bodyText.toLowerCase();
  if (status === 403) {
    if (lower.includes("suppress")) {
      return { cls: "provider_suppressed", code: "recipient_suppressed_by_provider" };
    }
    return { cls: "permanent", code: "forbidden" };
  }
  if (status === 401) return { cls: "permanent", code: "auth_failed" };
  if (status === 400 || status === 404 || status === 422) {
    return { cls: "permanent", code: `client_error_${status}` };
  }
  // Unknown 4xx: non-retryable by default (retrying cannot fix a rejection)
  return { cls: "permanent", code: `unclassified_${status}` };
}

export function parseRetryAfter(header?: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 3600);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.min((date - Date.now()) / 1000, 3600));
  return undefined;
}
