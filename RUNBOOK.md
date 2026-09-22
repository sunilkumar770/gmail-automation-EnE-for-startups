# GoRentals Email System v2 — Operational Runbook

Owner: on-call engineer. Daily check ≈ 2 minutes. All SQL/curl copy-pasteable.
`$FN` = `https://<ref>.supabase.co/functions/v1/notify-lifecycle`,
`$EMAIL_INTERNAL_SECRET` = the Vault value, `$DB_URL` = session-mode connection.

---

## 1. Daily health check

```bash
curl -sS -X POST "$FN" -H "x-internal-secret: $EMAIL_INTERNAL_SECRET" \
  -H 'content-type: application/json' -d '{"action":"HEALTHCHECK"}' | jq
```

| Field | Healthy | Investigate |
|---|---|---|
| `outbox.QUEUED` | < 50 | > 200 or rising twice in a row |
| `outbox.CLAIMED` / `SENDING` | 0–25 | > 25 across two checks (drainer stuck) |
| `unknown_awaiting_reconcile` | 0–few | persistent > 0 for > 30 min (§4.2) |
| `outbox.DEAD` growth | ≈ 0/day | +5/day (§4.5) |
| `oldest_due_age_minutes` | < 15 | > 30 (cron/lease/net) |
| `daily_sends` | < soft cap | ≥ 85: marketing auto-defers (by design; volume review) |
| `events_pending` | ≈ 0 | > 100 for > 10 min (processor/cron issue §4.6) |
| `events_failed` | ≈ 0 | any `orphan:` errors (§4.6) |
| `bounced_24h` vs sends | < 2% | > 3% → deliverability incident (§4.7) |
| `edge_function_url_set` | true | false → SETUP Step 5 |

SQL sweep:

```sql
select j.jobname, r.status, left(coalesce(r.return_message,''),60), r.start_time
from cron.job_run_details r join cron.job j on j.jobid=r.jobid
where j.jobname like 'gorentals-email-%' and r.start_time > now() - interval '1 hour'
order by r.start_time desc;                              -- 12+ succeeded drain runs expected

select id, status_code, left(content::text,120) from net._http_response
order by id desc limit 12;                               -- 200/201 from the edge fn

select state, count(*) from email_outbox group by 1 order by 2 desc;
```

## 2. Operator tools (the v2 command surface)

```bash
# Full correlation chain for any email:
curl -sS -X POST "$FN" -H "x-internal-secret: $SECRET" -H 'content-type: application/json' \
  -d '{"action":"TRACE","logical_event_id":"BOOKING_CONFIRMATION:<BOOKING-UUID>"}' | jq
# → outbox (state, audit_log) + every attempt (keys, provider ids, errors) + provider events

# Safe dead-letter replay (audit preserved; attempts reset; blocked if suppressed
# or state not in DEAD/FAILED/BOUNCED/SUPPRESSED):
curl … -d '{"action":"REPLAY","outbox_id":"<uuid>","note":"ticket #123"}'

# Manual catch-up / one-off flush:
curl … -d '{"action":"DRAIN_QUEUE"}'
curl … -d '{"action":"PROCESS_EVENTS","limit":500}'
```

```sql
-- Dead letters with full context:
select o.logical_event_id, o.template_key||'@'||o.template_version as tpl,
       o.recipient, o.attempts, o.first_failed_at, o.last_error,
       (select a.provider_idempotency_key from email_send_attempts a
         where a.outbox_id=o.id order by a.attempt_number desc limit 1) as last_key
from email_outbox o where o.state='DEAD' order by o.updated_at desc;

-- Ambiguous rows awaiting reconciliation:
select logical_event_id, recipient, attempts, next_attempt_at
from email_outbox where state='UNKNOWN';

-- Orphaned webhook events (no correlation yet):
select provider_event_id, event_type, retry_count, processing_error, received_at
from email_provider_events where processing_status='failed' order by received_at desc limit 20;

-- Suppression administration (source-aware!):
select source, reason, count(*) from email_suppressions where removed_at is null group by 1,2;
select public.email_unsuppress('customer@example.com');        -- false-positive fix
-- provider removals only ever clear source='resend' rows (by design)

-- Campaign controls:
update email_config set value='2' where key='review_campaign_version';  -- re-run review asks legitimately
update email_config set value='0' where key='daily_soft_cap';           -- suspend marketing only
update email_config set value='off' where key='enqueue_source';         -- pause ALL new intents
update cron.job set active=false where jobname like 'gorentals-email-%';-- pause everything
```

