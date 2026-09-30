// ============================================================================
// engine/src/engine/liveCatalog.ts — the REAL production template catalog
// ============================================================================
// Mirrors supabase/migrations 001–003 (email_templates registry) and
// lib/schemas.ts (Zod). Skeletons are valid payloads with placeholder ids —
// replace the uuids/dedupe keys with real values before sending in live mode.
// The worker validates every payload against these schemas; an unknown
// template or a bad payload fails CLOSED (422 / DEAD), never silently sends.
// ============================================================================

export interface LiveTemplate {
  key: string;
  name: string;
  category: 'transactional' | 'marketing';
  critical: boolean;
  /** logical_event_id pattern (idempotency scope) */
  logicalId: string;
  skeleton: Record<string, unknown>;
  notes?: string;
}

const UUID_PLACEHOLDER = '00000000-0000-0000-0000-000000000001';

const bookingSkeleton = {
  booking_id: UUID_PLACEHOLDER,
  listing_title: 'Canon EOS R5 Kit',
  city: 'Hyderabad',
  renter_name: 'Asha',
  owner_name: 'Bo',
  starts_at: '2026-10-12T10:00:00+05:30',
  ends_at: '2026-10-15T18:00:00+05:30',
  amount: 7500,
  currency: 'INR',
  timezone: 'Asia/Kolkata',
};

