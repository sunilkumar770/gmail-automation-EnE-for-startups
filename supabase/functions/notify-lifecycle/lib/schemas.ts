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
