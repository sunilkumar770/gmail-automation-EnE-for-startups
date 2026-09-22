# GoRentals Email System v2 — Setup & Verification Guide

Deploy the hardened v2 pipeline end-to-end. Work top to bottom; every step is
copy-pasteable. ≈45 minutes (mostly Resend DNS propagation).

> Upgrading from v1? Migration `001` migrates your data in place: pending
> `email_queue` rows become `email_outbox` rows (v1 `processing` rows become
> `UNKNOWN` and self-reconcile), `suppression_list` entries map into
> source-aware `email_suppressions`. v1 tables are kept read-only for audit.

---

## Step 0 — Prerequisites

| Requirement | Check |
|---|---|
| Supabase CLI ≥ 1.136 | `supabase --version` |
| Node ≥ 18.17 + npm | `node --version` |
| Deno ≥ 1.40 (only for local `npm test`) | `deno --version` |
| Local Postgres (only for local `npm test`) | `psql --version` |
| Resend account + API key (`re_…`) | dashboard |
| DNS control for gorentals.com | — |
| `PROJECT_REF` | Supabase Dashboard → Settings → General |

Repo layout expected by your Next.js app:

```
app/api/resend-webhook/route.ts      app/api/unsubscribe/route.ts
lib/supabase-rpc.ts                  supabase/migrations/000…sql + 001…sql
supabase/functions/notify-lifecycle/{index.ts,lib/*}
```

```bash
npm i svix            # webhook route dependency (only one)
supabase link --project-ref YOUR_PROJECT_REF
```

## Step 1 — Reconciliation (BEFORE pushing)

```bash
psql "$SUPABASE_DB_URL" -f scripts/00_reconcile_schema.sql > reconciliation_report.txt
```

Review §7 (live `bookings.status` values) and the column maps. Migration 001
**type-validates** the mapping: required columns (`id`, renter ref, status)
with incompatible types abort with a loud `SCHEMA MAPPING:` error instead of
silently building a broken view. The migration also prints its own
reconciliation NOTICE report — read it during `db push`.

Optional per-booking correctness columns (additive, nullable, safe on prod):

```sql
alter table public.bookings add column if not exists currency text;   -- else defaults to email_config.default_currency
alter table public.bookings add column if not exists timezone text;   -- else customer times render in UTC
```

## Step 2 — Extensions

Dashboard → Database → Extensions (or SQL editor): **pg_cron**, **pg_net**,
**pgcrypto** (pgcrypto is required — unsubscribe HMACs use it).

## Step 3 — Push migrations

```bash
supabase db push     # applies 000 → 001 → 002 (all idempotent)
```

Confirm in output: reconciliation NOTICEs (v3 mapping reports owner source +
city), `trigger trg_bookings_email_v2 attached (fail-loud)`,
`trigger trg_profiles_email_v2 attached (welcome emails)`,
`cron v3: … reminder 09:00 IST, review 09:05 IST, winback Mon 09:30 IST`,
`002 COMPLETE`.

Business defaults applied by 002: `default_currency='INR'`,
`business_timezone='Asia/Kolkata'`, `email_locale='en-IN'` — adjust in
`email_config` if your market differs. For per-booking values add
`bookings.currency` / `bookings.timezone` (or `listings.timezone`) columns —
they always take precedence over the defaults.

## Step 4 — Secrets

```bash
openssl rand -hex 32      # → EMAIL_INTERNAL_SECRET value
```

> Naming: the launch blueprint calls this `WEBHOOK_SECRET`. Both names work —
> the edge function reads `EMAIL_INTERNAL_SECRET` first, then `WEBHOOK_SECRET`;
> cron pulls Vault `EMAIL_INTERNAL_SECRET` first, then `WEBHOOK_SECRET`; the
> function accepts `x-internal-secret` **or** `x-webhook-secret` headers, and
> `{"type":"DRAIN_QUEUE"}` as an alias for `{"action":"DRAIN_QUEUE"}`.
> Pick ONE name and use the same value in both stores.

Vault (SQL editor):

```sql
insert into vault.secrets (name, secret, description)
values ('EMAIL_INTERNAL_SECRET', '<hex>', 'pg_cron→edge fn shared secret');
-- UNSUB_TOKEN_SECRET is auto-created by migration 001; verify:
select name, created_at from vault.secrets
where name in ('EMAIL_INTERNAL_SECRET','UNSUB_TOKEN_SECRET');
```

Edge function secrets:

```bash
supabase secrets set \
  RESEND_API_KEY=re_YourKey \
  EMAIL_INTERNAL_SECRET='<SAME hex as Vault>' \
  RESEND_FROM_EMAIL='GoRentals <bookings@gorentals.com>' \
  RESEND_REPLY_TO='support@gorentals.com' \
  APP_URL='https://gorentals.com'
# optional tuning: RATE_RPS=2 RATE_BURST=3 DRAIN_BATCH_SIZE=25 RESEND_TIMEOUT_MS=20000
supabase secrets list
```

## Step 5 — Deploy worker + point cron at it

```bash
supabase functions deploy notify-lifecycle --no-verify-jwt
```

```sql
update public.email_config
set value='https://YOUR_PROJECT_REF.supabase.co/functions/v1/notify-lifecycle', updated_at=now()
where key='edge_function_url';
```

`--no-verify-jwt` is intentional (pg_cron cannot mint user JWTs); the function
fails closed without the shared secret (503 unconfigured, 401 wrong — both
asserted by the security suite).

Cron schedules run in **UTC** — retune reminder/review hours to your market by
re-scheduling with the same command (see RUNBOOK §3).

