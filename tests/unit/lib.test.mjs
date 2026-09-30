// Unit tests: format / retry / states / ratelimit / log / schemas / templates
import test from "node:test";
import assert from "node:assert/strict";
import {
  fmtMoney, fmtDateInTz, localDateInTz, isValidCurrency, isValidTimezone,
  states, retry, ratelimit, log, schemas, templates,
} from "../.build/lib.mjs";

// Full RenderContext as built by the worker (index.ts buildCtx) — brand fields
// are REQUIRED in production; tests must exercise the real shape.
const CTX = {
  recipient: "r@example.com",
  appUrl: "https://www.gorentls.com",
  locale: "en-IN",
  unsubUrl: null,
  brandName: "GoRentls",
  brandDomain: "gorentls.com",
  supportEmail: "support@gorentls.com",
  unsubscribeEmail: "unsubscribe@gorentls.com",
};

// ---------------------------------------------------------------------------
// §19 CURRENCY CORRECTNESS
// ---------------------------------------------------------------------------
test("currency: INR/USD/EUR render with the payload's currency, never a global", () => {
  assert.match(fmtMoney(2500, "INR"), /₹|INR/);
  assert.match(fmtMoney(250, "USD"), /\$|USD/);
  assert.match(fmtMoney(99.5, "EUR"), /€|EUR/);
  assert.equal(fmtMoney(10, "inr"), fmtMoney(10, "INR"), "case-insensitive code");
});
test("currency: unknown ISO code renders the code explicitly, never a wrong symbol", () => {
  // Intl formats unrecognized codes as "XYZ 10.00" (explicit); the catch-path
  // fallback ("10.00 XYZ") covers environments where Intl throws. Either way:
  // the code must be visible and no other currency's symbol may appear.
  const out = fmtMoney(10, "XYZ");
  assert.match(out, /XYZ/);
  assert.match(out, /10\.00/);
  assert.ok(!/[$€£₹]/.test(out), "must not borrow another currency's symbol");
});
test("currency: missing currency is flagged, not silently USD", () => {
  assert.match(fmtMoney(10, null), /currency unspecified/);
  assert.equal(fmtMoney(null, "USD"), null);
  assert.equal(fmtMoney("abc", "USD"), null);
  assert.equal(fmtMoney("123.45", "USD"), fmtMoney(123.45, "USD"), "numeric strings ok");
});
test("currency: validation", () => {
  assert.ok(isValidCurrency("usd"));
  assert.ok(!isValidCurrency("USDD"));
  assert.ok(!isValidCurrency(42));
});

// ---------------------------------------------------------------------------
// §20 TIMEZONE CORRECTNESS
// ---------------------------------------------------------------------------
test("timezone: same instant renders differently per booking timezone", () => {
  const iso = "2026-07-04T18:30:00Z";
  const utc = fmtDateInTz(iso, "UTC");
  const ist = fmtDateInTz(iso, "Asia/Kolkata");   // +5:30 → 00:00 Jul 5
  const nyc = fmtDateInTz(iso, "America/New_York"); // EDT -4 → 14:30
  assert.match(utc, /UTC/);
  assert.match(ist, /5 Jul|Jul 5/);               // default locale en-IN → day-first
  assert.match(ist, /12:00/i);
  assert.match(nyc, /4 Jul|Jul 4/);
  assert.match(nyc, /2:30/i);
});
test("timezone: DST boundary — America/New_York Nov 1 2026 (EDT→EST)", () => {
  const beforeDst = fmtDateInTz("2026-11-01T05:30:00Z", "America/New_York"); // 01:30 EDT
  const afterDst = fmtDateInTz("2026-11-01T06:30:00Z", "America/New_York");  // 01:30 EST
  assert.match(beforeDst, /1:30/i);
  assert.match(afterDst, /1:30/i); // same wall clock, different offset — both valid
  assert.equal(localDateInTz("2026-11-01T03:30:00Z", "America/New_York"), "2026-10-31");
  assert.equal(localDateInTz("2026-11-01T05:30:00Z", "America/New_York"), "2026-11-01");
});
test("timezone: invalid zone falls back to UTC without crashing", () => {
  assert.match(fmtDateInTz("2026-07-04T18:30:00Z", "Mars/Olympus"), /UTC/);
  assert.ok(!isValidTimezone("Not/AZone"));
  assert.ok(isValidTimezone("Europe/London"));
  assert.equal(fmtDateInTz("garbage", "UTC"), "—");
  assert.equal(fmtDateInTz(null, "UTC"), "—");
});
test("timezone: IST local-date divergence used by scans (20:00 UTC = next-day IST)", () => {
  const iso = new Date();
  const utcDay = new Date(Date.UTC(iso.getUTCFullYear(), iso.getUTCMonth(), iso.getUTCDate(), 20, 0));
  assert.notEqual(localDateInTz(utcDay.toISOString(), "Asia/Kolkata"),
                  localDateInTz(utcDay.toISOString(), "UTC"));
});

