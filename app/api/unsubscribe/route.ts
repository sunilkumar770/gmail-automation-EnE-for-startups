// ============================================================================
// GoRentals — Secure unsubscribe endpoint (Next.js App Router)
// Path: app/api/unsubscribe/route.ts
// ============================================================================
// Master spec §13/§14: replaces the v1 `?email=<raw PII>` URL with an opaque,
// HMAC-signed token (v1.<b64url(payload)>.<b64url(sig)>), minted in Postgres
// (pgcrypto, key in Supabase Vault) at render time by the edge function.
//
// GET  ?t=<token>  → verify → human confirmation page (NO side effects —
//                    link scanners/prefetchers must not unsubscribe anyone)
// POST ?t=<token>  → verify → apply suppression (source='user',
//                    reason='unsubscribe') → success page/JSON. Idempotent.
//                    Supports RFC 8058 one-click: the mail client POSTs with
//                    body "List-Unsubscribe=One-Click"; the token rides in the
//                    query string, so that body is safely ignored.
//
// SECURITY PROPERTIES
//   * Tamper-resistant: HMAC-SHA256 over the payload; verification is a
//     constant-time compare inside Postgres (single source of truth).
//   * No raw email in URLs/logs; token payload is opaque base64url.
//   * Enumeration-proof: every invalid case (malformed/forged/expired/absent)
//     returns the IDENTICAL 400 page — validity depends only on the HMAC, so
//     an attacker cannot probe whether an address exists.
//   * Ownership: suppression is written with source='user' — provider-side
//     "suppression.removed" events can NEVER clear it (see §11 model).
//
// ENV: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server-side only)
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { callRpc, supabaseEnv } from "../../../lib/supabase-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = (title: string, bodyHtml: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${title} — GoRentals</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" style="padding:48px 16px;"><tr><td align="center">
<table role="presentation" width="480" style="max-width:480px;width:100%;background:#fff;border-radius:12px;overflow:hidden;">
<tr><td style="background:#0f172a;padding:16px 28px;"><span style="color:#fff;font-size:18px;font-weight:bold;">Go<span style="color:#2dd4bf;">Rentals</span></span></td></tr>
<tr><td style="padding:28px;color:#334155;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
</table></td></tr></table></body></html>`;

/** Identical for every invalid-token case (enumeration-proof). */
function invalidPage(): NextResponse {
  const html = PAGE(
    "Link invalid",
    `<h1 style="font-size:18px;color:#0f172a;margin:0 0 12px;">This unsubscribe link is invalid or has expired</h1>
     <p>Please use the unsubscribe link from the most recent GoRentals email, or contact
     <a href="mailto:support@gorentals.com" style="color:#0d9488;">support@gorentals.com</a> and we'll take care of it.</p>`,
  );
  return new NextResponse(html, { status: 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function wantsJson(req: NextRequest): boolean {
  return (req.headers.get("accept") ?? "").includes("application/json");
}

/** Extract token: query param first (RFC 8058 one-click), then form/JSON body. */
async function extractToken(req: NextRequest): Promise<string | null> {
  const fromQuery = req.nextUrl.searchParams.get("t");
  if (fromQuery) return fromQuery;
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = (await req.json()) as Record<string, unknown>;
      return typeof body.t === "string" && body.t ? body.t : null;
    }
    if (ct.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      // One-click bodies are "List-Unsubscribe=One-Click" — no token there.
      const params = new URLSearchParams(text);
      return params.get("t");
    }
  } catch {
    return null;
  }
  return null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!supabaseEnv()) return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  const token = await extractToken(req);
  if (!token) return invalidPage();

  const v = await callRpc<{ valid?: boolean; reason?: string }>("email_unsub_verify", { p_token: token });
  if (!v.ok || !v.data?.valid) return invalidPage(); // identical for forged/expired/malformed

  const html = PAGE(
    "Confirm unsubscribe",
    `<h1 style="font-size:18px;color:#0f172a;margin:0 0 12px;">Unsubscribe from GoRentals marketing emails?</h1>
     <p>You'll stop receiving review requests, offers and newsletters. Booking confirmations,
     reminders and refund notices will still reach you — they're part of your rental.</p>
     <form method="POST" action="/api/unsubscribe" style="margin-top:20px;">
       <input type="hidden" name="t" value="${token.replace(/"/g, "&quot;")}">
       <button type="submit" style="background:#0d9488;color:#fff;border:0;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;">Unsubscribe</button>
     </form>`,
  );
  return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!supabaseEnv()) return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  const token = await extractToken(req);
  if (!token) return invalidPage();

  // Apply = verify (constant-time HMAC) + write suppression (source='user').
  const r = await callRpc<{ ok?: boolean; reason?: string; email?: string }>("email_apply_unsubscribe", { p_token: token });
  if (!r.ok) {
    // DB unreachable: 500 so mail clients may retry; nothing was applied.
    return NextResponse.json({ error: "temporarily unavailable" }, { status: 500 });
  }
  if (!r.data?.ok) return invalidPage(); // forged/expired/malformed → identical 400

  console.info("[unsubscribe] suppression applied (source=user)"); // no PII logged
  if (wantsJson(req)) {
    return NextResponse.json({ ok: true, unsubscribed: true });
  }
  const html = PAGE(
    "Unsubscribed",
    `<h1 style="font-size:18px;color:#0f172a;margin:0 0 12px;">You're unsubscribed ✓</h1>
     <p>Marketing emails will stop within 24 hours. Transactional messages about active
     bookings (confirmations, reminders, refunds) will still be delivered.</p>
     <p style="color:#94a3b8;font-size:13px;">Changed your mind? Email
     <a href="mailto:support@gorentals.com" style="color:#0d9488;">support@gorentals.com</a> and we'll re-subscribe you.</p>`,
  );
  return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
