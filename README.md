# Gmail Automation EnE for Startups — Event-Driven Email System **v2** (hardened)

Production-grade transactional + queued email automation for startups:
Next.js (Vercel) · Supabase (Postgres / Edge Functions / pg_cron / pg_net / Vault / PostgREST) · Resend · Svix.

> **v2 is a re-architecture, not a patch.** The v1 defect ledger
> ([AUDIT.md](AUDIT.md)) drove a rebuild around: transactional outbox,
> canonical logical-event idempotency, a send-attempt ledger, a durable
> provider-webhook inbox, a formal state machine, source-aware suppression,
> signed unsubscribe tokens, and versioned schema-validated templates.
> Every claim below is backed by an automated test (see §Verification).

---

## Architecture (as implemented)

```
BUSINESS EVENT (booking/refund write)
      ↓  same DB transaction
TRIGGER (fail-loud — never swallows; §2)          alt: Supabase DB Webhook mode
      ↓                                                  ↓
EMAIL OUTBOX  ── email_outbox ────────────────────────────┘
      · UNIQUE(logical_event_id)  ← canonical idempotency (§3)
      · template_key@version FROZEN at enqueue (§16)
      · payload validated against registry schema at enqueue (§17/18)
      · suppression + rate-cap applied at enqueue AND at send
      ↓  pg_cron */5 → pg_net (secret from Vault at runtime) → edge fn
WORKER (notify-lifecycle, DRAIN_QUEUE)
      · drain lease (single active drainer) + FOR UPDATE SKIP LOCKED claim
      · claim is FREE (no attempt consumed); begin_send opens the ledger row
      · Zod re-validation → render PINNED template version
      · token-bucket rate limit (RATE_RPS, Retry-After aware)
      ↓
RESEND (POST /emails)
      · Idempotency-Key = gr-<outbox_id>-<attempt> (stable, reused on reconcile)
      · tags carry logical_event_id (webhook correlation fallback)
      · html + text multipart; List-Unsubscribe (signed token) on marketing
      ↓
SEND ATTEMPT LEDGER (email_send_attempts)
      · accepted / failed / UNKNOWN (ambiguous outcome, §6)
      · UNKNOWN → 90s grace → reconcile: re-POST SAME idempotency key
      · retry: classified failures, backoff [1m,5m,15m,1h,6h] ±20% jitter
      · DEAD after max_attempts (default 5) → operator REPLAY
      ↓
PROVIDER WEBHOOKS (Resend → svix-signed)
      ↓
WEBHOOK INBOX (app/api/resend-webhook → email_provider_events)
      · verify signature on RAW body → persist FIRST (UNIQUE provider+event id)
      · duplicates (even concurrent) collapse; 200 once durable
      · processor (inline best-effort + cron */2 backstop):
        correlate via attempt.provider_email_id OR logical_event_id tag
        (fixes webhook-before-send-result race, §7); orphans retained+retried
      ↓
EMAIL STATE MACHINE (email_outbox.state, §10)
      · app transitions: explicit matrix (QUEUED→CLAIMED→SENDING→…)
      · provider transitions: RANK guard (out-of-order/duplicate safe)
      · every transition audited in outbox.audit_log
      ↓
SUPPRESSION (email_suppressions, source × reason, §11)
      · resend/user/manual/system with rank escalation (user > manual > resend)
      · provider removals clear ONLY source='resend'
      · permanent bounces + complaints auto-suppress; temporary bounces DON'T
      ↓
UNSUBSCRIBE (app/api/unsubscribe, §13)
      · HMAC-SHA256 tokens minted in Postgres (pgcrypto, key in Vault)
      · no raw email in URLs; constant-time compare; enumeration-proof
      · RFC 8058 one-click POST; GET = confirmation page (no side effects)
```

## ID taxonomy (§3 — six identities, never conflated)

| ID | Lives in | Purpose |
|---|---|---|
| Business event id | `bookings.id`, `refunds.id` | source-of-truth row |
| **Logical email event id** | `email_outbox.logical_event_id` (UNIQUE) | application idempotency; e.g. `REFUND_ISSUED:{refund_id}`, `BOOKING_REMINDER:{booking_id}:{start_date}`, `REVIEW_REQUEST:{booking_id}:{campaign}`, `WIN_BACK:{recipient}:{campaign}` |
| Outbox id | `email_outbox.id` | queue row identity |
| Send attempt id | `email_send_attempts.id` | one per provider interaction (incl. reconciles) |
| Provider email id | Resend `id` on attempts + inbox events | provider-side correlation |
| Provider event id | `svix-id` → `email_provider_events.provider_event_id` (UNIQUE with provider) | webhook delivery dedupe |