// ---------------------------------------------------------------------------
// §22 FAILURE CLASSIFICATION + BACKOFF
// ---------------------------------------------------------------------------
test("classify: 429 retryable with Retry-After", () => {
  const c = retry.classifyProviderFailure(429, "slow down", { retryAfterHeader: "7" });
  assert.equal(c.cls, "retryable");
  assert.equal(c.code, "rate_limited");
  assert.equal(c.retryAfterSec, 7);
});
test("classify: 5xx retryable, 400/401/404/422 permanent", () => {
  assert.equal(retry.classifyProviderFailure(500, "").cls, "retryable");
  assert.equal(retry.classifyProviderFailure(503, "").cls, "retryable");
  for (const s of [400, 401, 404, 422]) {
    assert.equal(retry.classifyProviderFailure(s, "").cls, "permanent", `status ${s}`);
  }
});
test("classify: 403 suppression is provider_suppressed; other 403 permanent", () => {
  assert.equal(retry.classifyProviderFailure(403, "Recipient is on the Suppression list").cls, "provider_suppressed");
  assert.equal(retry.classifyProviderFailure(403, "Forbidden").cls, "permanent");
});
test("classify: network error / null status / 408 are AMBIGUOUS (never blind retry)", () => {
  assert.equal(retry.classifyProviderFailure(null, "", { networkError: true }).cls, "ambiguous");
  assert.equal(retry.classifyProviderFailure(null, "").cls, "ambiguous");
  assert.equal(retry.classifyProviderFailure(408, "").cls, "ambiguous");
});
test("classify: parseRetryAfter seconds + HTTP-date + clamp", () => {
  assert.equal(retry.parseRetryAfter("30"), 30);
  assert.ok(retry.parseRetryAfter(new Date(Date.now() + 60_000).toUTCString()) >= 55);
  assert.equal(retry.parseRetryAfter("999999"), 3600);
  assert.equal(retry.parseRetryAfter(null), undefined);
});
test("backoff schedule [1,5,15,60,360] minutes", () => {
  assert.deepEqual(retry.BACKOFF_SCHEDULE_MINUTES, [1, 5, 15, 60, 360]);
  assert.equal(retry.backoffMinutesFor(1), 1);
  assert.equal(retry.backoffMinutesFor(3), 15);
  assert.equal(retry.backoffMinutesFor(99), 360, "clamped at last step");
});

// ---------------------------------------------------------------------------
// §10 STATE MACHINE (TS mirror of SQL)
// ---------------------------------------------------------------------------
test("state machine: app matrix happy path + replay paths", () => {
  assert.ok(states.canAppTransition("QUEUED", "CLAIMED"));
  assert.ok(states.canAppTransition("CLAIMED", "SENDING"));
  assert.ok(states.canAppTransition("SENDING", "ACCEPTED"));
  assert.ok(states.canAppTransition("SENDING", "UNKNOWN"));
  assert.ok(states.canAppTransition("UNKNOWN", "CLAIMED"));
  assert.ok(states.canAppTransition("DEAD", "QUEUED"), "operator replay");
});
test("state machine: invalid app transitions rejected (incl. DELIVERED→QUEUED)", () => {
  assert.ok(!states.canAppTransition("DELIVERED", "QUEUED"));
  assert.ok(!states.canAppTransition("ACCEPTED", "SENDING"));
  assert.ok(!states.canAppTransition("COMPLAINED", "QUEUED"));
  assert.ok(!states.canAppTransition("CANCELLED", "QUEUED"));
});
test("state machine: provider rank guard — out-of-order events never regress", () => {
  assert.ok(states.canProviderAdvance("SENDING", "ACCEPTED"));
  assert.ok(states.canProviderAdvance("SENDING", "DELIVERED"), "delivered-before-sent ok");
  assert.ok(!states.canProviderAdvance("DELIVERED", "ACCEPTED"), "late 'sent' blocked");
  assert.ok(!states.canProviderAdvance("BOUNCED", "DELIVERED"), "late delivered blocked");
  assert.ok(states.canProviderAdvance("DELIVERED", "COMPLAINED"), "complaint upgrades");
  assert.ok(!states.canProviderAdvance("COMPLAINED", "DELIVERED"));
  assert.ok(!states.canProviderAdvance("QUEUED", "DELIVERED"), "unsent row anomaly blocked");
  assert.ok(!states.canProviderAdvance("CLAIMED", "ACCEPTED"));
  assert.ok(!states.canProviderAdvance("DEAD", "DELIVERED"), "app-terminal not provider-advanceable");
  assert.ok(states.canProviderAdvance("RETRY_WAIT", "DELIVERED"), "provider wins over scheduled retry");
});