export const LIVE_TEMPLATES: LiveTemplate[] = [
  // --- authentication ------------------------------------------------------
  {
    key: 'otp', name: 'Login OTP / 2FA code', category: 'transactional', critical: true,
    logicalId: 'OTP:{recipient}:{dedupe_key}',
    skeleton: {
      user_id: UUID_PLACEHOLDER, dedupe_key: 'chal-2026-0001', otp_code: '482913',
      expiry_minutes: 10, action_type: 'Sign in verification',
    },
    notes: 'Priority 1 → fastlane drain kick (seconds). A newer OTP for the same recipient CANCELS this one. Never logged (field-level redaction).',
  },
  // --- kyc -----------------------------------------------------------------
  {
    key: 'kyc_submitted', name: 'KYC: documents received', category: 'transactional', critical: true,
    logicalId: 'KYC_SUBMITTED:{dedupe_key}',
    skeleton: { dedupe_key: 'kyc-attempt-0001', user_id: UUID_PLACEHOLDER, name: 'Asha', document_type: 'Aadhaar card' },
    notes: 'dedupe_key = verification ATTEMPT id (new attempt ⇒ new key).',
  },
  {
    key: 'kyc_approved', name: 'KYC: approved', category: 'transactional', critical: true,
    logicalId: 'KYC_APPROVED:{dedupe_key}',
    skeleton: { dedupe_key: 'kyc-attempt-0001', user_id: UUID_PLACEHOLDER, name: 'Asha' },
  },
  {
    key: 'kyc_rejected', name: 'KYC: rejected (reason + re-upload CTA)', category: 'transactional', critical: true,
    logicalId: 'KYC_REJECTED:{dedupe_key}',
    skeleton: { dedupe_key: 'kyc-attempt-0001', user_id: UUID_PLACEHOLDER, name: 'Asha', reason: 'Photo was blurred — all four corners must be visible.', document_type: 'Aadhaar card' },
    notes: 'reason is REQUIRED (schema gate) — a rejection without a reason is not actionable.',
  },
  {
    key: 'kyc_doc_expiring', name: 'KYC: document expiring (DL/RC/insurance)', category: 'transactional', critical: false,
    logicalId: 'KYC_DOC_EXPIRING:{dedupe_key}:{campaign}',
    skeleton: { dedupe_key: 'doc-0001', campaign: '2026-10', document_type: 'Driving licence', expiry_date: '2026-10-12T00:00:00+05:30', name: 'Asha' },
    notes: 'App-side ENQUEUE (no scan producer yet). campaign scopes one email per cycle.',
  },
  // --- booking lifecycle ---------------------------------------------------
  {
    key: 'booking_confirmation', name: 'Booking confirmed (renter)', category: 'transactional', critical: true,
    logicalId: 'BOOKING_CONFIRMATION:{booking_id}', skeleton: { ...bookingSkeleton },
    notes: 'Normally trigger-driven on bookings.status → confirmed/approved/accepted.',
  },
  {
    key: 'booking_host_confirmation', name: 'Booking confirmed (owner)', category: 'transactional', critical: true,
    logicalId: 'BOOKING_HOST_CONFIRMATION:{booking_id}', skeleton: { ...bookingSkeleton },
  },
  {
    key: 'booking_request_owner', name: 'Booking request (owner)', category: 'transactional', critical: true,
    logicalId: 'BOOKING_REQUEST_OWNER:{booking_id}', skeleton: { ...bookingSkeleton },
  },
  {
    key: 'booking_cancelled_renter', name: 'Booking cancelled (renter)', category: 'transactional', critical: true,
    logicalId: 'BOOKING_CANCELLED_RENTER:{booking_id}', skeleton: { ...bookingSkeleton },
  },
  {
    key: 'booking_cancelled_owner', name: 'Booking cancelled (owner)', category: 'transactional', critical: true,
    logicalId: 'BOOKING_CANCELLED_OWNER:{booking_id}', skeleton: { ...bookingSkeleton },
  },
  {
    key: 'booking_reminder', name: 'Rental starts tomorrow', category: 'transactional', critical: true,
    logicalId: 'BOOKING_REMINDER:{booking_id}:{starts_date}', skeleton: { ...bookingSkeleton },
    notes: 'Cron scan 09:00 IST; date-scoped so reschedules legitimately re-remind.',
  },
  {
    key: 'access_instructions', name: 'Pickup / access instructions', category: 'transactional', critical: true,
    logicalId: 'ACCESS_INSTRUCTIONS:{booking_id}', skeleton: { ...bookingSkeleton },
  },
  {
    key: 'review_request', name: 'Post-rental review request', category: 'marketing', critical: false,
    logicalId: 'REVIEW_REQUEST:{booking_id}:{campaign}',
    skeleton: { ...bookingSkeleton, campaign: '2026-10' },
    notes: 'Marketing ⇒ signed one-click unsubscribe attached automatically.',
  },
  // --- refunds & deposits --------------------------------------------------
  {
    key: 'refund_initiated', name: 'Refund initiated / processing', category: 'transactional', critical: true,
    logicalId: 'REFUND_INITIATED:{refund_id}',
    skeleton: { refund_id: UUID_PLACEHOLDER, booking_id: UUID_PLACEHOLDER, amount: 2500, currency: 'INR', renter_name: 'Asha', listing_title: 'Canon EOS R5 Kit', payment_method: 'UPI •• 4412', eta_days: '3-5' },
    notes: 'Trigger-driven on refunds.status → pending/initiated/processing.',
  },
  {
    key: 'refund_issued', name: 'Refund issued (final)', category: 'transactional', critical: true,
    logicalId: 'REFUND_ISSUED:{refund_id}',
    skeleton: { refund_id: UUID_PLACEHOLDER, booking_id: UUID_PLACEHOLDER, amount: 2500, currency: 'INR', renter_name: 'Asha', listing_title: 'Canon EOS R5 Kit' },
  },
  {
    key: 'refund_failed', name: 'Refund failed (support CTA)', category: 'transactional', critical: true,
    logicalId: 'REFUND_FAILED:{refund_id}',
    skeleton: { refund_id: UUID_PLACEHOLDER, amount: 2500, currency: 'INR', renter_name: 'Asha', reason: 'bank account closed' },
    notes: 'Re-notify after a repaired retry with an explicit logical_event_id suffix.',
  },
  {
    key: 'deposit_released', name: 'Security deposit released', category: 'transactional', critical: true,
    logicalId: 'DEPOSIT_RELEASED:{booking_id}',
    skeleton: { booking_id: UUID_PLACEHOLDER, amount: 4000, currency: 'INR', renter_name: 'Asha', listing_title: 'Canon EOS R5 Kit', deductions: 'None', eta_days: '3-7' },
  },
  // --- payments -------------------------------------------------------------
  {
    key: 'payment_receipt', name: 'Payment receipt (+ signed invoice link)', category: 'transactional', critical: true,
    logicalId: 'PAYMENT_RECEIPT:{dedupe_key}',
    skeleton: {
      dedupe_key: 'pi_0001', amount: 7500, currency: 'INR', renter_name: 'Asha',
      booking_id: UUID_PLACEHOLDER, invoice_id: 'INV-91823',
      invoice_url: 'https://www.gorentls.com/api/invoices/91823/pdf?sig=REPLACE_WITH_SIGNED_LINK',
      payment_method: 'UPI', date: '2026-10-10T09:14:00+05:30',
    },
    notes: 'invoice_url = app-minted SIGNED, time-limited PDF link (https only; javascript:/http: rejected by schema + renderer).',
  },
  {
    key: 'payment_failed', name: 'Payment failed (retry CTA)', category: 'transactional', critical: true,
    logicalId: 'PAYMENT_FAILED:{dedupe_key}',
    skeleton: { dedupe_key: 'pi_0002', amount: 3000, currency: 'INR', renter_name: 'Asha', reason: 'insufficient funds', retry_url: 'https://www.gorentls.com/checkout/retry?id=pi_0002' },
  },
  // --- growth ----------------------------------------------------------------
  {
    key: 'welcome', name: 'Signup welcome', category: 'transactional', critical: true,
    logicalId: 'WELCOME:{user_id}',
    skeleton: { user_id: UUID_PLACEHOLDER, name: 'Asha' },
    notes: 'Normally trigger-driven on profiles INSERT.',
  },
  {
    key: 'win_back', name: 'Win-back (30/60/90 tiers)', category: 'marketing', critical: false,
    logicalId: 'WIN_BACK:{recipient}:{campaign}',
    skeleton: { campaign: 'WB30-2026-W40', renter_name: 'Asha', user_id: UUID_PLACEHOLDER },
    notes: 'Weekly cron (Mon 09:30 IST); campaign scopes one email per user per tier.',
  },
];

/** Map demo-catalog events (gorentlsAdapter presets) → real template keys. */
export const EVENT_TO_TEMPLATE: Record<string, string> = {
  AUTH_WELCOME: 'welcome',
  AUTH_OTP: 'otp',
  BOOKING_CONFIRMED: 'booking_confirmation',
  PAYMENT_SUCCESS: 'payment_receipt',
  RENTAL_STARTING_SOON: 'booking_reminder',
  REFUND_COMPLETED: 'refund_issued',
  REVIEW_REQUESTED: 'review_request',
  OWNER_BOOKING_RECEIVED: 'booking_request_owner',
  OWNER_PAYOUT_COMPLETED: '', // no production template yet (roadmap: owner_payout)
  SYSTEM_ALERT: '',          // ops alerting stays outside the customer email system
};

export function findLiveTemplate(key: string): LiveTemplate | undefined {
  return LIVE_TEMPLATES.find((t) => t.key === key);
}
