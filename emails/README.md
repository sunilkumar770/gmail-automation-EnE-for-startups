# emails/ — React Email PREVIEW templates

**These files never send mail.** They exist so designers/PMs can iterate on
email design with hot reload:

```bash
npm i                       # installs @react-email/components (+ react-email CLI)
npx email dev --dir emails  # visual preview at http://localhost:3000
```

## Why previews live here but sends don't

Supabase Edge Functions run Deno, which cannot reliably compile React Email
JSX at deploy time (see supabase/discussions#40286). The production send path
renders equivalent HTML from
`supabase/functions/notify-lifecycle/lib/templates.ts` (plain TS, table-based,
inline styles, multipart html+text) via **Resend over HTTP**.

## Mirror policy (drift is a bug)

`lib/templates.ts` is the SOURCE OF TRUTH (it is what recipients actually get).
When you change copy, headings, CTAs, or brand styling in `emails/*.tsx`,
mirror the change into `lib/templates.ts` in the same PR — the unit test
`preview templates mirror send templates` fails the build when key phrases
diverge. Version bumps: registry row (`email_templates`) + renderer entry in
`TEMPLATES[key][version]` — queued mail keeps rendering its frozen version.

The `resend` npm SDK is intentionally NOT used: the worker posts to the Resend
REST API directly (Idempotency-Key, tags, timeout + ambiguity handling).

| Preview file | Mirrors template key |
|---|---|
| `welcome.tsx` | `welcome` |
| `booking-pair.tsx` → BookingRequestEmail | `booking_request_owner` |
| `booking-pair.tsx` → BookingConfirmedEmail | `booking_confirmation` / `booking_host_confirmation` |
| `booking-pair.tsx` → BookingCancelledEmail | `booking_cancelled_renter` / `_owner` |
| `booking-pair.tsx` → BookingRefundedEmail | `refund_issued` |
| `booking-pair.tsx` → BookingReminderEmail | `booking_reminder` |
| `booking-pair.tsx` → ReviewRequestEmail | `review_request` |
| `booking-pair.tsx` → WinBackEmail | `win_back` |