Provider `Idempotency-Key` complements — never replaces — the logical id.

## State machine (§10)

```
app-owned:      QUEUED → CLAIMED → SENDING → ACCEPTED        (happy path)
                                   SENDING → RETRY_WAIT → CLAIMED … → DEAD
                                   SENDING → UNKNOWN → CLAIMED (reconcile)
                QUEUED/CLAIMED → SUPPRESSED · QUEUED → CANCELLED
                DEAD/FAILED/BOUNCED/SUPPRESSED → QUEUED        (operator REPLAY only)
provider-owned (rank guard, advance-only):
                ACCEPTED(50) → DELAYED(55) → DELIVERED(60)
                FAILED(65) · BOUNCED(70) · COMPLAINED(85)
terminal: DEAD · CANCELLED · COMPLAINED
invalid by construction: DELIVERED→QUEUED, late 'sent' after 'delivered',
'delivered' after 'bounced', provider events on unsent rows — all rejected
and audited (matrix in SQL `email_state_transition_ok`, TS mirror in lib/states.ts).
```

## Repository map

| Path | What |
|---|---|
| `supabase/migrations/000_email_system_init.sql` | v1 baseline (historical; superseded by 001 on apply) |
| `supabase/migrations/001_email_system_v2.sql` | **v2 architecture** — outbox, ledger, inbox, suppressions, tokens, state machine, registry, type-safe mapping, cron, RLS, v1→v2 data migration |
| `supabase/migrations/002_business_defaults_and_producers.sql` | **GoRentals launch blueprint** — INR/IST business defaults (rate-cap day window), welcome-on-signup producer, weekly win-back tiers 30/60/90, owner-on-bookings + listings.city mapping, cron v3 (IST mornings), WEBHOOK_SECRET vault alias |
| `emails/` | React Email **preview** templates (Next.js side; `npx email dev --dir emails`) with a drift-guard unit test against the sending templates |
| `supabase/functions/notify-lifecycle/index.ts` | worker + operator API (DRAIN_QUEUE incl. reconciliation, PROCESS_EVENTS, ENQUEUE, TEST_SEND, TRACE, REPLAY, HEALTHCHECK, SCAN_*, DB_WEBHOOK) |
| `supabase/functions/notify-lifecycle/lib/` | `templates.ts` (versioned renderers) · `schemas.ts` (Zod) · `resend.ts` (provider client + outcome taxonomy) · `retry.ts` (classification/backoff) · `ratelimit.ts` (token bucket) · `states.ts` (machine mirror) · `format.ts` (currency/tz) · `log.ts` (PII-safe structured logs) |
| `app/api/resend-webhook/route.ts` | Svix-verified, size-bounded, persist-first webhook receiver |
| `app/api/unsubscribe/route.ts` | GET confirm + POST one-click unsubscribe (signed tokens) |
| `lib/supabase-rpc.ts` | shared server-side PostgREST client (no supabase-js realtime footgun) |
| `tests/` | unit · db (22-test SQL suite) · integration (edge 56, routes 40) · e2e (25) · chaos (18 + claim + suppression race) · security (37) · `run_all.sh` = `npm test` |
| `scripts/` | `00_reconcile_schema.sql` (pre-deploy inspection) · `curl_tests.sh` (post-deploy) · `sign_webhook_test.mjs` · `test_harness_stubs.sql` · `kill_stale.sh` |
| `SETUP.md` / `RUNBOOK.md` / `FAULT_INJECTION.md` / `AUDIT.md` | deploy · operations · failure matrix · v1 defect ledger |

## Design decisions & documented trade-offs

1. **Triggers fail loud.** An outbox insert failure rolls back the business
   transaction (§2 requirement). Trade-off: a misconfigured template registry
   blocks bookings — deliberately visible instead of silently lossy. The only
   legitimate no-op is "recipient has no email".
