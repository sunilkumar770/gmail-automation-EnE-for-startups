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

import { fmtDateInTz, fmtMoney } from "./format.ts";
import type { RenderPayload } from "./schemas.ts";

export interface RenderContext {
  recipient: string;
  appUrl: string;
  /** Presentation locale (default en-IN for the GoRentals market). */
  locale?: string;
  /** Full unsubscribe URL incl. signed token — marketing templates only. */
  unsubUrl?: string | null;
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

function bookingUrl(p: RenderPayload, ctx: RenderContext): string {
  return p.booking_id ? ctx.appUrl + "/bookings/" + encodeURIComponent(String(p.booking_id)) : ctx.appUrl;
}

function shell(opts: {
  preheader: string;
  heading: string;
  bodyHtml: string;
  ctaText?: string;
  ctaUrl?: string;
  marketing?: boolean;
  unsubUrl?: string | null;
}): string {
  const cta =
    opts.ctaText && opts.ctaUrl
      ? '<tr><td align="center" style="padding:24px 0;">' +
        '<a href="' + escapeHtml(opts.ctaUrl) + '" style="background:#0d9488;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;display:inline-block;">' +
        escapeHtml(opts.ctaText) + "</a></td></tr>"
      : "";
  const unsubLink =
    opts.marketing && opts.unsubUrl
      ? '<p style="margin:8px 0;"><a href="' + escapeHtml(opts.unsubUrl) + '" style="color:#94a3b8;text-decoration:underline;">Unsubscribe from non-essential emails</a></p>'
      : '<p style="margin:8px 0;color:#94a3b8;">This is a transactional message about your GoRentals activity.</p>';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + escapeHtml(opts.heading) + "</title></head>" +
    '<body style="margin:0;padding:0;background:#f1f5f9;">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + escapeHtml(opts.preheader) + "</div>" +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;"><tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">' +
    '<tr><td style="background:#0f172a;padding:20px 32px;"><span style="color:#ffffff;font-size:20px;font-weight:bold;">Go<span style="color:#2dd4bf;">Rentals</span></span></td></tr>' +
    '<tr><td style="padding:32px;"><h1 style="margin:0 0 16px;font-size:20px;color:#0f172a;">' + escapeHtml(opts.heading) + "</h1>" +
    '<div style="font-size:15px;line-height:1.6;color:#334155;">' + opts.bodyHtml + "</div>" + cta + "</td></tr>" +
    '<tr><td style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center;">' +
    "<p style=\"margin:4px 0;\">&copy; " + new Date().getUTCFullYear() + " GoRentals &middot; <a href=\"https://gorentals.com\" style=\"color:#94a3b8;\">gorentals.com</a></p>" +
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

const money = (p: RenderPayload, locale?: string): string | null => fmtMoney(p.amount, p.currency, locale);
const din = (iso: unknown, p: RenderPayload, locale?: string): string => fmtDateInTz(iso, p.timezone, locale);
const listing = (p: RenderPayload): string => String(p.listing_title ?? "your rental");

function unsubHeaders(ctx: RenderContext, recipient: string): Record<string, string> | undefined {
  if (!ctx.unsubUrl) return undefined; // endpoint+token must exist before advertising (spec §14)
  const mailto = "<mailto:unsubscribe@gorentals.com?subject=" + encodeURIComponent("unsubscribe " + recipient) + ">";
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
        subject: sanitizeHeaderLine("Welcome to GoRentals, " + nm),
        html: shell({
          preheader: "Browse gear, book in a few taps, manage rentals in one dashboard.",
          heading: "Welcome, " + escapeHtml(nm) + " 👋",
          bodyHtml:
            "<p>Your GoRentals account is ready. You can now browse gear, book in a few taps, and manage every rental from one dashboard.</p>" +
            detailsTable([["Your account", nm === "there" ? null : nm]]),
          ctaText: "Start browsing",
          ctaUrl: ctx.appUrl,
        }),
        text:
          "Hi " + nm + ",\n\nWelcome to GoRentals! Your account is ready.\n\nBrowse rentals: " + ctx.appUrl +
          "\n\n— The GoRentals team",
      };
    },
  },

  booking_confirmation: {
    category: "transactional",
    critical: true,
    render: (p, ctx) => ({
      subject: sanitizeHeaderLine("Confirmed — " + listing(p) + " on GoRentals"),
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
      }),
      text:
        "Hi " + greeting(p) + ",\n\nYour GoRentals booking is CONFIRMED.\n\n" +
        "Listing:    " + listing(p) + "\nCheck-in:  " + din(p.starts_at, p, ctx.locale) + "\nCheck-out: " + din(p.ends_at, p, ctx.locale) +
        "\nTotal:     " + (money(p, ctx.locale) ?? "-") + "\n\nManage your booking: " + bookingUrl(p, ctx) + "\n\n— The GoRentals team",
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
      }),
      text:
        "Hi " + hostName(p) + ",\n\nYour listing was just BOOKED.\n\nCheck-in:  " + din(p.starts_at, p, ctx.locale) +
        "\nCheck-out: " + din(p.ends_at, p, ctx.locale) + "\nValue:     " + (money(p, ctx.locale) ?? "-") +
        "\n\nManage booking: " + bookingUrl(p, ctx) + "\n\n— GoRentals",
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
      }),
      text:
        "Hi " + hostName(p) + ",\n\nA renter requested your listing.\nDates: " + din(p.starts_at, p, ctx.locale) + " → " + din(p.ends_at, p, ctx.locale) +
        "\n\nReview it here: " + bookingUrl(p, ctx) + "\n\n— GoRentals",
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
      }),
      text:
        "Hi " + greeting(p) + ",\n\nYour booking was CANCELLED.\n\nIf a refund applies it will be issued automatically (5–10 business days).\n\nDetails: " +
        bookingUrl(p, ctx) + "\n\n— GoRentals",
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
      }),
      text:
        "Hi " + hostName(p) + ",\n\nA booking starting " + din(p.starts_at, p, ctx.locale) + " was CANCELLED. Your calendar is open again.\n\n— GoRentals",
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
            "<p>Your bank may show it as <em>GO RENTALS</em> or similar on your statement.</p>",
          ctaText: p.booking_id ? "View booking" : undefined,
          ctaUrl: p.booking_id ? bookingUrl(p, ctx) : undefined,
        }),
        text:
          "Hi " + greeting(p) + ",\n\nWe've issued a refund of " + (m ?? "-") + ".\nExpect it within 5–10 business days on your original payment method.\n\n— GoRentals",
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
      }),
      text:
        "Hi " + greeting(p) + ",\n\nReminder: your rental starts " + din(p.starts_at, p, ctx.locale) + " (local time).\n\nCheck-in details: " +
        bookingUrl(p, ctx) + "\n\n— GoRentals",
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
      }),
      text: "Hi " + greeting(p) + ",\n\nAccess instructions: " + bookingUrl(p, ctx) + "\n\n— GoRentals",
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
          "</strong>. Honest reviews keep GoRentals trustworthy — would you take 30 seconds to rate it?</p>",
        ctaText: "Leave a review",
        ctaUrl: bookingUrl(p, ctx) + "?review=1",
        marketing: true,
        unsubUrl: ctx.unsubUrl,
      }),
      text:
        "Hi " + greeting(p) + ",\n\nYou recently rented on GoRentals. Would you leave a quick review?\n\n" +
        bookingUrl(p, ctx) + "?review=1\n\n— GoRentals" +
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
        bodyHtml: "<p>Hi " + escapeHtml(greeting(p)) + ", it's been a while! New RVs, campers and gear are listed every day on GoRentals.</p>",
        ctaText: "Browse rentals",
        ctaUrl: ctx.appUrl + "/listings",
        marketing: true,
        unsubUrl: ctx.unsubUrl,
      }),
      text:
        "Hi " + greeting(p) + ",\n\nNew rentals are waiting for you: " + ctx.appUrl + "/listings" +
        (ctx.unsubUrl ? "\n\nUnsubscribe: " + ctx.unsubUrl : ""),
    }),
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
