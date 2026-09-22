var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, "default"), secondTarget && __copyProps(secondTarget, mod, "default"));

// tests/.build/next-server-shim.mjs
var next_server_shim_exports = {};
__reExport(next_server_shim_exports, server_star);
import * as server_star from "next/server.js";

// lib/supabase-rpc.ts
function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}
async function callRpc(fn, params, timeoutMs = 15e3) {
  const env = supabaseEnv();
  if (!env) return { ok: false, status: 500, error: "supabase env not configured" };
  let res;
  try {
    res = await fetch(`${env.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.key,
        authorization: `Bearer ${env.key}`
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store"
    });
  } catch (err) {
    return { ok: false, status: 502, error: `network: ${err?.message ?? err}` };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 500) };
  try {
    return { ok: true, status: res.status, data: text ? JSON.parse(text) : null };
  } catch {
    return { ok: true, status: res.status, data: text };
  }
}

// app/api/unsubscribe/route.ts
var runtime = "nodejs";
var dynamic = "force-dynamic";
var PAGE = (title, bodyHtml) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${title} \u2014 GoRentals</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" style="padding:48px 16px;"><tr><td align="center">
<table role="presentation" width="480" style="max-width:480px;width:100%;background:#fff;border-radius:12px;overflow:hidden;">
<tr><td style="background:#0f172a;padding:16px 28px;"><span style="color:#fff;font-size:18px;font-weight:bold;">Go<span style="color:#2dd4bf;">Rentals</span></span></td></tr>
<tr><td style="padding:28px;color:#334155;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
</table></td></tr></table></body></html>`;
function invalidPage() {
  const html = PAGE(
    "Link invalid",
    `<h1 style="font-size:18px;color:#0f172a;margin:0 0 12px;">This unsubscribe link is invalid or has expired</h1>
     <p>Please use the unsubscribe link from the most recent GoRentals email, or contact
     <a href="mailto:support@gorentals.com" style="color:#0d9488;">support@gorentals.com</a> and we'll take care of it.</p>`
  );
  return new next_server_shim_exports.NextResponse(html, { status: 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
function wantsJson(req) {
  return (req.headers.get("accept") ?? "").includes("application/json");
}
async function extractToken(req) {
  const fromQuery = req.nextUrl.searchParams.get("t");
  if (fromQuery) return fromQuery;
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = await req.json();
      return typeof body.t === "string" && body.t ? body.t : null;
    }
    if (ct.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      const params = new URLSearchParams(text);
      return params.get("t");
    }
  } catch {
    return null;
  }
  return null;
}
async function GET(req) {
  if (!supabaseEnv()) return next_server_shim_exports.NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  const token = await extractToken(req);
  if (!token) return invalidPage();
  const v = await callRpc("email_unsub_verify", { p_token: token });
  if (!v.ok || !v.data?.valid) return invalidPage();
  const html = PAGE(
    "Confirm unsubscribe",
    `<h1 style="font-size:18px;color:#0f172a;margin:0 0 12px;">Unsubscribe from GoRentals marketing emails?</h1>
     <p>You'll stop receiving review requests, offers and newsletters. Booking confirmations,
     reminders and refund notices will still reach you \u2014 they're part of your rental.</p>
     <form method="POST" action="/api/unsubscribe" style="margin-top:20px;">
       <input type="hidden" name="t" value="${token.replace(/"/g, "&quot;")}">
       <button type="submit" style="background:#0d9488;color:#fff;border:0;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;">Unsubscribe</button>
     </form>`
  );
  return new next_server_shim_exports.NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
async function POST(req) {
  if (!supabaseEnv()) return next_server_shim_exports.NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  const token = await extractToken(req);
  if (!token) return invalidPage();
  const r = await callRpc("email_apply_unsubscribe", { p_token: token });
  if (!r.ok) {
    return next_server_shim_exports.NextResponse.json({ error: "temporarily unavailable" }, { status: 500 });
  }
  if (!r.data?.ok) return invalidPage();
  console.info("[unsubscribe] suppression applied (source=user)");
  if (wantsJson(req)) {
    return next_server_shim_exports.NextResponse.json({ ok: true, unsubscribed: true });
  }
  const html = PAGE(
    "Unsubscribed",
    `<h1 style="font-size:18px;color:#0f172a;margin:0 0 12px;">You're unsubscribed \u2713</h1>
     <p>Marketing emails will stop within 24 hours. Transactional messages about active
     bookings (confirmations, reminders, refunds) will still be delivered.</p>
     <p style="color:#94a3b8;font-size:13px;">Changed your mind? Email
     <a href="mailto:support@gorentals.com" style="color:#0d9488;">support@gorentals.com</a> and we'll re-subscribe you.</p>`
  );
  return new next_server_shim_exports.NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
export {
  GET,
  POST,
  dynamic,
  runtime
};
