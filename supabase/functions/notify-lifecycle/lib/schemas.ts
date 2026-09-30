// ============================================================================
// lib/schemas.ts — Zod payload schemas (TS mirror of email_templates.payload_schema)
// ============================================================================
// Master spec §18: explicit schemas, validated BEFORE enqueue (worker ENQUEUE
// action) and AGAIN before rendering (drain path). The SQL registry remains
// the source of truth for trigger-driven enqueues; these schemas protect the
// HTTP-driven paths and give typed payloads to renderers.

import { z } from "npm:zod@3";

const isoDatetime = z.string().regex(
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/,
  "ISO-8601 datetime expected",
);
const uuid = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "uuid expected");
const money = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/)]);
const currency = z.string().regex(/^[A-Za-z]{3}$/, "ISO-4217 code expected");
const tzName = z.string().min(1).max(64);
/** CTA/deep-link URLs from payloads: https only (never javascript:/mailto:/data:). */
const httpsUrl = z.string().max(2000).refine((u) => /^https:\/\/[^\s"'<>]+$/i.test(u), "https:// URL expected");
const dedupeKey = z.string().min(1).max(120);
const personName = z.string().max(200).nullish();

const bookingCore = {
  booking_id: uuid,
  listing_title: z.string().max(300).nullish(),
  city: z.string().max(120).nullish(),
  renter_name: z.string().max(200).nullish(),
  owner_name: z.string().max(200).nullish(),
  starts_at: isoDatetime.nullish(),
  ends_at: isoDatetime.nullish(),
  amount: money.nullish(),
  currency: currency.nullish(),
  timezone: tzName.nullish(),
};

export const PAYLOAD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  booking_confirmation:      z.object(bookingCore),
  booking_host_confirmation: z.object(bookingCore),
  booking_request_owner:     z.object(bookingCore),
  booking_cancelled_renter:  z.object(bookingCore),
  booking_cancelled_owner:   z.object(bookingCore),
  booking_reminder:          z.object({ ...bookingCore, starts_at: isoDatetime }),
  access_instructions:       z.object(bookingCore),
  review_request:            z.object(bookingCore),
  refund_issued: z.object({
    refund_id: uuid,
    booking_id: uuid.nullish(),
    amount: money,                       // required: a refund email without amount is corrupt
    currency: currency.nullish(),
    renter_name: z.string().max(200).nullish(),
    listing_title: z.string().max(300).nullish(),
  }),
  win_back: z.object({
    campaign: z.string().min(1).max(40), // e.g. "2026-09" / "WB30-2026-W39" — scopes the logical id
    renter_name: z.string().max(200).nullish(),
    user_id: uuid.nullish(),
  }),
  welcome: z.object({
    user_id: uuid,
    name: z.string().max(200).nullish(),
    renter_name: z.string().max(200).nullish(),
  }),

  // ---------------------------------------------------------------------
  // v3 catalog (migration 003): auth · KYC · refund lifecycle · payments
  // ---------------------------------------------------------------------
  otp: z.object({
    user_id: uuid.nullish(),
    dedupe_key: dedupeKey,               // challenge id — scopes the logical id
    otp_code: z.string().regex(/^[A-Za-z0-9]{4,10}$/, "4-10 alphanumeric characters expected"),
    expiry_minutes: z.number().int().min(1).max(1440).nullish(),
    action_type: z.string().max(120).nullish(),
    name: personName,
    renter_name: personName,
    // App-layer hook (renderer ignores): when the email is suppressed/bounced,
    // the caller may deliver the same challenge over SMS. Keeps the fallback
    // decision with the business layer — the outbox stays email-only.
    fallback_sms: z.boolean().nullish(),
  }),
  kyc_submitted: z.object({
    dedupe_key: dedupeKey,               // verification (attempt) id
    user_id: uuid.nullish(),
    name: personName,
    renter_name: personName,
    document_type: z.string().max(120).nullish(),
    cta_url: httpsUrl.nullish(),
  }),
  kyc_approved: z.object({
    dedupe_key: dedupeKey,
    user_id: uuid.nullish(),
    name: personName,
    renter_name: personName,
    document_type: z.string().max(120).nullish(),
    cta_url: httpsUrl.nullish(),
  }),
  kyc_rejected: z.object({
    dedupe_key: dedupeKey,
    user_id: uuid.nullish(),
    // required: a rejection without a reason is not actionable for the user
    reason: z.string().min(1).max(600),
    name: personName,
    renter_name: personName,
    document_type: z.string().max(120).nullish(),
    cta_url: httpsUrl.nullish(),
  }),
  kyc_doc_expiring: z.object({
    dedupe_key: dedupeKey,               // document id
    campaign: z.string().min(1).max(40),   // scan cycle — scopes the logical id (like win_back)
    user_id: uuid.nullish(),
    name: personName,
    renter_name: personName,
    document_type: z.string().max(120).nullish(),
    expiry_date: isoDatetime.nullish(),
    timezone: tzName.nullish(),
    cta_url: httpsUrl.nullish(),
  }),
  refund_initiated: z.object({
    refund_id: uuid,
    booking_id: uuid.nullish(),
    amount: money,                         // required: same corruption rule as refund_issued
    currency: currency.nullish(),
    renter_name: personName,
    listing_title: z.string().max(300).nullish(),
    payment_method: z.string().max(120).nullish(),
    eta_days: z.string().max(40).nullish(),
  }),
  refund_failed: z.object({
    refund_id: uuid,
    booking_id: uuid.nullish(),
    amount: money.nullish(),
    currency: currency.nullish(),
    reason: z.string().max(600).nullish(),
    renter_name: personName,
    listing_title: z.string().max(300).nullish(),
  }),
  deposit_released: z.object({
    booking_id: uuid,
    amount: money,
    currency: currency.nullish(),
    renter_name: personName,
    listing_title: z.string().max(300).nullish(),
    deductions: z.string().max(600).nullish(),
    eta_days: z.string().max(40).nullish(),
  }),
  payment_receipt: z.object({
    dedupe_key: dedupeKey,               // payment intent / charge id
    amount: money,
    currency: currency.nullish(),
    renter_name: personName,
    booking_id: uuid.nullish(),
    listing_title: z.string().max(300).nullish(),
    invoice_id: z.string().max(80).nullish(),
    // signed, time-limited invoice PDF link minted by the app (decision:
    // link over attachment — smaller outbox rows, download analytics)
    invoice_url: httpsUrl.nullish(),
    payment_method: z.string().max(120).nullish(),
    date: isoDatetime.nullish(),
    timezone: tzName.nullish(),
  }),
  payment_failed: z.object({
    dedupe_key: dedupeKey,
    amount: money.nullish(),
    currency: currency.nullish(),
    reason: z.string().max(600).nullish(),
    renter_name: personName,
    booking_id: uuid.nullish(),
    listing_title: z.string().max(300).nullish(),
    retry_url: httpsUrl.nullish(),
  }),
};

/** Typed view renderers receive (all fields already validated/normalized). */
export interface RenderPayload {
  booking_id?: string;
  refund_id?: string;
  user_id?: string;
  name?: string | null;
  listing_title?: string | null;
  city?: string | null;
  renter_name?: string | null;
  owner_name?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  timezone?: string | null;
  campaign?: string;
  // v3 catalog fields (migration 003)
  dedupe_key?: string | null;
  otp_code?: string | null;
  expiry_minutes?: number | null;
  action_type?: string | null;
  document_type?: string | null;
  expiry_date?: string | null;
  reason?: string | null;
  cta_url?: string | null;
  eta_days?: string | null;
  payment_method?: string | null;
  deductions?: string | null;
  invoice_id?: string | null;
  invoice_url?: string | null;
  retry_url?: string | null;
  date?: string | null;
  fallback_sms?: boolean | null;
  [k: string]: unknown;
}

export type SchemaResult =
  | { ok: true; data: RenderPayload }
  | { ok: false; errors: string[] };

/** Validate + normalize. Unknown templates fail CLOSED (no free-form sends). */
export function validatePayload(templateKey: string, payload: unknown): SchemaResult {
  const schema = PAYLOAD_SCHEMAS[templateKey];
  if (!schema) return { ok: false, errors: [`no schema registered for template '${templateKey}'`] };
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, data: parsed.data as RenderPayload };
}
