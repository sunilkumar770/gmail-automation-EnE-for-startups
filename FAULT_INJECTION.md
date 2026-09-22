# Failure Injection Matrix (§33)

Every injection point, the mechanism used to test it, and the five verdicts:
**Lost?** (email intent disappears) · **Dup?** (uncontrolled duplicate send) ·
**Stuck?** (row permanently unprocessable) · **Inconsistent?** (DB disagrees
with provider irrecoverably) · **Replayable?** (operator can safely retry).

| # | Injection point | How tested | Lost | Dup | Stuck | Inconsistent | Replay |
|---|-----------------|-----------|------|-----|-------|--------------|--------|
| 1 | Before DB transaction | analysis: nothing written yet; business caller sees the error and retries | no | no | no | no | n/a |
| 2 | During outbox insert (trigger RAISE) | **db T1**: template disabled → booking INSERT rolls back entirely | no — booking and intent fail together (atomic) | no | no | no | business retry re-enqueues |
| 3 | After outbox insert, pre-commit | same transaction as #2 (postgres atomicity); **db T2** | no | no | no | no | n/a |
| 4 | After claim, before begin_send | **db T13** + **e2e S2**: `SIGKILL` mid-drain; CLAIMED rows stale-recover to QUEUED **without consuming an attempt** | no | no | no (stale cron */10) | no | automatic |
| 5 | Before/during rendering | **edge poison-row** test: invalid payload & missing renderer → DEAD with explicit reason, zero provider calls | no (audited DEAD) | no | no | no | **REPLAY** after fix |
| 6 | After begin_send, before provider request | **e2e S2** crash variant: SENDING + attempt `sending` → stale → UNKNOWN → reconcile | no | no — reconcile reuses the SAME idempotency key | no (90 s grace then reconcilable) | no | automatic |
| 7 | During provider request (timeout/reset) | **edge T4** (malformed-200 ambiguity), **chaos** socket-destroy: classified `ambiguous` → UNKNOWN → reconcile | no | no — key reuse makes the re-POST a provider-side no-op returning the stored id | no | no | automatic |
| 8 | After provider accepts, response lost | **edge T4**: mock stores the accept, returns unusable 200 → UNKNOWN → reconcile resolves to ACCEPTED with the stored id; provider unique-accept count stays 1 | no | no | no | no | automatic |
| 9 | After accept, before DB result write | **e2e S3**: kill -9 inside the write window → attempt stays `sending` → stale → UNKNOWN → reconcile; exactly one logical send | no | no | no | no | automatic |
| 10 | During result write (DB/RPC failure) | **edge**: `record_result` failure → row left SENDING → stale → UNKNOWN → reconcile (logged `record_result_failed`) | no | no | no | no | automatic |
| 11 | After result write | nothing pending; webhooks continue the lifecycle (**routes §3**) | no | no | no | no | n/a |
| 12 | Before webhook persistence | **routes**: ingest RPC failure → HTTP 500 → Resend retries (same svix-id dedupes later) | no | no | no | no | provider retry |
| 13 | After persistence, before processing | **db T10 / routes**: event stays `pending`; inline processor is best-effort, cron `*/2` is the backstop | no | no — UNIQUE(provider, provider_event_id) | no | no | automatic |
| 14 | During webhook processing | **db T10/T10b**: per-event exception block → `failed` + `retry_count`; orphan retried until correlation exists, then processed | no | no — rank guard makes reprocessing idempotent | no (10 retries then operator-visible `failed`) | no | cron retry |

## Infrastructure-level failures

| Scenario | Mechanism | Verdict |
|----------|-----------|---------|
| Database restart | outbox/attempts/inbox are durable tables; in-flight transactions roll back → rows remain QUEUED/CLAIMED → stale recovery | no loss, no dup |
| Worker unavailable (deploy, outage) | rows wait in QUEUED (next_attempt_at passed); first drain after recovery catches up; lease prevents overlap | no loss, no dup |
| Provider unavailable (5xx/429 storm) | **edge 429-storm + chaos 429**: RETRY_WAIT with backoff [1m,5m,15m,1h,6h]±20% jitter; DEAD only after 5 attempts; **REPLAY** available; 429 pauses the token bucket and aborts the batch (no hammering) | no loss, no dup, no premature dead |
| Duplicate worker execution (double cron fire) | **chaos**: 3 instances × concurrent drains; lease serializes; SKIP LOCKED makes overlap disjoint even if the lease lapses; **claim test**: 20 sessions/100 rows disjoint | no dup |
| Webhook duplicate/replay storm | **chaos**: 10 concurrent identical deliveries → 1 inbox row, 1 transition, audit shows a single DELIVERED | no dup state change |
| Webhook out-of-order | **chaos**: 5 events concurrently → deterministic COMPLAINED (rank guard); **routes**: delivered-before-sent, late-sent blocked | consistent |
| Deployment/restart mid-queue | template versions are frozen per row (`template_key@version`); old-version rows dead-letter with `no renderer deployed` only if the code for that version was deleted — documented rollback hazard in RUNBOOK | no silent mis-render |

## What CANNOT be guaranteed (honest boundaries)

* **Absolute exactly-once delivery** is impossible across a network boundary.
  The guarantee implemented is *effectively-once logical sending with durable
  reconciliation*: at most one ACCEPTED outcome per `logical_event_id`, with
  provider-side idempotency covering the ambiguous window. Residual risk: if
  the provider's idempotency window lapses before reconciliation runs
  (mitigated by the 90 s grace + */5 min drain), a duplicate send is
  theoretically possible.
* Mail-client one-click POSTs depend on client compliance (Gmail/Yahoo honor
  RFC 8058; others may not) — the mailto fallback and the GET confirmation
  page cover the rest.