2. **Re-confirmation after cancellation does NOT re-send** the confirmation
   (logical id is booking-scoped by design). Rebooking flows should enqueue
   with an explicit `p_logical_event_id` (e.g. suffix `:R2`) — documented in
   RUNBOOK. Reminders avoid this entirely by being date-scoped.
3. **Reconciliation over blind retries.** Ambiguous provider results never
   auto-retry with a fresh key; they re-POST the SAME `Idempotency-Key`.
   Residual risk: provider idempotency-window lapse (mitigation: 90 s grace +
   */5 drain). This is "effectively-once logical sending with durable
   reconciliation", not absolute exactly-once (impossible over networks).
4. **Persist-first webhooks.** The endpoint's only hard dependency is the
   inbox insert; processing is async with a cron backstop, so webhook-before-
   send-result races self-heal via `logical_event_id` tags echoed by Resend.
5. **Currency & timezone ride with the booking** (payload), never global env;
   invalid IANA zones fall back to UTC explicitly.
6. **Schema auto-mapping is type-validated.** Required columns with
   incompatible types abort the migration with a `SCHEMA MAPPING` error;
   optional columns degrade loudly (WARNING) to NULL-safe expressions; text
   date/amount columns get regex-guarded casts (garbage → NULL, never a
   runtime explosion).
7. **Business defaults**: INR default currency + Asia/Kolkata business timezone
   (rate-cap day boundary, scan scheduling, presentation locale `en-IN`);
   per-booking `currency`/`timezone` columns always take precedence. Worker
   endpoint accepts the blueprint's `WEBHOOK_SECRET` / `x-webhook-secret` /
   `{"type":"HEALTHCHECK"}` aliases alongside the canonical names.
8. **Rate limiting is layered**: token bucket (rps/burst, Retry-After pause,
   batch abort on 429) + DB daily caps (soft 85 defers marketing +1 day,
   hard 100 parks critical +15 min — Resend free plan aware).

## Verification (actually executed — see `tests/run_all.sh`)

| Suite | Assertions | Result |
|---|---|---|
| Unit (`node --test`, esbuild-transpiled libs) | 38 | ✅ |
| Database (26-test SQL suite incl. welcome/win-back/IST, fresh + v1-upgraded + blueprint-variant DBs) | 29 checks | ✅ |
| Schema safety (§25 negative+positive on dedicated DBs) | 2 | ✅ |
| Integration — edge worker (real Deno ↔ real PostgREST ↔ real PG ↔ mock Resend) | 67 | ✅ |
| Integration — routes (webhook + unsubscribe) | 40 | ✅ |
| E2E full lifecycle (booking→delivered, crash→recovery, accept→DB-fail→no-dup, double refunds, one-click unsub loop) | 25 | ✅ |
| Chaos — 3 workers/40 rows, webhook storms, out-of-order, 429 storm | 18 | ✅ |
| Concurrency — 20 claimers/100 rows disjoint+non-blocking; suppression race 30/30 converge | ✅ | ✅ |
| Security — authn, RLS via anon JWT, SQLi/XSS/CRLF/URL injection, token forgery/tamper/swap/bit-flip/expiry/enumeration, secret-leak & PII-in-logs scans | 37 | ✅ |
| Typecheck (tsc strict + `deno check`) / ESLint / build | — | ✅ |

Reproduce: `npm test` (requires local Postgres; Deno for worker tests —
`tests/run_all.sh` bootstraps the test DB automatically).

## Security posture

* Worker endpoint: shared secret from Vault (cron side) ↔ edge env, constant-time
  compare, fail-closed (503 unconfigured / 401 wrong), body-size bounded.
* Webhook: Svix raw-body verification, replay window (~5 min), 256 KB bound,
  no payload logging, persist-before-process.
* Unsubscribe: HMAC tokens (key in Vault, never in JS), DB-side constant-time
  compare, opaque (no PII in URLs/logs), identical 400s for every invalid case.
* DB: RLS + no public policies + explicit REVOKEs; every RPC SECURITY DEFINER
  with pinned `search_path`, execute granted to service_role only; secrets are
  read from Vault at execution time — never stored in `cron.job` (asserted by test).
* Logs: structured JSON; recipients appear only as salted SHA-256 prefixes;
  keys/tokens redacted (asserted against captured worker logs).
