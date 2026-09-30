// ============================================================================
// lib/templates.ts — VERSIONED template registry (renderers)
// ============================================================================
// Master spec §16: templates are versioned; the outbox row freezes
// (template_key, template_version) at enqueue; the worker renders EXACTLY the
// pinned version. If code for a pinned version no longer exists, the row
// dead-letters with a clear error — it never silently renders a newer design.
//
// Adding a new version:
//   1. INSERT INTO email_templates (key, version, ...) VALUES ('x', 2, ...);
//   2. Add registry entry x: { 1: oldRenderer, 2: newRenderer } below.
//   3. Old queued rows keep rendering v1; new enqueues freeze v2.
//
// BRANDING: every brand string (name, domain, support/unsubscribe addresses)
// comes from RenderContext — never hardcoded. The edge function builds the ctx
// from env (BRAND_NAME, BRAND_DOMAIN, APP_URL, SUPPORT_EMAIL, UNSUBSCRIBE_EMAIL).

import { fmtDateInTz, fmtMoney } from "./format.ts";
import type { RenderPayload } from "./schemas.ts";

export interface RenderContext {
  recipient: string;
  appUrl: string;
  /** Presentation locale (default en-IN for the GoRentls market). */
  locale?: string;
  /** Full unsubscribe URL incl. signed token — marketing templates only. */
  unsubUrl?: string | null;
  /** Brand identity (env-driven; see migration 003 §A config keys). */
  brandName: string;
  brandDomain: string;
  supportEmail: string;
  unsubscribeEmail: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface TemplateDef {
  category: "transactional" | "marketing";
  critical: boolean;
  render: (p: RenderPayload, ctx: RenderContext) => RenderedEmail;
}

export type TemplateRegistry = Record<string, Record<number, TemplateDef>>;

export class UnknownTemplateVersionError extends Error {
  constructor(key: string, version: number) {
    super(`no renderer deployed for template ${key}@v${version} — deploy matching code or migrate queued rows`);
    this.name = "UnknownTemplateVersionError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** CRLF-injection guard for anything placed into headers/subjects. */
export function sanitizeHeaderLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ").slice(0, 300);
}

const greeting = (p: RenderPayload): string =>
  p.renter_name && p.renter_name !== "there" ? String(p.renter_name) : "there";
const hostName = (p: RenderPayload): string =>
  p.owner_name && p.owner_name !== "Host" ? String(p.owner_name) : "Host";
/** Person name for account-level emails (KYC/OTP): name ?? renter_name ?? "there". */
const personName = (p: RenderPayload): string => {
  const n = p.name ?? p.renter_name;
  return n && n !== "there" ? String(n) : "there";
};

function bookingUrl(p: RenderPayload, ctx: RenderContext): string {
  return p.booking_id ? ctx.appUrl + "/bookings/" + encodeURIComponent(String(p.booking_id)) : ctx.appUrl;
}

function kycUrl(p: RenderPayload, ctx: RenderContext): string {
  return typeof p.cta_url === "string" && p.cta_url.startsWith("https://")
    ? p.cta_url
    : ctx.appUrl + "/account/kyc";
}

/** Brand wordmark: keep the two-tone "Go|Rest" look for Go-prefixed brands. */
function brandLogoHtml(ctx: RenderContext): string {
  const name = escapeHtml(ctx.brandName || "GoRentls");
  if (/^Go[A-Z]/.test(ctx.brandName || "")) {
    return 'Go<span style="color:#2dd4bf;">' + name.slice(2) + "</span>";
  }
  return name;
}

function shell(opts: {
  preheader: string;
  heading: string;
  bodyHtml: string;
  ctaText?: string;
  ctaUrl?: string;
  marketing?: boolean;
  unsubUrl?: string | null;
}, ctx: RenderContext): string {
  const brand = ctx.brandName || "GoRentls";
  const domain = ctx.brandDomain || "gorentls.com";
  const cta =
    opts.ctaText && opts.ctaUrl
      ? '<tr><td align="center" style="padding:24px 0;">' +
        '<a href="' + escapeHtml(opts.ctaUrl) + '" style="background:#0d9488;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;display:inline-block;">' +
        escapeHtml(opts.ctaText) + "</a></td></tr>"
      : "";
  const unsubLink =
    opts.marketing && opts.unsubUrl
      ? '<p style="margin:8px 0;"><a href="' + escapeHtml(opts.unsubUrl) + '" style="color:#94a3b8;text-decoration:underline;">Unsubscribe from non-essential emails</a></p>'
      : '<p style="margin:8px 0;color:#94a3b8;">This is a transactional message about your ' + escapeHtml(brand) + " activity.</p>";
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + escapeHtml(opts.heading) + "</title></head>" +
    '<body style="margin:0;padding:0;background:#f1f5f9;">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + escapeHtml(opts.preheader) + "</div>" +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;"><tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">' +
    '<tr><td style="background:#0f172a;padding:20px 32px;"><span style="color:#ffffff;font-size:20px;font-weight:bold;">' + brandLogoHtml(ctx) + "</span></td></tr>" +
    '<tr><td style="padding:32px;"><h1 style="margin:0 0 16px;font-size:20px;color:#0f172a;">' + escapeHtml(opts.heading) + "</h1>" +
    '<div style="font-size:15px;line-height:1.6;color:#334155;">' + opts.bodyHtml + "</div>" + cta + "</td></tr>" +
    '<tr><td style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center;">' +
    "<p style=\"margin:4px 0;\">&copy; " + new Date().getUTCFullYear() + " " + escapeHtml(brand) + " &middot; <a href=\"https://" + escapeHtml(domain) + "\" style=\"color:#94a3b8;\">" + escapeHtml(domain) + "</a></p>" +
    unsubLink + "</td></tr></table></td></tr></table></body></html>"
  );
}

function detailsTable(rows: Array<[string, string | null]>): string {
  const visible = rows.filter((r) => r[1] !== null && r[1] !== "" && r[1] !== "—");
  if (!visible.length) return "";
  let html = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid #e2e8f0;border-radius:8px;">';
  for (const r of visible) {
    html +=
      '<tr><td style="padding:10px 14px;font-size:13px;color:#64748b;border-bottom:1px solid #f1f5f9;width:40%;">' + escapeHtml(r[0]) + "</td>" +
      '<td style="padding:10px 14px;font-size:14px;color:#0f172a;font-weight:bold;border-bottom:1px solid #f1f5f9;">' + escapeHtml(r[1]) + "</td></tr>";
  }
  return html + "</table>";
}

/** Highlighted reason/notice block (KYC rejections, payment failures…). */
function noticeBlock(text: string, tone: "warn" | "info" = "warn"): string {
  const colors = tone === "warn"
    ? "background:#fffbeb;border:1px solid #fcd34d;color:#92400e;"
    : "background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;";
  return '<p style="margin:16px 0;padding:12px 16px;border-radius:8px;font-size:14px;' + colors + '">' + escapeHtml(text) + "</p>";
}

const money = (p: RenderPayload, locale?: string): string | null => fmtMoney(p.amount, p.currency, locale);
const din = (iso: unknown, p: RenderPayload, locale?: string): string => fmtDateInTz(iso, p.timezone, locale);
const listing = (p: RenderPayload): string => String(p.listing_title ?? "your rental");
/** Safe https-only URL from the payload (renderer-side guard; Zod also enforces). */
const safeUrl = (v: unknown): string | null =>
  typeof v === "string" && /^https:\/\/[^\s"'<>]+$/i.test(v) ? v : null;

function unsubHeaders(ctx: RenderContext, recipient: string): Record<string, string> | undefined {
  if (!ctx.unsubUrl) return undefined; // endpoint+token must exist before advertising (spec §14)
  const unsubAddr = ctx.unsubscribeEmail || "unsubscribe@" + (ctx.brandDomain || "gorentls.com");
  const mailto = "<mailto:" + unsubAddr + "?subject=" + encodeURIComponent("unsubscribe " + recipient) + ">";
  return {
    "List-Unsubscribe": mailto + ", <" + ctx.unsubUrl + ">",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

// ---------------------------------------------------------------------------
// v1 renderers
// ---------------------------------------------------------------------------
const v1: Record<string, TemplateDef> = {
  welcome: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => {
      const nm = String(p.name ?? p.renter_name ?? "there");
      return {
        subject: sanitizeHeaderLine("Welcome to " + ctx.brandName + ", " + nm),
        html: shell({
          preheader: "Browse gear, book in a few taps, manage rentals in one dashboard.",
          heading: "Welcome, " + escapeHtml(nm) + " 👋",
          bodyHtml:
            "<p>Your " + escapeHtml(ctx.brandName) + " account is ready. You can now browse gear, book in a few taps, and manage every rental from one dashboard.</p>" +
            detailsTable([["Your account", nm === "there" ? null : nm]]),
          ctaText: "Start browsing",
          ctaUrl: ctx.appUrl,
        }, ctx),
        text:
          "Hi " + nm + ",\n\nWelcome to " + ctx.brandName + "! Your account is ready.\n\nBrowse rentals: " + ctx.appUrl +
          "\n\n— The " + ctx.brandName + " team",
      };
    },
  },

  booking_confirmation: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => ({
      subject: sanitizeHeaderLine("Confirmed — " + listing(p) + " on " + ctx.brandName),
      html: shell({
        preheader: "Your booking is confirmed. Details inside.",
        heading: "You're all set, " + escapeHtml(greeting(p)) + "! 🎉",
        bodyHtml:
          "<p>Your booking of <strong>" + escapeHtml(listing(p)) + "</strong> is confirmed. Save this email — it's your receipt.</p>" +
          detailsTable([
            ["Listing", listing(p)],
            ["Location", p.city ? String(p.city) : null],
            ["Check-in", din(p.starts_at, p, ctx.locale)],
            ["Check-out", din(p.ends_at, p, ctx.locale)],
            ["Total paid", money(p, ctx.locale)],
          ]),
        ctaText: "View my booking",
        ctaUrl: bookingUrl(p, ctx),
      }, ctx),
      text:
        "Hi " + greeting(p) + ",\n\nYour " + ctx.brandName + " booking is CONFIRMED.\n\n" +
        "Listing:    " + listing(p) + "\nCheck-in:  " + din(p.starts_at, p, ctx.locale) + "\nCheck-out: " + din(p.ends_at, p, ctx.locale) +
        "\nTotal:     " + (money(p, ctx.locale) ?? "-") + "\n\nManage your booking: " + bookingUrl(p, ctx) + "\n\n— The " + ctx.brandName + " team",
    }),
  },

  booking_host_confirmation: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => ({
      subject: sanitizeHeaderLine("New confirmed booking — " + listing(p)),
      html: shell({
        preheader: "A renter just booked your listing.",
        heading: "Heads up, " + escapeHtml(hostName(p)) + " 👋",
        bodyHtml:
          "<p><strong>" + escapeHtml(listing(p)) + "</strong> was just booked and payment is secured.</p>" +
          detailsTable([
            ["Listing", listing(p)],
            ["Location", p.city ? String(p.city) : null],
            ["Check-in", din(p.starts_at, p, ctx.locale)],
            ["Check-out", din(p.ends_at, p, ctx.locale)],
            ["Booking value", money(p, ctx.locale)],
          ]) +
          "<p>Please make sure the item is prepped and available for check-in.</p>",
        ctaText: "Manage this booking",
        ctaUrl: bookingUrl(p, ctx),
      }, ctx),
      text:
        "Hi " + hostName(p) + ",\n\nYour listing was just BOOKED.\n\nCheck-in:  " + din(p.starts_at, p, ctx.locale) +
        "\nCheck-out: " + din(p.ends_at, p, ctx.locale) + "\nValue:     " + (money(p, ctx.locale) ?? "-") +
        "\n\nManage booking: " + bookingUrl(p, ctx) + "\n\n— " + ctx.brandName,
    }),
  },

  booking_request_owner: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => ({
      subject: sanitizeHeaderLine("Booking request pending — " + listing(p)),
      html: shell({
        preheader: "A renter requested your listing. Review the request.",
        heading: "You have a new booking request",
        bodyHtml:
          "<p>A renter requested <strong>" + escapeHtml(listing(p)) + "</strong>. Requests that stay unanswered get cancelled automatically — please review it soon.</p>" +
          detailsTable([["Requested dates", din(p.starts_at, p, ctx.locale) + " → " + din(p.ends_at, p, ctx.locale)]]),
        ctaText: "Review request",
        ctaUrl: bookingUrl(p, ctx),
      }, ctx),
      text:
        "Hi " + hostName(p) + ",\n\nA renter requested your listing.\nDates: " + din(p.starts_at, p, ctx.locale) + " → " + din(p.ends_at, p, ctx.locale) +
        "\n\nReview it here: " + bookingUrl(p, ctx) + "\n\n— " + ctx.brandName,
    }),
  },