// ---------------------------------------------------------------------------
// §24 TOKEN BUCKET RATE LIMITER
// ---------------------------------------------------------------------------
test("rate limiter: burst then throttles to rps", async () => {
  const b = new ratelimit.TokenBucket({ rps: 20, burst: 2, maxWaitMs: 2000 });
  const t0 = Date.now();
  await b.take(); await b.take();               // burst consumed instantly
  await b.take();                                // must wait ~50ms
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 30, `third take should wait, elapsed=${elapsed}`);
});
test("rate limiter: pause() blocks for the requested duration", async () => {
  const b = new ratelimit.TokenBucket({ rps: 100, burst: 10 });
  b.pause(0.25);
  const t0 = Date.now();
  await b.take();
  assert.ok(Date.now() - t0 >= 200, "pause not honored");
});
test("rate limiter: maxWaitMs breach throws (worker must not hang forever)", async () => {
  const b = new ratelimit.TokenBucket({ rps: 0.05, burst: 1, maxWaitMs: 100 });
  await b.take();
  await assert.rejects(() => b.take(), /maxWaitMs/);
});

// ---------------------------------------------------------------------------
// §29 PII-SAFE LOGGING
// ---------------------------------------------------------------------------
test("log: recipient hash is stable, unique, and leaks nothing", async () => {
  const h1 = await log.hashRecipient("User@Example.com");
  const h2 = await log.hashRecipient("user@example.com");
  const h3 = await log.hashRecipient("other@example.com");
  assert.equal(h1, h2, "case/whitespace-insensitive");
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 16);
  assert.ok(!h1.includes("user"));
});
test("log: redaction of keys/secrets/tokens", () => {
  assert.equal(log.redact("key re_abc123XYZ end"), "key re_*** end");
  assert.equal(log.redact("whsec_aGVsbG8gd29ybGQxMjM="), "whsec_***");
  assert.match(log.redact("v1.eyJhIjoxfQ.c2lnbmF0dXJl"), /unsub-token\*\*\*/);
  assert.equal(log.redact(42), 42);
});

// ---------------------------------------------------------------------------
// §18 PAYLOAD SCHEMAS
// ---------------------------------------------------------------------------
test("schemas: booking_confirmation accepts a full payload", () => {
  const r = schemas.validatePayload("booking_confirmation", {
    booking_id: "cccccccc-0000-0000-0000-000000000001",
    listing_title: "Van", starts_at: "2026-09-20T10:00:00+00:00",
    ends_at: "2026-09-23T10:00:00Z", amount: 250, currency: "USD", timezone: "UTC",
  });
  assert.ok(r.ok, JSON.stringify(r));
});
test("schemas: missing booking_id / bad uuid / bad ts rejected", () => {
  assert.ok(!schemas.validatePayload("booking_confirmation", {}).ok);
  assert.ok(!schemas.validatePayload("booking_confirmation", { booking_id: "nope" }).ok);
  assert.ok(!schemas.validatePayload("booking_confirmation", {
    booking_id: "cccccccc-0000-0000-0000-000000000001", starts_at: "tomorrow",
  }).ok);
});
test("schemas: refund requires refund_id AND amount; reminder requires starts_at", () => {
  assert.ok(!schemas.validatePayload("refund_issued", { refund_id: "dddddddd-0000-0000-0000-000000000001" }).ok, "amount required");
  assert.ok(schemas.validatePayload("refund_issued", {
    refund_id: "dddddddd-0000-0000-0000-000000000001", amount: "12.50",
  }).ok, "numeric strings allowed for money");
  assert.ok(!schemas.validatePayload("booking_reminder", { booking_id: "cccccccc-0000-0000-0000-000000000001" }).ok);
});
test("schemas: unknown template fails CLOSED", () => {
  const r = schemas.validatePayload("mystery_template", { anything: 1 });
  assert.ok(!r.ok && /no schema/.test(r.errors[0]));
});
test("schemas: win_back requires campaign period", () => {
  assert.ok(!schemas.validatePayload("win_back", {}).ok);
  assert.ok(schemas.validatePayload("win_back", { campaign: "2026-09" }).ok);
});

