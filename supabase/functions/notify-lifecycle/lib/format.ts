// ============================================================================
// lib/format.ts — Currency & timezone-correct presentation formatting
// ============================================================================
// Rules (master spec §19/§20):
//   * currency ALWAYS comes from the booking payload — never a global default
//     masquerading as per-booking data (fallback 'USD' only when the payload
//     genuinely lacks currency, and it is flagged in the rendered output)
//   * timestamps are stored UTC; presentation converts to the BOOKING timezone
//   * invalid tz identifiers fall back to UTC (never crash a render)

const CURRENCY_RE = /^[A-Z]{3}$/;

export function isValidCurrency(c: unknown): c is string {
  return typeof c === "string" && CURRENCY_RE.test(c.toUpperCase());
}

export const DEFAULT_LOCALE = "en-IN"; // GoRentals primary market; override via EMAIL_LOCALE env

export function fmtMoney(amount: unknown, currency?: unknown, locale: string = DEFAULT_LOCALE): string | null {
  if (amount === null || amount === undefined || amount === "") return null;
  const n = typeof amount === "number" ? amount : Number(String(amount).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const cur = isValidCurrency(currency) ? currency.toUpperCase() : null;
  if (cur) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n);
    } catch {
      return `${n.toFixed(2)} ${cur}`; // unknown ISO code — explicit, never wrong-symbol
    }
  }
  // No currency on the payload: show the number + explicit marker rather than
  // silently pretending a default.
  return `${n.toFixed(2)} (currency unspecified)`;
}

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Format an ISO timestamp in the given IANA timezone (UTC fallback + label). */
export function fmtDateInTz(iso: unknown, tz?: unknown, locale: string = DEFAULT_LOCALE): string {
  if (typeof iso !== "string" || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const zone = isValidTimezone(tz) ? tz : "UTC";
  try {
    const s = new Intl.DateTimeFormat(locale, {
      weekday: "short", day: "numeric", month: "short", year: "numeric",
      hour: "numeric", minute: "2-digit", timeZone: zone,
    }).format(d);
    return zone === "UTC" ? `${s} UTC` : s; // local tz shown without suffix clutter
  } catch {
    return `${d.toISOString()} UTC`;
  }
}

/** Local calendar date (YYYY-MM-DD) in tz — used for day-scoped logic in tests. */
export function localDateInTz(iso: string, tz?: unknown): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const zone = isValidTimezone(tz) ? tz : "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone,
    }).format(d); // en-CA renders YYYY-MM-DD
    return parts;
  } catch {
    return null;
  }
}
