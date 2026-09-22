# Phase 1 — Repository Audit (defect ledger, evidence-based)

Scope: full inspection of every file in the repository as of the v1 delivery
(migration `000_email_system_init.sql`, edge function `notify-lifecycle/index.ts`,
route `app/api/resend-webhook/route.ts`, scripts, docs). Source code treated as
truth; README claims cross-checked against implementation.

Severity: **P0** = data loss / duplicate send / security blocker · **P1** = major
reliability or correctness defect · **P2** = quality/compliance gap.

## P0 — must fix before production

| # | Defect | Evidence | Consequence |
|---|--------|----------|-------------|
| P0-1 | **Triggers swallow all exceptions** (`exception when others then raise warning … return new`) | `000…sql:1101-1105, 1140-1143` | Booking commits with NO email intent — silent, permanent email loss. Violates transactional-outbox durability. |
| P0-2 | **Dedupe identity is booking-scoped, not event-scoped.** Queue `dedupe_key = md5(template\|recipient\|booking_id\|payload.dedupe_key)`; log key = `md5(booking\|template\|recipient\|status_event)` | `000…sql:388-392, 428-431` | Two legitimate refunds on one booking **collapse into a single email** (second is rejected as `duplicate_pending` / `already_logged`). Legitimate repeated business events are incorrectly deduplicated. |
| P0-3 | **Refund emails trigger on INSERT only** | `000…sql:1156` | If business flow inserts refunds as `pending` and later updates to `processed`, the refund email is **never sent** (insert skipped as non-final; update never fires). |
| P0-4 | **Partial unique index race**: dedupe covers only `status IN ('queued','processing')`; `already_logged` precheck happens *before* send but the `accepted` log row is written *after* the Resend call | `000…sql:398-401`; `index.ts` precheck→send→result sequence | Two queue rows for one logical email claimed by two concurrent drainers can both pass precheck → **duplicate send**. Provider `Idempotency-Key` (per queue-row id, not per logical event) does not reliably close this. |
| P0-5 | **Ambiguous provider results handled as blind retries.** Network timeout → `retryable: true` | `index.ts:487-493` | If Resend actually accepted the email, the retry can double-send once the provider idempotency window lapses. No `UNKNOWN` state, no reconciliation procedure. |
| P0-6 | **Webhook ingestion depends on the `email_log` anchor row existing** (`where resend_email_id=… and status_event='accepted'`); webhook route processes inline with no durable inbox | `000…sql:913-917`; `route.ts` step 4 | Race: Resend can fire `email.sent` before the worker writes its result → event is logged as `template='unknown', booking=NULL` — correlation **permanently lost**. If the RPC fails, the event is only recoverable via Resend retries. |
| P0-7 | **Unsubscribe: advertised but nonexistent, PII-leaking, forgeable.** `List-Unsubscribe` + footer URLs embed the raw email (`/api/unsubscribe?email=user@…`); no endpoint is implemented | `index.ts:199, 251, 422` | Gmail/Yahoo one-click hits a 404 (compliance failure); raw emails leak into logs/history/Referer; anyone could unsubscribe any address (if it existed). |

## P1 — reliability/correctness

| # | Defect | Evidence | Consequence |
|---|--------|----------|-------------|
| P1-1 | No send-attempt ledger — only `attempts` counter + `error_log` jsonb array on the queue row | `000…sql:377-386` | Cannot correlate attempt ↔ provider email id ↔ timing; no audit trail for reconciliation; replay is unsafe. |
| P1-2 | No formal state machine — statuses `queued/processing/sent/dead` with no transition validation; `requeue_stale_locks` blindly requeues `processing` rows even when the provider may have accepted | `000…sql:373-374, requeue fn` | Invalid states reachable; stale recovery relies solely on provider idempotency to avoid duplicates. |
| P1-3 | Suppression conflates **source** and **reason** (single `reason` column); provider-removal logic keys off `reason='resend_suppressed'`; user unsubscribes indistinguishable from manual blocks | `000…sql: suppression_list` | A Resend `suppression.removed` event can delete a user's unsubscribe (wrong ownership inference); no rank/escalation rules. |
| P1-4 | No template registry/versioning; unknown templates enqueue fine and die at drain ("poisoned rows"); queued rows render with whatever code is deployed at drain time | `index.ts:559`; no DB-side validation | Late failures instead of enqueue-time rejection; silent rendering changes for in-flight queue. |
| P1-5 | No payload schema validation (`payload jsonb` free-form; renderer tolerates missing fields) | `index.ts` templates | Corrupted emails rendered silently (e.g. missing dates render "—"). |
| P1-6 | Rate limiting = `sleep(150ms)` + DB daily caps; no token bucket, no `Retry-After` handling, no per-minute provider awareness | `index.ts:48, 679` | 429 storms possible; free-tier per-minute caps unmanaged. |
| P1-7 | Webhook body unbounded (`await req.text()` with no size cap) | `route.ts:117` | DoS vector via huge payloads. |
| P1-8 | No retention/cleanup for `email_queue` / `email_log` / events | repo-wide | Unbounded growth. |
| P1-9 | Schema auto-detection **blindly casts** (`b.%I::uuid`, `::numeric`, `::timestamptz`) without validating column data types | `000…sql:264-306` | Schema drift (e.g. text column with non-uuid data) yields a view that explodes at runtime — inside triggers. |

## P2 — quality/compliance

| # | Defect | Evidence |
|---|--------|----------|
| P2-1 | Global `CURRENCY` env instead of per-booking currency | `index.ts:42,179` |
| P2-2 | Customer-facing dates always rendered in UTC | `index.ts:171` |
| P2-3 | No `package.json`, no `npm test`; QA harness lives outside the repo | repo root |
| P2-4 | No structured logging / single correlation chain; recipient appears raw in some error paths | `index.ts` console calls |
| P2-5 | No operator tooling: dead-letter replay, trace by logical event | — |
| P2-6 | `handle_db_webhook_event` assumes `record->>'id'` instead of detected PK column | `000…sql` §12 |

## Architectural root causes (fix these, not symptoms)

1. **No canonical logical-event identity** → P0-2, P0-3, P0-4. Fix: `logical_event_id` with a **full** `UNIQUE` constraint on a transactional outbox; refund events keyed by `refund_id`; reminders by `(booking,start_date)`; campaigns by `(recipient,period)`.
2. **Durability treated as optional in triggers** → P0-1. Fix: fail-loud triggers; outbox insert inside the business transaction; only "no recipient" is a legitimate no-op.
3. **Provider interaction without an attempt ledger and without ambiguity handling** → P0-5, P1-1, P1-2. Fix: `email_send_attempts`, explicit `SENDING→UNKNOWN` on ambiguous outcomes, idempotency-key reconciliation, formal state machine with enforced transitions.
4. **Webhook processed inline against mutable state instead of durably ingested** → P0-6. Fix: `email_provider_events` inbox (persist-first, unique provider event id, async rank-guarded processor, tag-based correlation fallback).
5. **Suppression modeled by reason only** → P1-3, P0-7. Fix: `source × reason` model with rank escalation and source-scoped removal; HMAC unsubscribe tokens (pgcrypto + Vault) and a real endpoint.
6. **No template/payload contract** → P1-4, P1-5, P2-1, P2-2. Fix: versioned `email_templates` registry with JSON schemas, validation at enqueue (SQL) and pre-render (Zod), version frozen on the outbox row, per-booking currency/timezone in payload.

The v2 implementation (migration `001_email_system_v2.sql`, edge function v2,
webhook route v2, unsubscribe route, test suites) addresses every row above;
each fix is mapped to an automated test in `tests/`.