// ---------------------------------------------------------------------------
// §16 TEMPLATE VERSIONING + RENDERING
// ---------------------------------------------------------------------------
// Schema-valid sample payload for EVERY registered template — shared by the
// render-loop and brand-purity tests (keeps schemas ↔ renderers coupled).
const SAMPLE_BASE = {
  booking_id: "cccccccc-0000-0000-0000-000000000001",
  listing_title: "Canon EOS R5 Kit", renter_name: "Asha", owner_name: "Bo",
  city: "Hyderabad",
  starts_at: "2026-10-01T10:00:00+05:30", ends_at: "2026-10-04T10:00:00+05:30",
  amount: 7500, currency: "INR", timezone: "Asia/Kolkata",
};
function samplePayloadFor(key) {
  switch (key) {
    case "welcome": return { user_id: "cccccccc-0000-0000-0000-000000000009", name: "Asha" };
    case "refund_issued":
    case "refund_initiated":
      return { ...SAMPLE_BASE, refund_id: "dddddddd-0000-0000-0000-000000000001" };
    case "refund_failed":
      return { ...SAMPLE_BASE, refund_id: "dddddddd-0000-0000-0000-000000000002", reason: "bank account closed" };
    case "win_back": return { campaign: "2026-09", renter_name: "Asha" };
    case "otp": return { dedupe_key: "chal-1", otp_code: "482913", expiry_minutes: 10 };
    case "kyc_submitted":
    case "kyc_approved": return { dedupe_key: "kyc-1", name: "Asha", document_type: "Aadhaar card" };
    case "kyc_rejected": return { dedupe_key: "kyc-1", reason: "Photo was blurred", name: "Asha" };
    case "kyc_doc_expiring":
      return { dedupe_key: "doc-1", campaign: "2026-09", document_type: "Driving licence", name: "Asha" };
    case "payment_receipt": return { ...SAMPLE_BASE, dedupe_key: "pi_1", invoice_id: "INV-91823" };
    case "payment_failed": return { ...SAMPLE_BASE, dedupe_key: "pi_2", reason: "insufficient funds" };
    default: return SAMPLE_BASE;   // booking_* / access_instructions / review_request / deposit_released
  }
}

