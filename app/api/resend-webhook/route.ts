// ============================================================================
// GoRentals — Resend webhook receiver v2 (Next.js App Router)
// Path: app/api/resend-webhook/route.ts
// ============================================================================
// v2 architecture (AUDIT P0-6 fix): PERSIST-FIRST durable inbox.
//
//   1. Verify Svix signature on the RAW body (tamper/replay protection)
//   2. Bound payload size (DoS guard)
//   3. Persist to email_provider_events via email_provider_event_ingest()
//      — UNIQUE(provider, provider_event_id): duplicates (even concurrent)
//        collapse to one row and still return 200
//   4. Return 200 as soon as the event is DURABLE
//   5. Best-effort inline processing (process_provider_events); on failure the
//      pg_cron backstop (*/2 min) reprocesses — nothing is ever lost and the
//      endpoint never depends on send-result rows already existing.
//
// ENV: RESEND_WEBHOOK_SECRET (whsec_…), NEXT_PUBLIC_SUPABASE_URL,
//      SUPABASE_SERVICE_ROLE_KEY   ·  DEPS: npm i svix
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { callRpc, supabaseEnv } from "../../../lib/supabase-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024; // Resend payloads are a few KB; hard DoS bound

interface IngestResult {
  inserted?: boolean;
  duplicate?: boolean;
  provider_event_id?: string;
  event_type?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ---- 1. Configuration guard (fail loudly) ----
  const signingSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!signingSecret) {
    console.error("[resend-webhook] RESEND_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "webhook endpoint not configured" }, { status: 500 });
  }
  if (!supabaseEnv()) {
    console.error("[resend-webhook] Supabase env vars missing");
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }

  // ---- 2. Size bound BEFORE reading/verifying (cheap reject) ----
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  // ---- 3. STRICT Svix verification on the raw bytes ----
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "missing signature headers" }, { status: 400 });
  }
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let event: { type?: string; created_at?: string; data?: Record<string, unknown> };
  try {
    event = new Webhook(signingSecret).verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as typeof event;
  } catch (err) {
    // Log classification only — never the payload (may contain PII) or secret.
    console.warn(`[resend-webhook] signature verification failed: ${(err as Error)?.message ?? "invalid"}`);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const eventType = String(event?.type ?? "");
  console.info(`[resend-webhook] verified ${eventType} svix-id=${svixId}`);

  // ---- 4. PERSIST FIRST (durable inbox; duplicates collapse here) ----
  const ingest = await callRpc<IngestResult>("email_provider_event_ingest", {
    p_provider_event_id: svixId,     // stable across Resend retries ⇒ dedupe key
    p_event: event,
  });
  if (!ingest.ok) {
    console.error(`[resend-webhook] ingest RPC failed (${ingest.status})`);
    // 500 ⇒ Resend retries; nothing was persisted yet, so nothing is lost.
    return NextResponse.json({ error: "persistence failed" }, { status: 500 });
  }
  if (ingest.data?.duplicate) {
    // Already ingested (retry/replay). 200 stops further retries; processing
    // is (or will be) handled by the cron backstop. Idempotent by construction.
    return NextResponse.json({ received: true, duplicate: true, provider_event_id: svixId });
  }

  // ---- 5. Best-effort inline processing (rank-guarded, idempotent) ----
  let processed: unknown = null;
  const proc = await callRpc<Record<string, number>>("process_provider_events", { p_limit: 50 });
  if (proc.ok) processed = proc.data;
  else console.warn("[resend-webhook] inline processing deferred to cron backstop");

  return NextResponse.json({
    received: true,
    provider_event_id: svixId,
    event_type: eventType,
    processed,
  });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, endpoint: "resend-webhook", method: "POST" }, { status: 200 });
}