Retention runs daily 03:00 (`email_cleanup`): processed provider events > 90 d
deleted; attempts of terminal rows > 365 d deleted; terminal outbox rows > 730 d
archived to `email_outbox_archive` then deleted. Tune via `email_config`
(`retention_*`); suppressions and unprocessed events are never auto-deleted.

## 3. Week-1 plan

| Day | Focus | Actions |
|---|---|---|
| Mon | Deploy + verify | `scripts/curl_tests.sh` all green; TEST_SEND every template to yourself; check Gmail/Apple/Outlook rendering; confirm webhook test event lands in `email_provider_events` |
| Tue | Real traffic | First organic bookings end-to-end: outbox → ACCEPTED → `email.delivered` rows. Watch `unknown_awaiting_reconcile` (should stay ~0) |
| Wed | Failure paths | Bounce drill: enqueue to `nonexistent@your-domain-404.com` → expect DEAD-or-BOUNCED + auto-suppression. Replay drill on it after unsuppress |
| Thu | Rate behavior | Temporarily `daily_soft_cap=5` → confirm marketing defers +1d while critical flows; **restore 85** |
| Fri | Crash & concurrency | Fire two DRAINs back-to-back (second must return `"skipped"`); age a row's `locked_at` by 30 min → `requeue-stale` cron must recover it within 10 min |
| Weekend | Steady state | Daily check only |
| EOW | Review | Bounce < 2%, complaints < 0.1%, DEAD explained, DMARC pass 100% → tighten DMARC `p=quarantine`; size caps vs volume; archive this runbook |

Cron v3 schedule (IST-anchored): drain */5 · stale */10 · events */2 ·
cleanup 03:00 UTC · reminder 03:30 UTC (09:00 IST) · review 03:35 UTC
(09:05 IST) · win-back Mondays 04:00 UTC (09:30 IST; tiers 30/60/90).
Retune example:

```sql
select cron.schedule_in_database('gorentals-email-booking-reminder','0 1 * * *', command, database)
from cron.job where jobname='gorentals-email-booking-reminder';
```

**Win-back operations:** tiers target users idle in `[N, N+7)` days — the
weekly cadence means each user passes through each tier window exactly once.
Campaign ids look like `WB30-2026-W39`; re-runs inside the same ISO week
dedupe automatically via `UNIQUE(logical_event_id)`. Suppressed users get an
audited `SUPPRESSED` outbox row instead of a send. Deferred marketing volume
rolls +24 h from the cap breach (deliberately not aligned to 09:00 — avoids a
thundering herd at the daily reset).

**Welcome emails:** `WELCOME:{user_id}` fires on `profiles` INSERT (trigger or
webhook mode); recipients without any email address are a logged no-op, never
an error.

## 4. Troubleshooting playbooks

### 4.1 Nothing sends at all
1. HEALTHCHECK 200? No → deploy/URL (`email_config.edge_function_url`).
2. `net._http_response.status_code` 401 → **secret mismatch** Vault vs `supabase secrets` (must be byte-identical; re-do SETUP Step 4). 503 → `EMAIL_INTERNAL_SECRET` missing on the function.
3. Rows stuck QUEUED with past `next_attempt_at` and drains `"skipped"` → stale lease: `select * from email_runtime_state where key='drain';` — self-expires (240 s); force: `update email_runtime_state set lease_expires_at=null where key='drain';`
4. DEAD rows with `Resend 401/403` → API key/domain problem.

### 4.2 Rows sitting in UNKNOWN
Expected transiently (ambiguous provider results reconcile after a 90 s grace).
Persistent UNKNOWN means reconciliation keeps failing:
```sql
select a.error_code, a.error_message, count(*)
from email_send_attempts a join email_outbox o on o.id=a.outbox_id
where o.state='UNKNOWN' group by 1,2;
```
* `network`/`client_timeout` repeatedly → provider outage: leave it; retries are idempotent (same key), they resolve when Resend recovers.
* Attempts at max → row DEADs; verify with Resend support/dashboard whether the message actually went out **before** replaying (the idempotency key makes replay safe within the provider window).