  booking_cancelled_renter: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => ({
      subject: sanitizeHeaderLine("Your booking was cancelled — " + listing(p)),
      html: shell({
        preheader: "Cancellation details and what happens next.",
        heading: "Your booking was cancelled",
        bodyHtml:
          "<p>Hi " + escapeHtml(greeting(p)) + ", your booking of <strong>" + escapeHtml(listing(p)) + "</strong> has been cancelled.</p>" +
          detailsTable([["Listing", listing(p)], ["Original check-in", din(p.starts_at, p, ctx.locale)]]) +
          "<p>If a refund applies, it is processed automatically and you'll receive a separate confirmation within 5–10 business days.</p>",
        ctaText: "View booking",
        ctaUrl: bookingUrl(p, ctx),
      }, ctx),
      text:
        "Hi " + greeting(p) + ",\n\nYour booking was CANCELLED.\n\nIf a refund applies it will be issued automatically (5–10 business days).\n\nDetails: " +
        bookingUrl(p, ctx) + "\n\n— " + ctx.brandName,
    }),
  },

  booking_cancelled_owner: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => ({
      subject: sanitizeHeaderLine("Booking cancelled — " + listing(p)),
      html: shell({
        preheader: "A booking on your listing was cancelled.",
        heading: "A booking was cancelled",
        bodyHtml:
          "<p>The booking of <strong>" + escapeHtml(listing(p)) + "</strong> starting " + escapeHtml(din(p.starts_at, p, ctx.locale)) +
          " was cancelled. Your calendar has been reopened automatically.</p>",
        ctaText: "View listing",
        ctaUrl: bookingUrl(p, ctx),
      }, ctx),
      text:
        "Hi " + hostName(p) + ",\n\nA booking starting " + din(p.starts_at, p, ctx.locale) + " was CANCELLED. Your calendar is open again.\n\n— " + ctx.brandName,
    }),
  },

  refund_issued: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => {
      const m = money(p, ctx.locale);
      return {
        subject: sanitizeHeaderLine("Refund issued — " + (m ?? "your refund") + " is on the way"),
        html: shell({
          preheader: "We've issued your refund.",
          heading: "Your refund is on the way 💸",
          bodyHtml:
            "<p>Hi " + escapeHtml(greeting(p)) + ", we've issued a refund of <strong>" + escapeHtml(m ?? "the eligible amount") +
            "</strong> to your original payment method.</p>" +
            detailsTable([["Refund amount", m], ["Booking", String(p.listing_title ?? "-")], ["Expected arrival", "5–10 business days"]]) +
            "<p>Your bank may show it as <em>" + escapeHtml(ctx.brandName.toUpperCase()) + "</em> or similar on your statement.</p>",
          ctaText: p.booking_id ? "View booking" : undefined,
          ctaUrl: p.booking_id ? bookingUrl(p, ctx) : undefined,
        }, ctx),
        text:
          "Hi " + greeting(p) + ",\n\nWe've issued a refund of " + (m ?? "-") + ".\nExpect it within 5–10 business days on your original payment method.\n\n— " + ctx.brandName,
      };
    },
  },

  booking_reminder: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => ({
      subject: sanitizeHeaderLine("Starts soon — " + listing(p) + " check-in details"),
      html: shell({
        preheader: "Your rental starts soon. Here's what to know.",
        heading: "Your rental starts soon ⏰",
        bodyHtml:
          "<p>Hi " + escapeHtml(greeting(p)) + ", this is a friendly reminder that <strong>" + escapeHtml(listing(p)) +
          "</strong> starts " + escapeHtml(din(p.starts_at, p, ctx.locale)) + " (local time).</p>" +
          detailsTable([["Location", p.city ? String(p.city) : null], ["Check-in", din(p.starts_at, p, ctx.locale)], ["Check-out", din(p.ends_at, p, ctx.locale)]]) +
          "<p>Review the handover instructions on your booking page and contact the host early if anything is unclear.</p>",
        ctaText: "Check-in details",
        ctaUrl: bookingUrl(p, ctx),
      }, ctx),
      text:
        "Hi " + greeting(p) + ",\n\nReminder: your rental starts " + din(p.starts_at, p, ctx.locale) + " (local time).\n\nCheck-in details: " +
        bookingUrl(p, ctx) + "\n\n— " + ctx.brandName,
    }),
  },

  access_instructions: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => ({
      subject: sanitizeHeaderLine("Access instructions — " + listing(p)),
      html: shell({
        preheader: "How to collect your rental.",
        heading: "Access & handover instructions",
        bodyHtml:
          "<p>Hi " + escapeHtml(greeting(p)) + ", everything you need for pickup of <strong>" + escapeHtml(listing(p)) +
          "</strong> is on your booking page, including the host's contact details.</p>" +
          detailsTable([["Check-in", din(p.starts_at, p, ctx.locale)]]),
        ctaText: "Open instructions",
        ctaUrl: bookingUrl(p, ctx),
      }, ctx),
      text: "Hi " + greeting(p) + ",\n\nAccess instructions: " + bookingUrl(p, ctx) + "\n\n— " + ctx.brandName,
    }),
  },

  review_request: {
    category: "marketing",
    critical: false,
    render: (p, ctx) => ({
      subject: sanitizeHeaderLine("How was " + listing(p) + "?"),
      headers: unsubHeaders(ctx, ctx.recipient),
      html: shell({
        preheader: "30 seconds of your time helps the whole community.",
        heading: "How did it go? ⭐",
        bodyHtml:
          "<p>Hi " + escapeHtml(greeting(p)) + ", you recently rented <strong>" + escapeHtml(listing(p)) +
          "</strong>. Honest reviews keep " + escapeHtml(ctx.brandName) + " trustworthy — would you take 30 seconds to rate it?</p>",
        ctaText: "Leave a review",
        ctaUrl: bookingUrl(p, ctx) + "?review=1",
        marketing: true,
        unsubUrl: ctx.unsubUrl,
      }, ctx),
      text:
        "Hi " + greeting(p) + ",\n\nYou recently rented on " + ctx.brandName + ". Would you leave a quick review?\n\n" +
        bookingUrl(p, ctx) + "?review=1\n\n— " + ctx.brandName +
        (ctx.unsubUrl ? "\n\nUnsubscribe: " + ctx.unsubUrl : ""),
    }),
  },

  win_back: {
    category: "marketing",
    critical: false,
    render: (p, ctx) => ({
      subject: "We miss you — your next adventure awaits",
      headers: unsubHeaders(ctx, ctx.recipient),
      html: shell({
        preheader: "Fresh listings near you, ready to roll.",
        heading: "Ready for the next trip? 🚐",
        bodyHtml:
          "<p>Hi " + escapeHtml(greeting(p)) + ", it's been a while! New cameras, bikes, cars and event gear are listed every day on " +
          escapeHtml(ctx.brandName) + ".</p>",
        ctaText: "Browse rentals",
        ctaUrl: ctx.appUrl + "/listings",
        marketing: true,
        unsubUrl: ctx.unsubUrl,
      }, ctx),
      text:
        "Hi " + greeting(p) + ",\n\nNew rentals are waiting for you: " + ctx.appUrl + "/listings" +
        (ctx.unsubUrl ? "\n\nUnsubscribe: " + ctx.unsubUrl : ""),
    }),
  },

  // -------------------------------------------------------------------------
  // AUTHENTICATION — OTP (priority 1; fast-lane drained, see migration 003 §D)
  // -------------------------------------------------------------------------
  otp: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => {
      // Defense in depth: schema constrains to [A-Za-z0-9]{4,10}; strip anyway
      // (trigger-path rows only passed SQL type validation, not Zod).
      const code = String(p.otp_code ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
      const mins = Number.isFinite(Number(p.expiry_minutes)) && Number(p.expiry_minutes) > 0
        ? Math.min(1440, Math.round(Number(p.expiry_minutes))) : 10;
      const action = p.action_type ? String(p.action_type).slice(0, 120) : "verification";
      return {
        subject: sanitizeHeaderLine(code + " is your " + ctx.brandName + " verification code"),
        html: shell({
          preheader: "Your verification code — valid for " + mins + " minutes.",
          heading: "Your verification code",
          bodyHtml:
            "<p>Hi " + escapeHtml(personName(p)) + ", use this code to complete <strong>" + escapeHtml(action) + "</strong>:</p>" +
            '<div style="margin:20px 0;text-align:center;"><span style="display:inline-block;font-size:32px;font-weight:bold;letter-spacing:8px;color:#0f172a;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:14px 28px;font-family:\'Courier New\',Courier,monospace;">' +
            escapeHtml(code) + "</span></div>" +
            detailsTable([["Expires in", mins + " minutes"], ["Request", action]]) +
            noticeBlock(ctx.brandName + " staff will NEVER ask you for this code. Didn't request it? Ignore this email — your account stays secure.", "warn"),
        }, ctx),
        text:
          "Hi " + personName(p) + ",\n\n" + code + " is your " + ctx.brandName + " verification code (" + action + ").\n" +
          "It expires in " + mins + " minutes.\n\n" +
          ctx.brandName + " staff will never ask for this code. Didn't request it? Ignore this email.\n\n— " + ctx.brandName,
      };
    },
  },

  // -------------------------------------------------------------------------
  // KYC LIFECYCLE
  // -------------------------------------------------------------------------
  kyc_submitted: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => ({
      subject: sanitizeHeaderLine("Verification received — we're reviewing your documents"),
      html: shell({
        preheader: "Most reviews finish within 24–48 hours.",
        heading: "Verification received 🔍",
        bodyHtml:
          "<p>Hi " + escapeHtml(personName(p)) + ", we've received your " +
          (p.document_type ? "<strong>" + escapeHtml(String(p.document_type)) + "</strong> " : "") +
          "documents. Our team is reviewing them now — most reviews finish within <strong>24–48 hours</strong>.</p>" +
          detailsTable([["Document", p.document_type ? String(p.document_type) : null], ["Status", "Under review"]]) +
          "<p>We'll email you the moment there's an update. No action needed from you right now.</p>",
        ctaText: "Check verification status",
        ctaUrl: kycUrl(p, ctx),
      }, ctx),
      text:
        "Hi " + personName(p) + ",\n\nWe've received your verification documents and our team is reviewing them (usually 24–48 hours).\n\n" +
        "Status: " + kycUrl(p, ctx) + "\n\n— The " + ctx.brandName + " team",
    }),
  },

  kyc_approved: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => ({
      subject: sanitizeHeaderLine("You're verified ✅ — welcome aboard"),
      html: shell({
        preheader: "Identity verification complete. Full access unlocked.",
        heading: "You're verified ✅",
        bodyHtml:
          "<p>Hi " + escapeHtml(personName(p)) + ", your identity verification is <strong>complete</strong>. " +
          "You now have full access to book rentals" + (p.document_type ? " and manage your " + escapeHtml(String(p.document_type)) : "") + " on " + escapeHtml(ctx.brandName) + ".</p>" +
          detailsTable([["Verification", "Approved"], ["Account", personName(p) === "there" ? null : personName(p)]]),
        ctaText: "Browse rentals",
        ctaUrl: safeUrl(p.cta_url) ?? (ctx.appUrl + "/search"),
      }, ctx),
      text:
        "Hi " + personName(p) + ",\n\nYour " + ctx.brandName + " identity verification is APPROVED. You're all set to rent.\n\n" +
        (safeUrl(p.cta_url) ?? (ctx.appUrl + "/search")) + "\n\n— The " + ctx.brandName + " team",
    }),
  },

  kyc_rejected: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => {
      const reason = String(p.reason ?? "Your documents could not be verified. Please re-upload clear, valid documents.");
      return {
        subject: sanitizeHeaderLine("Action needed — your verification was not approved"),
        html: shell({
          preheader: "Re-upload your documents to continue using " + ctx.brandName + ".",
          heading: "Action needed: verification unsuccessful ⚠️",
          bodyHtml:
            "<p>Hi " + escapeHtml(personName(p)) + ", unfortunately we couldn't approve your verification this time.</p>" +
            noticeBlock("Why: " + reason, "warn") +
            "<p>You can <strong>re-upload your documents</strong> right away — most re-submissions are approved on the next review. Make sure photos are well-lit, all four corners are visible, and details match your account.</p>" +
            detailsTable([["Document", p.document_type ? String(p.document_type) : null], ["Status", "Action needed"]]) +
            "<p>Questions? Reply to this email or write to " + escapeHtml(ctx.supportEmail) + " — we're happy to help.</p>",
          ctaText: "Re-upload documents",
          ctaUrl: kycUrl(p, ctx),
        }, ctx),
        text:
          "Hi " + personName(p) + ",\n\nYour verification was NOT approved.\nReason: " + reason + "\n\n" +
          "Re-upload your documents: " + kycUrl(p, ctx) + "\nNeed help? " + ctx.supportEmail + "\n\n— The " + ctx.brandName + " team",
      };
    },
  },

  kyc_doc_expiring: {
    category: "transactional",
    critical: false,
    render: (p, ctx) => {
      const doc = String(p.document_type ?? "document");
      return {
        subject: sanitizeHeaderLine("Your " + doc + " expires soon — update it to keep renting"),
        html: shell({
          preheader: "Renew now to avoid interruptions to your bookings.",
          heading: "Your " + escapeHtml(doc) + " expires soon 📅",
          bodyHtml:
            "<p>Hi " + escapeHtml(personName(p)) + ", your <strong>" + escapeHtml(doc) + "</strong> is nearing its expiry date. " +
            "Upload the renewed copy now so your account stays verified and your bookings aren't interrupted.</p>" +
            detailsTable([["Document", doc], ["Expires on", p.expiry_date ? fmtDateInTz(p.expiry_date, p.timezone, ctx.locale) : null]]) +
            "<p>This only takes a minute — snap a photo and upload.</p>",
          ctaText: "Update document",
          ctaUrl: kycUrl(p, ctx),
        }, ctx),
        text:
          "Hi " + personName(p) + ",\n\nYour " + doc + " expires soon. Upload the renewed copy to stay verified:\n" +
          kycUrl(p, ctx) + "\n\n— The " + ctx.brandName + " team",
      };
    },
  },

  // -------------------------------------------------------------------------
  // REFUND & DEPOSIT LIFECYCLE
  // -------------------------------------------------------------------------
  refund_initiated: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => {
      const m = money(p, ctx.locale);
      const eta = p.eta_days ? String(p.eta_days) + " business days" : "5–10 business days";
      return {
        subject: sanitizeHeaderLine("Refund initiated — " + (m ?? "your refund") + " is being processed"),
        html: shell({
          preheader: "We've started processing your refund.",
          heading: "Your refund is on its way 💸",
          bodyHtml:
            "<p>Hi " + escapeHtml(greeting(p)) + ", we've initiated a refund of <strong>" + escapeHtml(m ?? "the eligible amount") +
            "</strong> to your original payment method.</p>" +
            detailsTable([
              ["Refund amount", m],
              ["Booking", p.listing_title ? String(p.listing_title) : null],
              ["Paid via", p.payment_method ? String(p.payment_method) : null],
              ["Expected arrival", eta],
            ]) +
            "<p>We'll email you again once the refund is issued. Timelines vary by bank/UPI provider.</p>",
          ctaText: p.booking_id ? "View booking" : undefined,
          ctaUrl: p.booking_id ? bookingUrl(p, ctx) : undefined,
        }, ctx),
        text:
          "Hi " + greeting(p) + ",\n\nYour refund of " + (m ?? "-") + " has been INITIATED.\nExpected arrival: " + eta +
          " on your original payment method.\n\n— The " + ctx.brandName + " team",
      };
    },
  },

  refund_failed: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => {
      const m = money(p, ctx.locale);
      const reason = p.reason ? String(p.reason) : "your payment provider could not accept the transfer";
      return {
        subject: sanitizeHeaderLine("Action needed — we couldn't send your refund"),
        html: shell({
          preheader: "Your money is safe, but we need your help to return it.",
          heading: "We couldn't complete your refund ⚠️",
          bodyHtml:
            "<p>Hi " + escapeHtml(greeting(p)) + ", our attempt to refund <strong>" + escapeHtml(m ?? "your money") + "</strong> failed because " +
            escapeHtml(reason) + ".</p>" +
            noticeBlock("Your money is safe with us — it has NOT been lost. We just need updated details or a retry to send it back.", "info") +
            detailsTable([["Refund amount", m], ["Booking", p.listing_title ? String(p.listing_title) : null]]) +
            "<p>Reply to this email or contact us at <strong>" + escapeHtml(ctx.supportEmail) + "</strong> and our team will resolve it with you — usually within one business day.</p>",
          ctaText: "Contact support",
          ctaUrl: "mailto:" + ctx.supportEmail + "?subject=" + encodeURIComponent("Refund failed" + (p.refund_id ? " — " + String(p.refund_id).slice(0, 8) : "")),
        }, ctx),
        text:
          "Hi " + greeting(p) + ",\n\nYour refund of " + (m ?? "-") + " FAILED (" + reason + "). Your money is safe with us.\n\n" +
          "Contact us right away: " + ctx.supportEmail + "\n\n— The " + ctx.brandName + " team",
      };
    },
  },

  deposit_released: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => {
      const m = money(p, ctx.locale);
      const eta = p.eta_days ? String(p.eta_days) + " business days" : "3–7 business days";
      return {
        subject: sanitizeHeaderLine("Security deposit released — " + (m ?? "refund on the way")),
        html: shell({
          preheader: "Your deposit is coming back to you.",
          heading: "Security deposit released 🔓",
          bodyHtml:
            "<p>Hi " + escapeHtml(greeting(p)) + ", your rental has been returned and inspected — we've released your security deposit of <strong>" +
            escapeHtml(m ?? "the full deposit") + "</strong>.</p>" +
            detailsTable([
              ["Released amount", m],
              ["Booking", p.listing_title ? String(p.listing_title) : null],
              ["Deductions", p.deductions ? String(p.deductions) : "None"],
              ["Expected arrival", eta],
            ]) +
            "<p>If any deduction looks wrong, reply to this email within 48 hours and we'll review it with you.</p>",
          ctaText: "View booking",
          ctaUrl: bookingUrl(p, ctx),
        }, ctx),
        text:
          "Hi " + greeting(p) + ",\n\nYour security deposit of " + (m ?? "-") + " has been RELEASED (arrival: " + eta + ").\n" +
          (p.deductions ? "Deductions: " + String(p.deductions) + "\n" : "") +
          "\nBooking: " + bookingUrl(p, ctx) + "\n\n— The " + ctx.brandName + " team",
      };
    },
  },

  // -------------------------------------------------------------------------
  // PAYMENTS
  // -------------------------------------------------------------------------
  payment_receipt: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => {
      const m = money(p, ctx.locale);
      const invoiceUrl = safeUrl(p.invoice_url);
      return {
        subject: sanitizeHeaderLine("Payment received — " + (m ?? "receipt inside")),
        html: shell({
          preheader: "Thanks! Your payment is confirmed.",
          heading: "Payment received ✅",
          bodyHtml:
            "<p>Hi " + escapeHtml(greeting(p)) + ", we've received your payment of <strong>" + escapeHtml(m ?? "the amount due") + "</strong>. Thank you!</p>" +
            detailsTable([
              ["Amount", m],
              ["Invoice", p.invoice_id ? String(p.invoice_id) : null],
              ["Paid via", p.payment_method ? String(p.payment_method) : null],
              ["Paid on", p.date ? fmtDateInTz(p.date, p.timezone, ctx.locale) : null],
              ["Booking", p.listing_title ? String(p.listing_title) : null],
            ]),
          ctaText: invoiceUrl ? "Download invoice (PDF)" : (p.booking_id ? "View booking" : undefined),
          ctaUrl: invoiceUrl ?? (p.booking_id ? bookingUrl(p, ctx) : undefined),
        }, ctx),
        text:
          "Hi " + greeting(p) + ",\n\nPayment received: " + (m ?? "-") + "\n" +
          (p.invoice_id ? "Invoice: " + String(p.invoice_id) + "\n" : "") +
          (invoiceUrl ? "\nDownload invoice (PDF): " + invoiceUrl + "\n" : "") +
          "\n— The " + ctx.brandName + " team",
      };
    },
  },

  payment_failed: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => {
      const m = money(p, ctx.locale);
      const reason = p.reason ? String(p.reason) : "your payment provider declined the charge";
      const retryUrl = safeUrl(p.retry_url) ?? (p.booking_id ? bookingUrl(p, ctx) : ctx.appUrl);
      return {
        subject: sanitizeHeaderLine("Payment failed — action needed to keep your booking"),
        html: shell({
          preheader: "Retry now to avoid losing your reservation.",
          heading: "Payment failed ⚠️",
          bodyHtml:
            "<p>Hi " + escapeHtml(greeting(p)) + ", we couldn't process your payment" + (m ? " of <strong>" + escapeHtml(m) + "</strong>" : "") +
            " because " + escapeHtml(reason) + ".</p>" +
            noticeBlock("If this payment was for a pending booking, the reservation may be released if the payment isn't completed soon.", "warn") +
            detailsTable([["Amount due", m], ["Booking", p.listing_title ? String(p.listing_title) : null]]) +
            "<p>Try a different card/UPI handle, or contact us at " + escapeHtml(ctx.supportEmail) + " if the problem persists.</p>",
          ctaText: "Retry payment",
          ctaUrl: retryUrl,
        }, ctx),
        text:
          "Hi " + greeting(p) + ",\n\nYour payment" + (m ? " of " + m : "") + " FAILED (" + reason + ").\n" +
          "Retry now to keep your booking: " + retryUrl + "\n\n— The " + ctx.brandName + " team",
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Registry: key → version → renderer. NEVER delete a version that may still be
// referenced by queued rows; add new versions alongside.
// ---------------------------------------------------------------------------
export const TEMPLATES: TemplateRegistry = {
  welcome: { 1: v1.welcome },
  booking_confirmation: { 1: v1.booking_confirmation },
  booking_host_confirmation: { 1: v1.booking_host_confirmation },
  booking_request_owner: { 1: v1.booking_request_owner },
  booking_cancelled_renter: { 1: v1.booking_cancelled_renter },
  booking_cancelled_owner: { 1: v1.booking_cancelled_owner },
  refund_issued: { 1: v1.refund_issued },
  booking_reminder: { 1: v1.booking_reminder },
  access_instructions: { 1: v1.access_instructions },
  review_request: { 1: v1.review_request },
  win_back: { 1: v1.win_back },
  // v3 catalog (migration 003): auth, KYC, refund lifecycle, payments
  otp: { 1: v1.otp },
  kyc_submitted: { 1: v1.kyc_submitted },
  kyc_approved: { 1: v1.kyc_approved },
  kyc_rejected: { 1: v1.kyc_rejected },
  kyc_doc_expiring: { 1: v1.kyc_doc_expiring },
  refund_initiated: { 1: v1.refund_initiated },
  refund_failed: { 1: v1.refund_failed },
  deposit_released: { 1: v1.deposit_released },
  payment_receipt: { 1: v1.payment_receipt },
  payment_failed: { 1: v1.payment_failed },
};

export function getTemplate(key: string, version: number): TemplateDef {
  const versions = TEMPLATES[key];
  const def = versions ? versions[version] : undefined;
  if (!def) throw new UnknownTemplateVersionError(key, version);
  return def;
}

export function isMarketing(key: string, version: number): boolean {
  try {
    return getTemplate(key, version).category === "marketing";
  } catch {
    return false;
  }
}