test("templates: every registered template renders at v1 with html+text (schema-coupled)", () => {
  for (const key of Object.keys(templates.TEMPLATES)) {
    const payload = samplePayloadFor(key);
    const v = schemas.validatePayload(key, payload);
    assert.ok(v.ok, `${key}: sample payload must satisfy its own schema — ${JSON.stringify(v.ok ? [] : v.errors)}`);
    const out = templates.getTemplate(key, 1).render(v.data, { ...CTX });
    assert.ok(out.subject && out.subject.length > 3, `${key} subject`);
    assert.ok(out.html.includes("<!doctype html>"), `${key} html`);
    assert.ok(out.text && out.text.length > 20, `${key} text part (plain-text fallback)`);
  }
});
test("templates: pinned version missing → explicit error (never silent upgrade)", () => {
  assert.throws(() => templates.getTemplate("booking_confirmation", 99),
    templates.UnknownTemplateVersionError);
  assert.throws(() => templates.getTemplate("nope", 1), templates.UnknownTemplateVersionError);
});
test("templates: XSS in payload is escaped in html and can't break attributes", () => {
  const evil = {
    booking_id: "cccccccc-0000-0000-0000-000000000001",
    listing_title: '<script>alert("xss")</script><img src=x onerror=alert(1)>',
    renter_name: '"><b>', starts_at: "2026-09-20T10:00:00Z", amount: 1, currency: "USD", timezone: "UTC",
  };
  const out = templates.getTemplate("booking_confirmation", 1)
    .render(evil, { ...CTX });
  assert.ok(!out.html.includes("<script>"), "raw script tag leaked into HTML");
  assert.ok(out.html.includes("&lt;script&gt;"), "should be escaped in HTML contexts");
  // Subject is a PLAIN-TEXT header: entity-escaping it would corrupt normal
  // titles ("B&B" → "B&amp;B"). The security contract for subjects is:
  // (a) no CR/LF (header injection) and (b) never embedded unescaped into HTML.
  assert.ok(!/[\r\n]/.test(out.subject), "subject must be CRLF-free");
  const titleIdx = out.html.indexOf("<title>");
  const titleHtml = out.html.slice(titleIdx, out.html.indexOf("</title>"));
  assert.ok(!titleHtml.includes("<script>"), "html <title> must be escaped");
  // the escaped remnant 'onerror=alert(1)' may appear as inert TEXT; what must
  // never appear is a live tag/attribute breakout:
  assert.ok(!out.html.includes('<img src=x'), 'live img tag leaked');
  assert.ok(!out.html.includes('<script'), 'live script tag leaked');
});
test("templates: CRLF injection into subjects is neutralized", () => {
  const p = {
    booking_id: "cccccccc-0000-0000-0000-000000000001",
    listing_title: "Van\r\nBcc: victim@evil.com", amount: 1, currency: "USD", timezone: "UTC",
  };
  const out = templates.getTemplate("booking_confirmation", 1)
    .render(p, { ...CTX });
  assert.ok(!out.subject.includes("\r") && !out.subject.includes("\n"), "header injection!");
});
test("templates: marketing unsubscribe headers ONLY when a signed URL exists", () => {
  const p = { campaign: "2026-09", renter_name: "Ana" };
  const noTok = templates.getTemplate("win_back", 1).render(p, { ...CTX, appUrl: "https://x" });
  assert.equal(noTok.headers, undefined, "must not advertise an endpoint without a token");
  const withTok = templates.getTemplate("win_back", 1).render(p, {
    ...CTX, appUrl: "https://x", unsubUrl: "https://x/api/unsubscribe?t=v1.abc.def",
  });
  assert.match(withTok.headers["List-Unsubscribe"], /<https:\/\/x\/api\/unsubscribe\?t=/);
  assert.equal(withTok.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(!JSON.stringify(withTok).includes("r@example.com"), "raw email must not appear in links");
  // transactional templates never carry unsubscribe headers
  const tx = templates.getTemplate("booking_confirmation", 1).render(
    { booking_id: "cccccccc-0000-0000-0000-000000000001", timezone: "UTC" },
    { ...CTX, appUrl: "https://x", unsubUrl: "https://x/api/unsubscribe?t=v1.a.b" });
  assert.equal(tx.headers, undefined);
});
test("templates: rendered money+dates honor per-payload currency/timezone", () => {
  const p = {
    booking_id: "cccccccc-0000-0000-0000-000000000001", listing_title: "Van",
    starts_at: "2026-07-04T18:30:00Z", amount: 1200, currency: "INR", timezone: "Asia/Kolkata",
  };
  const out = templates.getTemplate("booking_confirmation", 1)
    .render(p, { ...CTX, appUrl: "https://x" });
  assert.match(out.html + out.text, /₹|INR/);
  assert.match(out.html, /5 Jul|Jul 5/, "IST next-day render");
});

// ---------------------------------------------------------------------------
// 002 blueprint features: welcome template, city, en-IN money, mirror policy
// ---------------------------------------------------------------------------
test("templates: welcome renders with name + CTA (transactional, no unsubscribe)", () => {
  const out = templates.getTemplate("welcome", 1).render(
    { user_id: "cccccccc-0000-0000-0000-000000000001", name: "Asha" },
    { ...CTX, recipient: "asha@example.com" });
  assert.match(out.subject, /Welcome to GoRentls, Asha/);
  assert.match(out.html, /Start browsing/);
  assert.match(out.text, /Welcome to GoRentls/);
  assert.equal(out.headers, undefined, "welcome is transactional — no List-Unsubscribe");
  const anon = templates.getTemplate("welcome", 1).render(
    { user_id: "cccccccc-0000-0000-0000-000000000002" },
    { ...CTX, recipient: "x@example.com" });
  assert.match(anon.subject, /Welcome to GoRentls, there/);
});

test("templates: city appears in booking confirmation details when present", () => {
  const out = templates.getTemplate("booking_confirmation", 1).render(
    { booking_id: "cccccccc-0000-0000-0000-000000000001", listing_title: "SeaView Caravan",
      city: "Goa", starts_at: "2026-10-01T10:00:00Z", amount: 4800, currency: "INR", timezone: "Asia/Kolkata" },
    { ...CTX });
  assert.match(out.html, /Goa/);
  assert.match(out.html + out.text, /₹4,800/, "en-IN INR grouping");
  const noCity = templates.getTemplate("booking_confirmation", 1).render(
    { booking_id: "cccccccc-0000-0000-0000-000000000001", starts_at: "2026-10-01T10:00:00Z" },
    { ...CTX });
  assert.ok(!noCity.html.includes("Location"), "Location row must disappear without city");
});

test("currency: en-IN renders INR/USD/EUR correctly (blueprint market)", () => {
  assert.equal(fmtMoney(4800, "INR", "en-IN"), "₹4,800.00");
  assert.equal(fmtMoney(1234.5, "INR", "en-IN"), "₹1,234.50");
  assert.match(fmtMoney(250, "USD", "en-IN"), /\$|US/);
  assert.match(fmtMoney(99.5, "EUR", "en-IN"), /€/);
  assert.equal(fmtMoney(4800, "INR", "en-US"), "₹4,800.00");
});

test("schemas: welcome requires user_id uuid; city accepted on booking payloads", () => {
  assert.ok(!schemas.validatePayload("welcome", {}).ok);
  assert.ok(!schemas.validatePayload("welcome", { user_id: "nope" }).ok);
  assert.ok(schemas.validatePayload("welcome", { user_id: "cccccccc-0000-0000-0000-000000000001", name: "Asha" }).ok);
  assert.ok(schemas.validatePayload("booking_confirmation", {
    booking_id: "cccccccc-0000-0000-0000-000000000001", city: "Goa",
  }).ok);
});

// ---------------------------------------------------------------------------
// 003 GoRentls catalog: OTP · KYC · refund lifecycle · payments · brand purity
// ---------------------------------------------------------------------------
test("schemas: otp requires a 4-10 alnum code + dedupe_key; fallback_sms allowed", () => {
  assert.ok(!schemas.validatePayload("otp", { dedupe_key: "c1" }).ok, "code required");
  assert.ok(!schemas.validatePayload("otp", { dedupe_key: "c1", otp_code: "12" }).ok, "too short");
  assert.ok(!schemas.validatePayload("otp", { dedupe_key: "c1", otp_code: "123456789012" }).ok, "too long");
  assert.ok(!schemas.validatePayload("otp", { dedupe_key: "c1", otp_code: "12<34" }).ok, "non-alnum rejected");
  assert.ok(schemas.validatePayload("otp", {
    dedupe_key: "c1", otp_code: "482913", expiry_minutes: 10, fallback_sms: true,
  }).ok, "valid otp payload rejected");
});

test("schemas: kyc_rejected requires an actionable reason; payload URLs must be https", () => {
  assert.ok(!schemas.validatePayload("kyc_rejected", { dedupe_key: "k1" }).ok, "reason required");
  assert.ok(schemas.validatePayload("kyc_rejected", { dedupe_key: "k1", reason: "Photo blurred" }).ok);
  assert.ok(!schemas.validatePayload("payment_receipt", {
    dedupe_key: "p1", amount: 100, invoice_url: "javascript:alert(1)",
  }).ok, "javascript: URL must be rejected");
  assert.ok(!schemas.validatePayload("payment_receipt", {
    dedupe_key: "p1", amount: 100, invoice_url: "http://insecure.example/x.pdf",
  }).ok, "plain http rejected");
  assert.ok(schemas.validatePayload("payment_receipt", {
    dedupe_key: "p1", amount: 100, invoice_url: "https://www.gorentls.com/api/invoices/x/pdf?sig=abc",
  }).ok);
});

test("templates: otp renders code prominently with expiry + anti-phishing warning", () => {
  const out = templates.getTemplate("otp", 1).render(
    { dedupe_key: "c1", otp_code: "482913", expiry_minutes: 5, action_type: "Sign in verification", name: "Asha" },
    { ...CTX });
  assert.match(out.subject, /^482913 is your GoRentls/);
  assert.match(out.html, /482913/);
  assert.match(out.text, /482913/);
  assert.match(out.html + out.text, /5 minutes/);
  assert.match(out.html, /NEVER ask/);
  assert.equal(out.headers, undefined, "OTP is transactional — no unsubscribe headers");
});

test("templates: otp renderer strips non-alnum junk from the code (defense in depth)", () => {
  const out = templates.getTemplate("otp", 1).render(
    { dedupe_key: "c1", otp_code: '48"><script>2913' }, { ...CTX });
  assert.ok(!out.html.includes("<script"), "code must be sanitized before render");
  // junk collapses to alnum-only (schema is the first gate; renderer is the second)
  assert.match(out.html, />48script29</);
});

test("templates: kyc_rejected escapes reviewer reason and surfaces support contact", () => {
  const out = templates.getTemplate("kyc_rejected", 1).render(
    { dedupe_key: "k1", reason: "<img src=x onerror=alert(1)> blurry photo", name: "Asha" }, { ...CTX });
  assert.ok(!out.html.includes("<img src=x"), "raw img tag leaked");
  assert.match(out.html, /blurry photo/);
  assert.match(out.html, /Re-upload documents/);
  assert.match(out.text, /support@gorentls\.com/);
});

test("templates: refund lifecycle renders initiated/failed states distinctly", () => {
  const init = templates.getTemplate("refund_initiated", 1).render(
    { refund_id: "dddddddd-0000-0000-0000-000000000001", amount: 2500, currency: "INR",
      eta_days: "3-5", payment_method: "UPI •• 4412" }, { ...CTX });
  assert.match(init.subject, /Refund initiated/);
  assert.match(init.html, /₹2,500/);
  assert.match(init.html, /3-5 business days/);
  assert.match(init.html, /UPI •• 4412/);
  const fail = templates.getTemplate("refund_failed", 1).render(
    { refund_id: "dddddddd-0000-0000-0000-000000000002", amount: 2500, currency: "INR",
      reason: "bank account closed" }, { ...CTX });
  assert.match(fail.subject, /couldn't send your refund/);
  assert.match(fail.html, /bank account closed/);
  assert.match(fail.html, /mailto:support@gorentls\.com/);
  assert.match(fail.html + fail.text, /safe with us/i);
});

test("templates: deposit_released itemizes deductions (or shows None)", () => {
  const out = templates.getTemplate("deposit_released", 1).render(
    { booking_id: "cccccccc-0000-0000-0000-000000000001", amount: 4000, currency: "INR",
      deductions: "Late return fee ₹500" }, { ...CTX });
  assert.match(out.html, /₹4,000/);
  assert.match(out.html, /Late return fee/);
  const none = templates.getTemplate("deposit_released", 1).render(
    { booking_id: "cccccccc-0000-0000-0000-000000000001", amount: 4500, currency: "INR" }, { ...CTX });
  assert.match(none.html, /None/);
});

test("templates: payment_receipt prefers signed invoice link, renderer-side guards non-https", () => {
  const withUrl = templates.getTemplate("payment_receipt", 1).render(
    { dedupe_key: "pi_1", amount: 7500, currency: "INR", invoice_id: "INV-91823",
      invoice_url: "https://www.gorentls.com/api/invoices/91823/pdf?sig=x", payment_method: "UPI" }, { ...CTX });
  assert.match(withUrl.html, /Download invoice \(PDF\)/);
  assert.match(withUrl.html, /sig=x/);
  assert.match(withUrl.html, /INV-91823/);
  const evil = templates.getTemplate("payment_receipt", 1).render(
    { dedupe_key: "pi_2", amount: 100, currency: "INR", invoice_url: "javascript:alert(1)" }, { ...CTX });
  assert.ok(!evil.html.includes("javascript:"), "renderer-side URL guard failed");
  const noUrl = templates.getTemplate("payment_receipt", 1).render(
    { dedupe_key: "pi_3", amount: 100, currency: "INR",
      booking_id: "cccccccc-0000-0000-0000-000000000001" }, { ...CTX });
  assert.match(noUrl.html, /View booking/);
});

test("templates: payment_failed carries reason + retry CTA", () => {
  const out = templates.getTemplate("payment_failed", 1).render(
    { dedupe_key: "pi_4", amount: 3000, currency: "INR", reason: "insufficient funds",
      retry_url: "https://www.gorentls.com/checkout/retry?id=4" }, { ...CTX });
  assert.match(out.subject, /Payment failed/);
  assert.match(out.html, /insufficient funds/);
  assert.match(out.html, /Retry payment/);
  assert.match(out.html, /checkout\/retry/);
});

test("templates: kyc_doc_expiring is transactional (no unsubscribe) and shows the expiry date", () => {
  const out = templates.getTemplate("kyc_doc_expiring", 1).render(
    { dedupe_key: "doc-1", campaign: "2026-09", document_type: "Driving licence",
      expiry_date: "2026-10-12T18:30:00+05:30", timezone: "Asia/Kolkata", name: "Asha" }, { ...CTX });
  assert.match(out.subject, /Driving licence expires soon/);
  assert.match(out.html, /12 Oct,? 2026|Oct 12/);
  assert.match(out.html, /6:30/, "expiry must render in the payload timezone (IST)");
  assert.equal(out.headers, undefined);
});

test("brand purity: no rendered template references the legacy GoRentals brand/domain", () => {
  for (const key of Object.keys(templates.TEMPLATES)) {
    const out = templates.getTemplate(key, 1).render(samplePayloadFor(key), { ...CTX });
    const all = out.subject + "\n" + out.html + "\n" + out.text + "\n" + JSON.stringify(out.headers ?? {});
    assert.ok(!/gorentals/i.test(all), `${key} still references the legacy brand`);
    assert.match(out.html, /gorentls\.com/, `${key} footer must link the real domain`);
    assert.match(out.html, /GoRentls/, `${key} must carry the brand name`);
  }
});

test("log: secret-named fields are value-redacted (otp codes never hit logs)", () => {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(String(l));
  try {
    log.logInfo({ event: "row_sent", otp_code: "482913", api_key: "re_secret123", status: "accepted" });
  } finally {
    console.log = orig;
  }
  const joined = lines.join("\n");
  assert.ok(!joined.includes("482913"), "otp_code value leaked into logs");
  assert.match(joined, /"otp_code":"\*\*\*"/);
  assert.match(joined, /"status":"accepted"/, "normal fields must stay readable");
});

test("preview templates mirror send templates (drift guard)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const send = readFileSync(root + "supabase/functions/notify-lifecycle/lib/templates.ts", "utf8");
  const previews = [
    "emails/_layout.tsx", "emails/welcome.tsx", "emails/booking-pair.tsx",
    "emails/otp.tsx", "emails/kyc.tsx", "emails/refunds.tsx", "emails/payments.tsx",
  ].map((f) => readFileSync(root + f, "utf8")).join("\n");
  // key phrases that must exist on BOTH sides (case-insensitive)
  const shared = [
    "welcome, ", "start browsing", "you're all set", "booking request",
    "was cancelled", "refund is on the way", "starts soon", "how did it go",
    "leave a review", "ready for the next trip", "browse rentals", "gorentls",
    // 003 catalog
    "your verification code", "verification received", "you're verified",
    "verification unsuccessful", "re-upload documents", "expires soon",
    "refund is on its way", "couldn't complete your refund", "security deposit released",
    "payment received", "download invoice", "payment failed", "retry payment",
    "cameras, bikes, cars and event gear",
  ];
  for (const phrase of shared) {
    const rx = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    assert.ok(rx.test(send), `send templates missing "${phrase}"`);
    assert.ok(rx.test(previews), `preview templates missing "${phrase}" (mirror drift)`);
  }
  // inverse brand guard: the legacy brand must be gone from BOTH sides
  for (const [name, src] of [["send", send], ["previews", previews]]) {
    assert.ok(!/gorentals/i.test(src), `${name} side still contains the legacy GoRentals brand`);
  }
});
