// ============================================================================
// lib/log.ts — Structured, PII-safe logging
// ============================================================================
// Master spec §29: every log line is JSON with correlation fields; recipients
// appear ONLY as salted hashes; secrets/tokens/full bodies are never logged.

const HASH_SALT = "gorentals-email-log-v1"; // fixed salt: stable correlation, still one-way

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  event: string;
  logical_event_id?: string;
  outbox_id?: string;
  attempt?: number;
  attempt_id?: string;
  template?: string;          // "key@version"
  recipient_hash?: string;
  provider?: string;
  provider_email_id?: string;
  provider_event_id?: string;
  status?: string;
  latency_ms?: number;
  error_category?: string;
  [k: string]: unknown;
}

/** sha256(salt|lower(email)) → first 16 hex chars. One-way, stable, non-PII. */
export async function hashRecipient(email: string): Promise<string> {
  const data = new TextEncoder().encode(HASH_SALT + "|" + String(email).toLowerCase().trim());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Redact anything that looks like a secret/token/authorization material. */
export function redact(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .replace(/(re_)[A-Za-z0-9_-]{6,}/g, "$1***")               // resend keys
    .replace(/(whsec_)[A-Za-z0-9+/=_-]{6,}/g, "$1***")          // webhook secrets
    .replace(/(eyJ)[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "jwt***") // JWTs
    .replace(/\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "unsub-token***");
}

export function log(level: LogLevel, fields: LogFields): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) safe[k] = redact(v);
  const line = JSON.stringify({ ts: new Date().toISOString(), level, svc: "notify-lifecycle", ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logInfo = (f: LogFields) => log("info", f);
export const logWarn = (f: LogFields) => log("warn", f);
export const logError = (f: LogFields) => log("error", f);