## Step 6 — Resend: domain + webhook

1. Domains → Add `send.gorentals.com` (or gorentals.com) → create the shown
   **SPF (TXT)**, **DKIM (TXT)**, **Return-Path (MX)** records → wait for Verified.
2. DMARC on gorentals.com — week 1 monitoring, then tighten:
   `_dmarc TXT "v=DMARC1; p=none; rua=mailto:dmarc@gorentals.com; fo=1"`
3. Webhooks → Create → `https://gorentals.com/api/resend-webhook`, subscribe:
   `email.sent`, `email.delivered`, `email.bounced`, `email.complained`,
   `email.delivery_delayed`, `email.failed`, `email.suppressed`,
   `suppression.added`, `suppression.removed` → copy the `whsec_…` signing secret.

## Step 7 — Next.js (Vercel)

Add both routes + `lib/supabase-rpc.ts`, then env vars (server-side only):

```
RESEND_WEBHOOK_SECRET=whsec_…
SUPABASE_SERVICE_ROLE_KEY=eyJ…        (never NEXT_PUBLIC_*)
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
```

```bash
vercel deploy --prod
```

The unsubscribe page/route needs no extra env — token HMACs are minted and
verified inside Postgres (key in Vault), so there is no JS-side secret to leak.

## Step 8 — (Optional) DB-webhook enqueue mode

Default is **trigger mode** (atomic with the business write — recommended;
fail-loud). For externally-written rows: set `enqueue_source='webhook'` in
`email_config`, then create **three** Supabase DB Webhooks targeting
`notify-lifecycle` (Edge Function type, or HTTP with the `X-Webhook-Secret`
header):

| Table | Events | Produces |
|---|---|---|
| `profiles` | INSERT | `WELCOME:{user_id}` |
| `bookings` | INSERT + UPDATE | request / confirmation / cancellation pairs |
| `refunds` | INSERT + UPDATE | `REFUND_ISSUED:{refund_id}` on transition into a final state |

Smoke: `curl -X POST $FN -H 'x-webhook-secret: …' -H 'content-type: application/json' -d '{"type":"HEALTHCHECK"}'`

Exactly one path is ever active; `UNIQUE(logical_event_id)` makes accidental
overlap harmless.

## Step 8b — (Optional) React Email previews

```bash
npx email dev --dir emails     # visual preview at localhost:3000
```

`emails/*.tsx` are **preview only** — production sends render from
`supabase/functions/notify-lifecycle/lib/templates.ts` (Deno cannot compile
React Email JSX; supabase/discussions#40286). A drift-guard unit test fails
the build when key copy diverges between the two.

## Step 9 — Local verification (before touching prod traffic)

```bash
npm test        # full pipeline: build → typecheck → lint → unit → db →
                # integration (real PostgREST+PG+Deno) → e2e → chaos → security
```

Requires local Postgres + Deno; the harness bootstraps its own database
(`gr_v2_it`) and kills stale test processes itself.

## Step 10 — Deployed verification

```bash
export PROJECT_REF=… EMAIL_INTERNAL_SECRET='<vault value>' TEST_TO=you@yourdomain.com
export DB_URL='postgresql://postgres.YOUR_PROJECT_REF:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'
export APP_BASE_URL=https://gorentals.com APP_WEBHOOK_URL=$APP_BASE_URL/api/resend-webhook
export RESEND_WEBHOOK_SECRET=whsec_…
bash scripts/curl_tests.sh
```

13 sections: liveness → 401s → HEALTHCHECK v2 → fake booking (trigger→outbox)
→ DRAIN → TRACE chain → TEST_SEND to your inbox → signed webhook sim →
unsubscribe round-trip (incl. forged-token 400) → scans/processor → cron
health + zero-secret-leak check → dead-letter review with replay example.

## Step 11 — Go-live checklist

- [ ] Reconciliation report attached to deploy ticket; no `!! NOT FOUND`/`SCHEMA MAPPING` errors
- [ ] `cron.job`: 7 `gorentals-email-*` jobs (drain/stale/events/cleanup/reminder/review/winback), zero secret literals (curl_tests §12 asserts)
- [ ] Vault: `EMAIL_INTERNAL_SECRET` + `UNSUB_TOKEN_SECRET`; edge secrets match
- [ ] `edge_function_url` set; HEALTHCHECK 200 (`"version":"2"`)
- [ ] Wrong secret → 401 (curl_tests §2/§3)
- [ ] Resend domain Verified (SPF+DKIM+Return-Path); DMARC live (`p=none` week 1)
- [ ] Test email in inbox (not spam); From/Return-Path domain-aligned
- [ ] Webhook test event → `email_provider_events` row + state advance; bounce sim → `email_suppressions` (`source=resend`)
- [ ] Unsubscribe: GET confirm page, POST one-click → `source=user` row; forged token → identical 400
- [ ] Caps reviewed: `daily_soft_cap=85`/`daily_hard_cap=100` (free plan). Paid plan → raise both.
- [ ] `npm test` green locally; RUNBOOK.md assigned an owner

## Rollback / kill-switches

```sql
-- pause everything (queues keep accumulating durably):
update cron.job set active=false where jobname like 'gorentals-email-%';
-- stop new intents only (worker keeps draining what exists):
update public.email_config set value='off' where key='enqueue_source';   -- triggers AND webhook handler stand down
-- full v2→quiescent (data preserved):
drop trigger if exists trg_bookings_email_v2 on public.bookings;
drop trigger if exists trg_refunds_email_v2 on public.refunds;
```

Resume by reversing. Outbox rows are durable throughout — nothing is lost by
pausing; the worker catches up on re-enable.