### 4.3 Suspected double-send
```sql
select logical_event_id, count(*) from email_outbox group by 1 having count(*)>1;      -- must be 0 rows (UNIQUE)
select o.logical_event_id, count(*) from email_send_attempts a join email_outbox o on o.id=a.outbox_id
where a.status='accepted' group by 1 having count(*)>1;                                 -- >1 only after deliberate REPLAY
```
The four guards (UNIQUE logical id, lease, SKIP LOCKED, key-stable reconciliation)
make uncontrolled duplicates structurally impossible; a second `accepted`
attempt with the SAME key is a provider-deduped reconcile (not a second email) —
check `provider_email_id` equality to confirm.

### 4.4 Backlog growth
Drain capacity ≈ 25/batch × 12/hr per cron ≈ thousands/hr; real backlogs mean
failures (4.1), caps (`daily_sends` ≥ 85 → marketing defers by design), or
rate-limit aborts (`stopped_early` in drain responses / logs). One-off flush:
fire DRAIN_QUEUE manually a few times — concurrency-safe.

### 4.5 DEAD letters
Classify via `last_error`: `payload invalid` (fix data, REPLAY), `no renderer
deployed for X@vN` (you rolled back code below a queued template version —
redeploy that version or migrate rows:
`update email_outbox set template_version=<available> where …`), `Resend 422`
(bad address — no replay without fixing recipient), exhausted 5xx (REPLAY
after provider recovery).

### 4.6 Webhook statuses not updating
1. Resend dashboard → webhook delivery log: 4xx? → signature/env mismatch
   (`RESEND_WEBHOOK_SECRET` on Vercel). 5xx? → Vercel logs (RPC/DB).
2. `events_pending` high → inline processing failing; cron `*/2` is the
   backstop — check `cron.job_run_details` for `process-events`.
3. `orphan:` errors → events for emails sent outside this system or attempts
   rows deleted by retention too early; raw payloads are retained — correlate
   manually via `provider_email_id` in the Resend dashboard.
4. After fixes, Resend retries automatically (or dashboard → Retry); all
   processing is idempotent.

### 4.7 Bounce-rate spike (> 3%)
```sql
select reason, count(*) from email_suppressions
where created_at > now()-interval '24 hours' and removed_at is null group by 1;
```
Concentrated on one domain → their MTA issue. Across old addresses → list
hygiene (never import stale lists). Marketing-only spike → suspend via
`daily_soft_cap=0`, investigate content/sending pattern. Temporary bounces are
NOT suppressed by design (they become DELAYED and retry).

### 4.8 Spam placement
From/Return-Path DKIM-aligned? DMARC aggregate reports passing? Marketing
keeps `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
(never strip them); multipart text part present; new domains ramp ~2×/week
(the 85/day soft cap enforces week-1 discipline automatically).

## 5. Escalation

* **P1** transactional mail down > 15 min: pause cron (§2 kill-switch), page
  Resend status, failover = send confirmations synchronously from the app via
  Resend SDK; logical ids make catch-up safe (duplicates collapse).
* **P2** webhook ingest down: no immediate customer impact (Resend retries for
  hours; inbox + cron backstop self-heal). Fix same day.
* **P3** cosmetic/template/marketing deferrals: ticket, fix this week.

## 6. Follow-ups (tracked, non-blocking)

| Item | Notes |
|---|---|
| Review deep-link `/bookings/:id?review=1` opens the modal | frontend |
| Rebooking flows: enqueue with explicit `p_logical_event_id` suffix (`:R2`) | product decision documented in README §Design-2 |
| Resend paid plan → raise `daily_soft_cap`/`daily_hard_cap` | growth |
| Alerting: wire HEALTHCHECK JSON into uptime monitor with §1 thresholds | SRE |
| `email_outbox_archive` offload to object storage when > 1M rows | DBA |
