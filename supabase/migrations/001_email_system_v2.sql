-- ============================================================================
-- GoRentals Email System v2 — 001_email_system_v2.sql
-- ============================================================================
-- Implements the architecture mandated by the production-hardening review
-- (see AUDIT.md for the defect ledger this fixes):
--
--   * TRUE TRANSACTIONAL OUTBOX      email_outbox (triggers fail loud — no
--                                    swallowed exceptions; intent commits
--                                    atomically with the business row)
--   * CANONICAL IDEMPOTENCY          logical_event_id TEXT UNIQUE (full, not
--                                    partial) — one durable row per logical
--                                    email event, forever
--   * SEND ATTEMPT LEDGER            email_send_attempts (per-attempt provider
--                                    ids, idempotency keys, timings, errors)
--   * AMBIGUITY HANDLING             SENDING → UNKNOWN on ambiguous provider
--                                    results; reconciliation re-POSTs with the
--                                    SAME provider idempotency key
--   * PROVIDER WEBHOOK INBOX         email_provider_events (persist-first,
--                                    UNIQUE(provider, provider_event_id),
--                                    async rank-guarded processor, tag-based
--                                    correlation fallback — never depends on
--                                    send-result rows existing first)
--   * FORMAL STATE MACHINE           14 states, app-transition matrix +
--                                    provider rank guard (out-of-order and
--                                    duplicate webhooks are deterministic)
--   * SUPPRESSION source × reason    rank escalation; provider removals only
--                                    ever touch source='resend'
--   * SECURE UNSUBSCRIBE             HMAC tokens (pgcrypto, key in Vault),
--                                    constant-time compare, no raw PII in URLs
--   * TEMPLATE REGISTRY + VERSIONING email_templates(key, version, enabled,
--                                    schema, logical_id_pattern); version is
--                                    frozen on the outbox row at enqueue
--   * PAYLOAD SCHEMA VALIDATION      SQL validator at enqueue (triggers) +
--                                    Zod re-validation in the worker
--   * TYPE-SAFE SCHEMA MAPPING       ctx view detection validates column data
--                                    types; required-column mismatches FAIL
--                                    LOUDLY instead of casting blindly
--   * CURRENCY + TIMEZONE            carried per booking through payload
--   * RETRY ENGINE                   classified failures, backoff schedule
--                                    [1m,5m,15m,1h,6h] ±20% jitter, DEAD after
--                                    max_attempts (default 5)
--   * DLQ + REPLAY + TRACE           email_replay(), email_trace()
--   * RETENTION                      email_cleanup() + daily cron
--
-- ID TAXONOMY (six distinct identities — never conflated):
--   1. business event id      bookings.id / refunds.id (source rows)
--   2. logical email event id email_outbox.logical_event_id  (idempotency)
--   3. outbox id              email_outbox.id                (row identity)
--   4. send attempt id        email_send_attempts.id         (one per try)
--   5. provider email id      Resend `id` (email_…)          (provider side)
--   6. provider event id      svix-id of webhook delivery    (inbox dedupe)
--
-- IDEMPOTENT: safe to re-run. Upgrades a v1 database in place (data migrated).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- SECTION A — config additions
-- ----------------------------------------------------------------------------
-- Additive, nullable columns (no rewrite, no default) so per-booking currency
-- and presentation timezone are first-class. Safe on production tables.
do $$
begin
  if to_regclass('public.bookings') is not null then
    alter table public.bookings add column if not exists currency text;
    alter table public.bookings add column if not exists timezone text;
  end if;
end $$;

insert into public.email_config (key, value) values
  ('review_campaign_version',  '1'),     -- bump to re-run review campaign legitimately
  ('reconcile_grace_seconds',  '90'),    -- UNKNOWN → earliest reconcile time
  ('stale_claim_minutes',      '10'),
  ('stale_sending_minutes',    '10'),
  ('retention_events_days',    '90'),    -- processed provider events
  ('retention_attempts_days',  '365'),   -- attempts of terminal outbox rows
  ('retention_outbox_days',    '730'),   -- terminal outbox rows → archive
  ('unsub_token_ttl_days',     '')       -- empty = tokens do not expire
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- SECTION B — TEMPLATE REGISTRY (versioned, schema-validated)
-- ----------------------------------------------------------------------------
create table if not exists public.email_templates (
  key               text        not null,
  version           integer     not null default 1,
  enabled           boolean     not null default true,
  category          text        not null default 'transactional'
                    check (category in ('transactional','marketing')),
  critical          boolean     not null default false,
  logical_id_pattern text       not null,
  payload_schema    jsonb       not null default '{"required":[],"properties":{}}'::jsonb,
  subject_template  text,
  description       text,
  created_at        timestamptz not null default now(),
  primary key (key, version)
);
alter table public.email_templates enable row level security;

insert into public.email_templates (key, version, enabled, category, critical, logical_id_pattern, payload_schema, subject_template, description) values
 ('booking_confirmation', 1, true, 'transactional', true,
  'BOOKING_CONFIRMATION:{booking_id}',
  '{"required":["booking_id"],"properties":{"booking_id":{"type":"uuid"},"listing_title":{"type":"string"},"starts_at":{"type":"timestamptz"},"ends_at":{"type":"timestamptz"},"amount":{"type":"number"},"currency":{"type":"string"}}}',
  'Confirmed — {listing_title} on GoRentals', 'Renter confirmation (critical)'),
 ('booking_host_confirmation', 1, true, 'transactional', true,
  'BOOKING_HOST_CONFIRMATION:{booking_id}',
  '{"required":["booking_id"],"properties":{"booking_id":{"type":"uuid"},"listing_title":{"type":"string"},"starts_at":{"type":"timestamptz"},"ends_at":{"type":"timestamptz"},"amount":{"type":"number"},"currency":{"type":"string"}}}',
  'New confirmed booking — {listing_title}', 'Owner confirmation (critical)'),
 ('booking_request_owner', 1, true, 'transactional', true,
  'BOOKING_REQUEST_OWNER:{booking_id}',
  '{"required":["booking_id"],"properties":{"booking_id":{"type":"uuid"},"listing_title":{"type":"string"},"starts_at":{"type":"timestamptz"},"ends_at":{"type":"timestamptz"}}}',
  'Booking request pending — {listing_title}', 'Owner approval request'),
 ('booking_cancelled_renter', 1, true, 'transactional', true,
  'BOOKING_CANCELLED_RENTER:{booking_id}',
  '{"required":["booking_id"],"properties":{"booking_id":{"type":"uuid"},"listing_title":{"type":"string"},"starts_at":{"type":"timestamptz"}}}',
  'Your booking was cancelled — {listing_title}', 'Renter cancellation'),
 ('booking_cancelled_owner', 1, true, 'transactional', true,
  'BOOKING_CANCELLED_OWNER:{booking_id}',
  '{"required":["booking_id"],"properties":{"booking_id":{"type":"uuid"},"listing_title":{"type":"string"},"starts_at":{"type":"timestamptz"}}}',
  'Booking cancelled — {listing_title}', 'Owner cancellation'),
 ('refund_issued', 1, true, 'transactional', true,
  'REFUND_ISSUED:{refund_id}',
  '{"required":["refund_id","amount"],"properties":{"refund_id":{"type":"uuid"},"booking_id":{"type":"uuid"},"amount":{"type":"number"},"currency":{"type":"string"},"listing_title":{"type":"string"}}}',
  'Refund issued — {amount}', 'Keyed by REFUND id — multiple partial refunds each send exactly once'),
 ('booking_reminder', 1, true, 'transactional', true,
  'BOOKING_REMINDER:{booking_id}:{starts_date}',
  '{"required":["booking_id","starts_at"],"properties":{"booking_id":{"type":"uuid"},"listing_title":{"type":"string"},"starts_at":{"type":"timestamptz"},"ends_at":{"type":"timestamptz"},"timezone":{"type":"string"}}}',
  'Starts soon — {listing_title}', 'Date-scoped: a rescheduled booking legitimately reminds again'),
 ('access_instructions', 1, true, 'transactional', true,
  'ACCESS_INSTRUCTIONS:{booking_id}',
  '{"required":["booking_id"],"properties":{"booking_id":{"type":"uuid"},"listing_title":{"type":"string"},"starts_at":{"type":"timestamptz"}}}',
  'Access instructions — {listing_title}', 'Check-in details'),
 ('review_request', 1, true, 'marketing', false,
  'REVIEW_REQUEST:{booking_id}:{campaign}',
  '{"required":["booking_id"],"properties":{"booking_id":{"type":"uuid"},"listing_title":{"type":"string"},"ends_at":{"type":"timestamptz"}}}',
  'How was {listing_title}?', 'Campaign-versioned via email_config.review_campaign_version'),
 ('win_back', 1, true, 'marketing', false,
  'WIN_BACK:{recipient}:{campaign}',
  '{"required":["campaign"],"properties":{"campaign":{"type":"string"}}}',
  'We miss you — your next adventure awaits', 'Campaign period supplied by the marketing caller')
on conflict (key, version) do update
  set enabled = excluded.enabled, category = excluded.category, critical = excluded.critical,
      logical_id_pattern = excluded.logical_id_pattern, payload_schema = excluded.payload_schema,
      subject_template = excluded.subject_template, description = excluded.description;

create or replace function public.email_resolve_template(p_key text)
returns public.email_templates
language sql stable security definer
set search_path = public
as $$
  select * from public.email_templates t
  where t.key = p_key and t.enabled
  order by t.version desc limit 1;
$$;

-- ----------------------------------------------------------------------------
-- SECTION C — PAYLOAD SCHEMA VALIDATOR (mini JSON-Schema dialect)
-- supported types: uuid | number | string | timestamptz | enum | object | array
-- ----------------------------------------------------------------------------
create or replace function public.email_validate_payload(
  p_key text, p_version integer, p_payload jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_schema  jsonb;
  v_errors  text[] := '{}';
  v_req     text;
  v_prop    text;
  v_def     jsonb;
  v_val     jsonb;
  v_type    text;
  v_num     numeric;
begin
  select payload_schema into v_schema from public.email_templates
  where key = p_key and version = p_version;
  if v_schema is null then
    return jsonb_build_object('ok', false, 'errors', array['unknown template ' || p_key || '@' || p_version]);
  end if;

  foreach v_req in array coalesce(array(select jsonb_array_elements_text(v_schema->'required')),'{}'::text[])
  loop
    v_val := p_payload -> v_req;
    if v_val is null or v_val = 'null'::jsonb or btrim(coalesce(v_val #>> '{}', '')) = '' then
      v_errors := v_errors || ('missing required field: ' || v_req);
    end if;
  end loop;

  for v_prop, v_def in select * from jsonb_each(coalesce(v_schema->'properties','{}'::jsonb))
  loop
    v_val := p_payload -> v_prop;
    if v_val is null or v_val = 'null'::jsonb then continue; end if;  -- optional unless required
    v_type := v_def ->> 'type';
    case v_type
      when 'uuid' then
        if jsonb_typeof(v_val) <> 'string' or v_val #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          v_errors := v_errors || (v_prop || ': not a uuid');
        end if;
      when 'string' then
        if jsonb_typeof(v_val) <> 'string' then
          v_errors := v_errors || (v_prop || ': not a string');
        end if;
      when 'number' then
        if jsonb_typeof(v_val) = 'number' then null;
        elsif jsonb_typeof(v_val) = 'string' then
          begin v_num := (v_val #>> '{}')::numeric; exception when others then v_num := null; end;
          if v_num is null then v_errors := v_errors || (v_prop || ': not a number'); end if;
        else
          v_errors := v_errors || (v_prop || ': not a number');
        end if;
      when 'timestamptz' then
        if jsonb_typeof(v_val) <> 'string' then
          v_errors := v_errors || (v_prop || ': not an ISO timestamp');
        else
          begin perform (v_val #>> '{}')::timestamptz;
          exception when others then v_errors := v_errors || (v_prop || ': unparseable timestamp'); end;
        end if;
      when 'object' then
        if jsonb_typeof(v_val) <> 'object' then v_errors := v_errors || (v_prop || ': not an object'); end if;
      when 'array' then
        if jsonb_typeof(v_val) <> 'array' then v_errors := v_errors || (v_prop || ': not an array'); end if;
      else null;
    end case;
    if v_def ? 'enum' and jsonb_typeof(v_val) = 'string' then
      if not (v_def->'enum' @> v_val) then
        v_errors := v_errors || (v_prop || ': not in enum ' || (v_def->'enum')::text);
      end if;
    end if;
  end loop;

  return jsonb_build_object('ok', cardinality(v_errors) = 0, 'errors', v_errors);
end $$;

-- ----------------------------------------------------------------------------
-- SECTION D — OUTBOX (transactional, canonically deduped)
-- ----------------------------------------------------------------------------
create table if not exists public.email_outbox (
  id                uuid primary key default gen_random_uuid(),
  logical_event_id  text not null unique,              -- canonical idempotency identity
  template_key      text not null,
  template_version  integer not null,
  recipient         text not null,                     -- lower/btrim normalized
  payload           jsonb not null default '{}',
  state             text not null default 'QUEUED'
                    check (state in ('QUEUED','CLAIMED','SENDING','ACCEPTED','DELAYED','DELIVERED',
                                     'BOUNCED','COMPLAINED','FAILED','RETRY_WAIT','UNKNOWN',
                                     'DEAD','CANCELLED','SUPPRESSED')),
  priority          smallint not null default 5,
  attempts          integer not null default 0,        -- incremented at begin_send only
  max_attempts      integer not null default 5,
  next_attempt_at   timestamptz not null default now(),
  locked_at         timestamptz,
  locked_by         text,
  replay_count      integer not null default 0,
  audit_log         jsonb not null default '[]',       -- [{at,from,to,by,note}]
  first_failed_at   timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (template_key, template_version) references public.email_templates (key, version)
);

create index if not exists email_outbox_claim_idx
  on public.email_outbox (priority, next_attempt_at, created_at)
  where state in ('QUEUED','RETRY_WAIT') or (state = 'UNKNOWN');
create index if not exists email_outbox_state_idx   on public.email_outbox (state, updated_at);
create index if not exists email_outbox_recipient_idx on public.email_outbox (recipient);
create index if not exists email_outbox_created_idx on public.email_outbox (created_at);

comment on table public.email_outbox is
  'Transactional outbox + durable queue. Triggers insert here inside the business transaction (fail-loud). logical_event_id UNIQUE = exactly one durable intent per logical email event.';

-- ----------------------------------------------------------------------------
-- SECTION E — SEND ATTEMPT LEDGER
-- ----------------------------------------------------------------------------
create table if not exists public.email_send_attempts (
  id                       uuid primary key default gen_random_uuid(),
  outbox_id                uuid not null references public.email_outbox(id) on delete cascade,
  attempt_number           integer not null,
  provider                 text not null default 'resend',
  provider_idempotency_key text not null,             -- stable per logical attempt; reused on reconcile
  provider_email_id        text,                       -- Resend email id once known
  request_started_at       timestamptz not null default now(),
  request_finished_at      timestamptz,
  status                   text not null default 'sending'
                           check (status in ('sending','accepted','failed','unknown')),
  error_code               text,
  error_message            text,
  response_metadata        jsonb not null default '{}',
  created_at               timestamptz not null default now(),
  unique (outbox_id, attempt_number)
);
-- at most ONE in-flight request per idempotency key (reconcile reuses keys)
create unique index if not exists email_attempts_inflight_key_uidx
  on public.email_send_attempts (provider_idempotency_key) where status = 'sending';
create index if not exists email_attempts_provider_email_idx
  on public.email_send_attempts (provider_email_id) where provider_email_id is not null;
create index if not exists email_attempts_outbox_idx on public.email_send_attempts (outbox_id);

comment on table public.email_send_attempts is
  'One row per provider interaction (including reconciliation re-POSTs). The append-only source of truth for what the provider saw.';

-- ----------------------------------------------------------------------------
-- SECTION F — PROVIDER WEBHOOK INBOX
-- ----------------------------------------------------------------------------
create table if not exists public.email_provider_events (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null default 'resend',
  provider_event_id  text not null,                   -- svix-id (stable across retries)
  provider_email_id  text,
  event_type         text not null,
  raw_payload        jsonb not null,
  occurred_at        timestamptz,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  processing_status  text not null default 'pending'
                     check (processing_status in ('pending','processed','failed')),
  processing_error   text,
  retry_count        integer not null default 0,
  outbox_id          uuid,
  unique (provider, provider_event_id)
);
create index if not exists email_provider_events_pending_idx
  on public.email_provider_events (received_at) where processing_status in ('pending','failed');
create index if not exists email_provider_events_email_idx
  on public.email_provider_events (provider_email_id) where provider_email_id is not null;

comment on table public.email_provider_events is
  'Durable webhook inbox. Persist-first (unique provider+event id makes duplicates harmless); processed asynchronously by process_provider_events() with rank-guarded state transitions. Never depends on send-result rows existing.';

-- ----------------------------------------------------------------------------
-- SECTION G — SUPPRESSIONS (source × reason, rank-escalated)
-- ----------------------------------------------------------------------------
create table if not exists public.email_suppressions (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,                       -- lower/btrim (trigger)
  source         text not null check (source in ('resend','user','manual','system')),
  reason         text not null check (reason in ('bounce','complaint','unsubscribe','manual_block','suppressed','legacy')),
  detail         jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  removed_at     timestamptz,
  removed_reason text
);
create unique index if not exists email_suppressions_active_uidx
  on public.email_suppressions (email) where removed_at is null;
create index if not exists email_suppressions_email_idx on public.email_suppressions (email);

create or replace function public.email_suppressions_normalize()
returns trigger language plpgsql as $$
begin new.email := lower(btrim(new.email)); return new; end $$;
drop trigger if exists trg_email_suppressions_normalize on public.email_suppressions;
create trigger trg_email_suppressions_normalize
  before insert or update of email on public.email_suppressions
  for each row execute function public.email_suppressions_normalize();

-- source authority ranks: user intent outranks provider state outranks bulk ops
create or replace function public.email_suppression_rank(p_source text)
returns integer language sql immutable as $$
  select case p_source when 'user' then 4 when 'manual' then 3 when 'resend' then 2 else 1 end;
$$;

create or replace function public.email_apply_suppression(
  p_email text, p_source text, p_reason text, p_detail jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email,'')));
  v_cur   public.email_suppressions;
begin
  if v_email = '' or position('@' in v_email) = 0 then
    return jsonb_build_object('applied', false, 'reason', 'invalid email');
  end if;
  select * into v_cur from public.email_suppressions
  where email = v_email and removed_at is null limit 1;

  if v_cur.id is null then
    -- Concurrent-insert race (e.g. provider bounce + user unsubscribe at the
    -- same instant): the partial unique index arbitrates, and the DO UPDATE
    -- branch rank-compares so the HIGHER source wins regardless of arrival
    -- order — a user unsubscribe can never be recorded as provider-owned.
    insert into public.email_suppressions (email, source, reason, detail)
    values (v_email, p_source, p_reason, coalesce(p_detail,'{}'))
    on conflict (email) where removed_at is null do update
      set source = case when public.email_suppression_rank(excluded.source)
                             > public.email_suppression_rank(public.email_suppressions.source)
                        then excluded.source else public.email_suppressions.source end,
          reason = case when public.email_suppression_rank(excluded.source)
                             > public.email_suppression_rank(public.email_suppressions.source)
                        then excluded.reason else public.email_suppressions.reason end,
          detail = public.email_suppressions.detail || coalesce(p_detail,'{}');
    return jsonb_build_object('applied', true, 'email', v_email, 'source', p_source, 'escalated', false);
  end if;

  -- escalate only upward (a provider bounce must never downgrade a user unsubscribe)
  if public.email_suppression_rank(p_source) > public.email_suppression_rank(v_cur.source) then
    update public.email_suppressions
    set source = p_source, reason = p_reason,
        detail = detail || coalesce(p_detail,'{}') || jsonb_build_object('escalated_from', v_cur.source)
    where id = v_cur.id;
    return jsonb_build_object('applied', true, 'email', v_email, 'source', p_source, 'escalated', true);
  end if;
  return jsonb_build_object('applied', false, 'email', v_email, 'reason', 'existing stronger suppression', 'kept_source', v_cur.source);
end $$;

-- Provider-side removals may ONLY clear provider-owned suppressions.
create or replace function public.email_remove_provider_suppression(p_email text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v_email text := lower(btrim(coalesce(p_email,''))); v_n integer;
begin
  update public.email_suppressions
  set removed_at = now(), removed_reason = 'provider suppression.removed'
  where email = v_email and removed_at is null and source = 'resend';
  get diagnostics v_n = row_count;
  return jsonb_build_object('removed', v_n, 'email', v_email,
    'note', 'user/manual/system suppressions are never auto-removed');
end $$;

create or replace function public.email_is_suppressed(p_email text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.email_suppressions
                 where email = lower(btrim(coalesce(p_email,''))) and removed_at is null);
$$;

-- compat wrappers used by ops docs / older callers
create or replace function public.email_suppress(p_email text, p_reason text default 'manual')
returns boolean language plpgsql security definer set search_path = public as $$
declare v_src text := case p_reason when 'bounced' then 'resend' when 'complained' then 'resend'
                      when 'resend_suppressed' then 'resend' when 'unsubscribe' then 'user' else 'manual' end;
    v_rsn text := case p_reason when 'bounced' then 'bounce' when 'complained' then 'complaint'
                  when 'resend_suppressed' then 'suppressed' when 'unsubscribe' then 'unsubscribe' else 'manual_block' end;
begin
  return (public.email_apply_suppression(p_email, v_src, v_rsn)->>'applied')::boolean;
end $$;

create or replace function public.email_unsuppress(p_email text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  update public.email_suppressions set removed_at = now(), removed_reason = 'operator unsuppress'
  where email = lower(btrim(coalesce(p_email,''))) and removed_at is null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

-- ----------------------------------------------------------------------------
-- SECTION H — UNSUBSCRIBE TOKENS (HMAC-SHA256, key in Vault, constant-time)
-- token = v1.<b64url(payload)>.<b64url(hmac)>   payload {"e":email,"s":topic,"i":epoch,"x":exp?}
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regclass('vault.secrets') is not null then
    insert into vault.secrets (name, secret, description)
    select 'UNSUB_TOKEN_SECRET', encode(gen_random_bytes(32), 'hex'), 'HMAC key for unsubscribe tokens'
    where not exists (select 1 from vault.secrets where name = 'UNSUB_TOKEN_SECRET');
    raise notice 'UNSUB_TOKEN_SECRET present in vault.';
  else
    raise warning 'vault.secrets not present — unsubscribe token functions will fail until the secret exists.';
  end if;
end $$;

-- NOTE: Postgres encode(base64) wraps lines at 76 chars — newlines MUST be
-- stripped or tokens break silently. Decode is whitespace-tolerant for safety.
create or replace function public.email_b64url_encode(p_bytes bytea)
returns text language sql immutable as $$
  -- chr(10)/chr(13) guards are belt-and-suspenders: Postgres base64 does not
  -- line-wrap, but tokens must never contain whitespace under ANY runtime.
  select rtrim(replace(replace(replace(replace(encode(p_bytes, 'base64'),
    chr(10), ''), chr(13), ''), '+', '-'), '/', '_'), '=');
$$;

create or replace function public.email_b64url_decode(p_text text)
returns bytea language sql immutable as $$
  select decode(
    replace(replace(c.clean, '-', '+'), '_', '/')
    || repeat('=', (4 - (length(c.clean) % 4)) % 4), 'base64')
  from (select replace(replace(replace(replace(coalesce(p_text,''),
          chr(10), ''), chr(13), ''), ' ', ''), chr(9), '') as clean) c;
$$;

create or replace function public.email_unsub_hmac(p_message text)
returns bytea
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_key text;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets
  where name = 'UNSUB_TOKEN_SECRET' limit 1;
  if v_key is null then
    raise exception 'UNSUB_TOKEN_SECRET missing from vault';
  end if;
  return public.hmac(p_message::bytea, decode(v_key, 'escape'), 'sha256');
end $$;

create or replace function public.email_ct_equals(p_a bytea, p_b bytea)
returns boolean language plpgsql immutable as $$
declare i integer; v_diff integer := 0;
begin
  if length(p_a) <> length(p_b) then return false; end if;
  for i in 1..length(p_a) loop
    v_diff := v_diff # (get_byte(p_a, i-1) # get_byte(p_b, i-1));
  end loop;
  return v_diff = 0;
end $$;

create or replace function public.email_unsub_token(
  p_email text, p_topic text default 'marketing', p_ttl_days integer default null)
returns text
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_b64     text;
  v_ttl     integer := coalesce(p_ttl_days, nullif(public.email_cfg('unsub_token_ttl_days'),'')::int);
begin
  v_payload := jsonb_build_object(
    'e', lower(btrim(p_email)), 's', p_topic, 'i', floor(extract(epoch from now()))::bigint);
  if v_ttl is not null and v_ttl > 0 then
    v_payload := v_payload || jsonb_build_object('x', floor(extract(epoch from now() + make_interval(days => v_ttl)))::bigint);
  end if;
  v_b64 := public.email_b64url_encode(convert_to(v_payload::text, 'UTF8'));
  return 'v1.' || v_b64 || '.' || public.email_b64url_encode(public.email_unsub_hmac(v_b64));
end $$;

create or replace function public.email_unsub_verify(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_parts  text[];
  v_expect bytea;
  v_got    bytea;
  v_payload jsonb;
  v_exp    bigint;
begin
  if p_token is null or p_token = '' then
    return jsonb_build_object('valid', false, 'reason', 'empty');
  end if;
  v_parts := string_to_array(p_token, '.');
  if cardinality(v_parts) <> 3 or v_parts[1] <> 'v1' then
    return jsonb_build_object('valid', false, 'reason', 'malformed');
  end if;
  begin
    v_expect := public.email_unsub_hmac(v_parts[2]);
    v_got    := public.email_b64url_decode(v_parts[3]);
  exception when others then
    return jsonb_build_object('valid', false, 'reason', 'malformed');
  end;
  if not public.email_ct_equals(v_expect, v_got) then
    return jsonb_build_object('valid', false, 'reason', 'signature');
  end if;
  begin
    v_payload := convert_from(public.email_b64url_decode(v_parts[2]), 'UTF8')::jsonb;
  exception when others then
    return jsonb_build_object('valid', false, 'reason', 'malformed');
  end;
  v_exp := (v_payload->>'x')::bigint;
  if v_exp is not null and v_exp < floor(extract(epoch from now()))::bigint then
    return jsonb_build_object('valid', false, 'reason', 'expired');
  end if;
  return jsonb_build_object('valid', true, 'email', v_payload->>'e', 'topic', coalesce(v_payload->>'s','marketing'));
end $$;

create or replace function public.email_apply_unsubscribe(p_token text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v jsonb := public.email_unsub_verify(p_token);
begin
  if not coalesce((v->>'valid')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', v->>'reason');
  end if;
  return public.email_apply_suppression(v->>'email', 'user', 'unsubscribe',
           jsonb_build_object('topic', v->>'topic'))
         || jsonb_build_object('ok', true);
end $$;

-- ----------------------------------------------------------------------------
-- SECTION I — STATE MACHINE
-- ----------------------------------------------------------------------------
-- App-originated transitions (worker/ops) — explicit matrix.
-- Provider-originated transitions — rank guard (see email_apply_provider_state).
create or replace function public.email_state_transition_ok(p_from text, p_to text)
returns boolean
language sql immutable
set search_path = public
as $$
  select p_to = any (case p_from
    when 'QUEUED'     then array['CLAIMED','CANCELLED','SUPPRESSED','DEAD']
    when 'CLAIMED'    then array['SENDING','QUEUED','DEAD','SUPPRESSED','CANCELLED']
    when 'SENDING'    then array['ACCEPTED','UNKNOWN','RETRY_WAIT','DEAD']
    when 'UNKNOWN'    then array['CLAIMED','ACCEPTED','RETRY_WAIT','DEAD']
    when 'RETRY_WAIT' then array['CLAIMED','DEAD','CANCELLED']
    when 'ACCEPTED'   then array[]::text[]          -- provider events only (rank path)
    when 'DELAYED'    then array[]::text[]
    when 'DELIVERED'  then array[]::text[]
    when 'FAILED'     then array['QUEUED']          -- replay
    when 'DEAD'       then array['QUEUED']          -- replay
    when 'BOUNCED'    then array['QUEUED']          -- replay (guarded: unsuppressed)
    when 'SUPPRESSED' then array['QUEUED']          -- replay (guarded: unsuppressed)
    else array[]::text[]                            -- COMPLAINED / CANCELLED terminal
  end);
$$;

-- Provider ranks: strictly-increasing application prevents out-of-order regressions
create or replace function public.email_state_rank(p_state text)
returns integer language sql immutable as $$
  select case p_state
    when 'QUEUED' then 10 when 'CLAIMED' then 20 when 'SENDING' then 30
    when 'UNKNOWN' then 35 when 'RETRY_WAIT' then 40
    when 'ACCEPTED' then 50 when 'DELAYED' then 55 when 'DELIVERED' then 60
    when 'FAILED' then 65 when 'BOUNCED' then 70 when 'SUPPRESSED' then 80
    when 'COMPLAINED' then 85 when 'DEAD' then 90 when 'CANCELLED' then 95
    else -1 end;
$$;

create or replace function public.email_outbox_audit(
  p_id uuid, p_from text, p_to text, p_by text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.email_outbox
  set audit_log = audit_log || jsonb_build_array(jsonb_build_object(
        'at', now(), 'from', p_from, 'to', p_to, 'by', p_by,
        'note', left(coalesce(p_note,''), 500))),
      updated_at = now()
  where id = p_id;
end $$;

create or replace function public.email_outbox_transition(
  p_id uuid, p_to text, p_by text, p_note text default null,
  p_next_attempt_at timestamptz default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare r public.email_outbox;
begin
  select * into r from public.email_outbox where id = p_id for update;
  if r.id is null then
    raise exception 'outbox row % not found', p_id;
  end if;
  if r.state = p_to then
    return jsonb_build_object('ok', true, 'state', r.state, 'noop', true);
  end if;
  if not public.email_state_transition_ok(r.state, p_to) then
    raise exception 'invalid state transition % -> % (outbox %)', r.state, p_to, p_id;
  end if;
  update public.email_outbox
  set state = p_to,
      next_attempt_at = coalesce(p_next_attempt_at, next_attempt_at),
      locked_at = case when p_to in ('QUEUED','ACCEPTED','DEAD','CANCELLED','SUPPRESSED','RETRY_WAIT','UNKNOWN','DELIVERED','BOUNCED','COMPLAINED','FAILED','DELAYED') then null else locked_at end,
      locked_by = case when p_to in ('QUEUED','ACCEPTED','DEAD','CANCELLED','SUPPRESSED','RETRY_WAIT','UNKNOWN','DELIVERED','BOUNCED','COMPLAINED','FAILED','DELAYED') then null else locked_by end,
      updated_at = now()
  where id = p_id;
  perform public.email_outbox_audit(p_id, r.state, p_to, p_by, p_note);
  return jsonb_build_object('ok', true, 'from', r.state, 'state', p_to);
end $$;

-- Provider-originated transition (rank-guarded; deterministic under reordering)
create or replace function public.email_apply_provider_state(
  p_id uuid, p_to text, p_by text, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare r public.email_outbox;
begin
  select * into r from public.email_outbox where id = p_id for update;
  if r.id is null then
    return jsonb_build_object('ok', false, 'reason', 'outbox row not found');
  end if;
  if not (p_to in ('ACCEPTED','DELAYED','DELIVERED','FAILED','BOUNCED','COMPLAINED')) then
    raise exception 'email_apply_provider_state: % is not a provider state', p_to;
  end if;
  if public.email_state_rank(r.state) < 30 then
    -- QUEUED/CLAIMED: message was never sent under this correlation — anomaly
    perform public.email_outbox_audit(p_id, r.state, r.state, p_by, 'ANOMALY provider event on unsent row: ' || coalesce(p_note,''));
    return jsonb_build_object('ok', false, 'reason', 'provider event on unsent row', 'state', r.state);
  end if;
  if public.email_state_rank(p_to) <= public.email_state_rank(r.state) then
    perform public.email_outbox_audit(p_id, r.state, r.state, p_by, 'stale/out-of-order provider event ignored (' || coalesce(p_to,'') || '): ' || coalesce(p_note,''));
    return jsonb_build_object('ok', true, 'skipped_stale', true, 'state', r.state);
  end if;
  update public.email_outbox
  set state = p_to, locked_at = null, locked_by = null, updated_at = now()
  where id = p_id;
  perform public.email_outbox_audit(p_id, r.state, p_to, p_by, p_note);
  return jsonb_build_object('ok', true, 'from', r.state, 'state', p_to);
end $$;

-- ----------------------------------------------------------------------------
-- SECTION J — RETRY / RATE helpers
-- ----------------------------------------------------------------------------
create or replace function public.email_backoff_next(p_attempt integer)
returns timestamptz
language sql volatile
set search_path = public
as $$
  -- schedule [1m, 5m, 15m, 1h, 6h] with ±20% jitter
  select now() + (array[interval '1 minute', interval '5 minutes', interval '15 minutes',
                        interval '1 hour', interval '6 hours']
                 )[least(greatest(p_attempt, 1), 5)]
         * (0.8 + random() * 0.4);
$$;

create or replace function public.email_daily_send_count()
returns integer
language sql stable security definer
set search_path = public
as $$
  select count(*)::integer from public.email_send_attempts
  where status = 'accepted' and request_finished_at >= date_trunc('day', now());
$$;

create or replace function public.email_is_critical_template(p_template text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.email_templates t
                 where t.key = p_template and t.enabled and t.critical)
      or p_template = any (select btrim(x) from unnest(string_to_array(
             coalesce(public.email_cfg('critical_templates'),''), ',')) x where btrim(x) <> '');
$$;

create or replace function public.email_rate_decision(p_template text)
returns text
language sql stable security definer
set search_path = public
as $$
  select case
    when c.daily < coalesce(nullif(public.email_cfg('daily_soft_cap'),'')::int, 85) then 'allow'
    when public.email_is_critical_template(p_template)
         and c.daily < coalesce(nullif(public.email_cfg('daily_hard_cap'),'')::int, 100) then 'allow'
    when public.email_is_critical_template(p_template) then 'defer_hour'
    else 'defer_day'
  end
  from (select public.email_daily_send_count() as daily) c;
$$;

-- ----------------------------------------------------------------------------
-- SECTION K — LOGICAL EVENT ID DERIVATION + ENQUEUE (fail-loud)
-- ----------------------------------------------------------------------------
create or replace function public.email_derive_logical_id(
  p_key text, p_version integer, p_recipient text, p_payload jsonb)
returns text
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_pattern text;
  v_out     text;
  v_token   text;
  v_val     text;
begin
  select logical_id_pattern into v_pattern from public.email_templates
  where key = p_key and version = p_version;
  if v_pattern is null then
    raise exception 'unknown template %@%', p_key, p_version;
  end if;
  v_out := v_pattern;
  foreach v_token in array coalesce(
    (select array_agg(distinct m[1]) from regexp_matches(v_pattern, '\{([a-z_]+)\}', 'g') as m),
    '{}'::text[])
  loop
    v_val := case v_token
      when 'booking_id'  then nullif(p_payload->>'booking_id','')
      when 'refund_id'   then nullif(p_payload->>'refund_id','')
      when 'recipient'   then nullif(lower(btrim(p_recipient)),'')
      when 'starts_date' then to_char((nullif(p_payload->>'starts_at',''))::timestamptz, 'YYYY-MM-DD')
      when 'ends_date'   then to_char((nullif(p_payload->>'ends_at',''))::timestamptz, 'YYYY-MM-DD')
      when 'campaign'    then coalesce(nullif(p_payload->>'campaign',''),
                                        nullif(public.email_cfg('review_campaign_version'),''))
      when 'dedupe_key'  then nullif(p_payload->>'dedupe_key','')
      else null
    end;
    if v_val is null then
      raise exception 'cannot derive logical_event_id for %: payload missing "%"', p_key, v_token;
    end if;
    v_out := replace(v_out, '{' || v_token || '}', v_val);
  end loop;
  return upper(v_out);
end $$;

create or replace function public.enqueue_email_v2(
  p_template_key   text,
  p_recipient      text,
  p_payload        jsonb    default '{}'::jsonb,
  p_priority       integer  default null,
  p_logical_event_id text   default null,
  p_template_version integer default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_tpl        public.email_templates;
  v_recipient  text := lower(btrim(coalesce(p_recipient,'')));
  v_logical    text;
  v_validation jsonb;
  v_rate       text;
  v_next       timestamptz := now();
  v_priority   smallint;
  v_id         uuid;
  v_existing   uuid;
  v_state      text := 'QUEUED';
  v_note       text := 'enqueued';
begin
  -- recipient validity: absent recipient is a legitimate business no-op (NOT an
  -- error — a booking without a renter email must not roll back); malformed is an error.
  if v_recipient = '' then
    return jsonb_build_object('status','skipped','reason','no_recipient');
  end if;
  if position('@' in v_recipient) = 0 or position('.' in split_part(v_recipient,'@',2)) = 0 then
    raise exception 'invalid recipient address for template %: %', p_template_key,
      -- do not echo the full address into server logs unnecessarily
      left(v_recipient, 2) || '***';
  end if;
  -- header/transport injection guard: no control chars or internal whitespace
  if v_recipient ~ '[[:cntrl:]]' or position(' ' in v_recipient) > 0 then
    raise exception 'invalid recipient for template %: control/whitespace characters rejected', p_template_key;
  end if;

  select * into v_tpl from public.email_resolve_template(p_template_key);
  if v_tpl.key is null then
    raise exception 'unknown or disabled email template: %', p_template_key;
  end if;
  if p_template_version is not null and p_template_version <> v_tpl.version then
    select * into v_tpl from public.email_templates where key = p_template_key and version = p_template_version;
    if v_tpl.key is null then
      raise exception 'template % v% does not exist', p_template_key, p_template_version;
    end if;
  end if;

  -- validate BEFORE deriving the logical id: operators get the full field-level
  -- error list, not a derivation side-effect
  v_validation := public.email_validate_payload(v_tpl.key, v_tpl.version, p_payload);
  if not (v_validation->>'ok')::boolean then
    raise exception 'payload validation failed for %: %', v_tpl.key, (v_validation->'errors')::text;
  end if;

  v_logical := coalesce(p_logical_event_id,
    public.email_derive_logical_id(v_tpl.key, v_tpl.version, v_recipient, p_payload));

  v_priority := coalesce(p_priority::smallint,
    case when v_tpl.critical then 1 when v_tpl.category = 'marketing' then 7 else 5 end);

  if public.email_is_suppressed(v_recipient) then
    v_state := 'SUPPRESSED'; v_note := 'suppressed at enqueue';
  else
    v_rate := public.email_rate_decision(v_tpl.key);
    if v_rate = 'defer_day' then
      v_next := now() + interval '1 day';  v_note := 'rate deferred +1d (soft cap)';
    elsif v_rate = 'defer_hour' then
      v_next := now() + interval '15 minutes'; v_note := 'rate deferred +15m (hard cap)';
    end if;
  end if;

  insert into public.email_outbox
    (logical_event_id, template_key, template_version, recipient, payload,
     state, priority, next_attempt_at)
  values
    (v_logical, v_tpl.key, v_tpl.version, v_recipient, coalesce(p_payload,'{}'),
     v_state, v_priority, v_next)
  on conflict (logical_event_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_existing from public.email_outbox where logical_event_id = v_logical;
    return jsonb_build_object('status','duplicate','logical_event_id', v_logical,
                              'outbox_id', v_existing);
  end if;

  perform public.email_outbox_audit(v_id, null, v_state, 'enqueue', v_note);
  return jsonb_build_object('status', case v_state when 'SUPPRESSED' then 'suppressed' else 'queued' end,
                            'outbox_id', v_id, 'logical_event_id', v_logical,
                            'template_version', v_tpl.version, 'next_attempt_at', v_next);
end $$;

comment on function public.enqueue_email_v2 is
  'Fail-loud enqueue: unknown template, invalid payload, underivable logical id all RAISE (rolling back the calling business transaction). Only absent recipient is a legitimate no-op.';

-- ----------------------------------------------------------------------------
-- SECTION L — WORKER RPCs (claim / begin_send / record_result / prechecks)
-- ----------------------------------------------------------------------------
create or replace function public.claim_outbox_batch(
  p_batch_size integer default 25, p_worker_id text default '')
returns setof public.email_outbox
language plpgsql security definer
set search_path = public
as $$
begin
  return query
  with cte as (
    select o.id
    from public.email_outbox o
    where (o.state in ('QUEUED','RETRY_WAIT')
           or (o.state = 'UNKNOWN'
               and o.next_attempt_at <= now()))   -- due for reconciliation
      and o.next_attempt_at <= now()
    order by o.priority asc, o.next_attempt_at asc, o.created_at asc
    limit greatest(1, least(coalesce(p_batch_size, 25), 100))
    for update skip locked
  )
  update public.email_outbox o
  set state = 'CLAIMED', locked_at = now(), locked_by = p_worker_id, updated_at = now(),
      audit_log = o.audit_log || jsonb_build_array(jsonb_build_object(
        'at', now(), 'from', o.state, 'to', 'CLAIMED', 'by', coalesce(nullif(p_worker_id,''),'worker')))
  from cte where o.id = cte.id
  returning o.*;
end $$;

comment on function public.claim_outbox_batch is
  'Atomic claim: CTE FOR UPDATE SKIP LOCKED + UPDATE state=CLAIMED in one transaction. attempts are NOT consumed here (only begin_send consumes), so claim crashes are free.';

-- Pre-send checks after claim (suppression re-check + rate decision)
create or replace function public.outbox_pre_send_checks(p_outbox_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare r public.email_outbox;
begin
  select * into r from public.email_outbox where id = p_outbox_id;
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'not found'); end if;
  return jsonb_build_object(
    'ok', true,
    'suppressed',    public.email_is_suppressed(r.recipient),
    'rate_decision', public.email_rate_decision(r.template_key),
    'daily_sends',   public.email_daily_send_count(),
    'attempts',      r.attempts,
    'max_attempts',  r.max_attempts,
    'template_key',  r.template_key,
    'template_version', r.template_version,
    'recipient',     r.recipient,
    'payload',       r.payload,
    'reconcile',     r.state = 'UNKNOWN' or exists (
                       select 1 from public.email_send_attempts a
                       where a.outbox_id = r.id and a.status in ('sending','unknown')));
end $$;

-- CLAIMED → SENDING + attempt row creation (idempotency key reuse on reconcile)
create or replace function public.outbox_begin_send(p_outbox_id uuid, p_worker_id text default '')
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  r          public.email_outbox;
  v_num      integer;
  v_key      text;
  v_reuse    text;
  v_attempt  uuid;
begin
  select * into r from public.email_outbox where id = p_outbox_id for update;
  if r.id is null then raise exception 'outbox % not found', p_outbox_id; end if;
  if r.state <> 'CLAIMED' or (p_worker_id <> '' and r.locked_by is distinct from p_worker_id) then
    raise exception 'outbox % not claimed by this worker (state=%, locked_by=%)', p_outbox_id, r.state, r.locked_by;
  end if;

  select coalesce(max(attempt_number), 0) + 1 into v_num
  from public.email_send_attempts where outbox_id = r.id;

  -- Reconciliation: if an ambiguous attempt exists, REUSE its idempotency key so
  -- the provider dedupes instead of double-sending.
  select provider_idempotency_key into v_reuse
  from public.email_send_attempts
  where outbox_id = r.id and status in ('sending','unknown')
  order by attempt_number desc limit 1;

  v_key := coalesce(v_reuse, 'gr-' || r.id || '-' || v_num);

  insert into public.email_send_attempts (outbox_id, attempt_number, provider_idempotency_key)
  values (r.id, v_num, v_key)
  returning id into v_attempt;

  update public.email_outbox
  set attempts = attempts + 1, updated_at = now()
  where id = r.id;
  perform public.email_outbox_transition(r.id, 'SENDING', coalesce(nullif(p_worker_id,''),'worker'),
          'attempt ' || v_num || (case when v_reuse is not null then ' (reconcile, key reused)' else '' end));

  return jsonb_build_object('attempt_id', v_attempt, 'attempt_number', v_num,
                            'idempotency_key', v_key, 'reused_key', v_reuse is not null);
end $$;

-- Record the provider outcome — single transaction: attempt + state + audit.
-- p_outcome: accepted | failed_retryable | failed_permanent | unknown
create or replace function public.outbox_record_result(
  p_outbox_id   uuid,
  p_attempt_id  uuid,
  p_outcome     text,
  p_provider_email_id text default null,
  p_error_code  text default null,
  p_error_message text default null,
  p_response_metadata jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  r        public.email_outbox;
  a        public.email_send_attempts;
  v_state  text;
  v_next   timestamptz;
  v_note   text;
begin
  select * into r from public.email_outbox where id = p_outbox_id for update;
  if r.id is null then raise exception 'outbox % not found', p_outbox_id; end if;
  select * into a from public.email_send_attempts where id = p_attempt_id and outbox_id = r.id for update;
  if a.id is null then raise exception 'attempt % not found for outbox %', p_attempt_id, p_outbox_id; end if;

  update public.email_send_attempts
  set request_finished_at = now(),
      status = case p_outcome when 'accepted' then 'accepted' when 'unknown' then 'unknown' else 'failed' end,
      provider_email_id = coalesce(p_provider_email_id, provider_email_id),
      error_code = p_error_code,
      error_message = left(coalesce(p_error_message,''), 2000),
      response_metadata = coalesce(p_response_metadata,'{}'::jsonb)
  where id = a.id;

  v_state := case p_outcome
    when 'accepted'         then 'ACCEPTED'
    when 'unknown'          then 'UNKNOWN'
    when 'failed_retryable' then case when r.attempts >= r.max_attempts then 'DEAD' else 'RETRY_WAIT' end
    when 'failed_permanent' then 'DEAD'
    else null end;
  if v_state is null then raise exception 'unknown outcome %', p_outcome; end if;

  v_next := case
    when v_state = 'UNKNOWN'    then now() + make_interval(secs => coalesce(nullif(public.email_cfg('reconcile_grace_seconds'),'')::int, 90))
    when v_state = 'RETRY_WAIT' then public.email_backoff_next(r.attempts)
    else r.next_attempt_at end;
  v_note := case
    when v_state = 'ACCEPTED' then 'provider accepted ' || coalesce(p_provider_email_id,'?')
    when v_state = 'UNKNOWN'  then 'ambiguous provider result — reconcile via idempotency key'
    when v_state = 'DEAD'     then 'exhausted/permanent: ' || coalesce(p_error_code,'') || ' ' || left(coalesce(p_error_message,''),160)
    else 'retry scheduled: ' || coalesce(p_error_code,'') || ' ' || left(coalesce(p_error_message,''),160) end;

  update public.email_outbox
  set last_error = case when p_error_message is not null then left(p_error_message, 500) else last_error end,
      first_failed_at = case when p_outcome like 'failed%' then coalesce(first_failed_at, now()) else first_failed_at end,
      updated_at = now()
  where id = r.id;

  return public.email_outbox_transition(r.id, v_state, 'worker:' || coalesce(a.provider,'resend'), v_note, v_next);
end $$;

-- Crash recovery: stale CLAIMED → QUEUED (free); stale SENDING → UNKNOWN
-- (the provider MAY have accepted — never blind-resend; reconcile decides).
create or replace function public.outbox_recover_stale(
  p_claim_minutes integer default null, p_sending_minutes integer default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_claim_m   integer := coalesce(p_claim_minutes, nullif(public.email_cfg('stale_claim_minutes'),'')::int, 10);
  v_sending_m integer := coalesce(p_sending_minutes, nullif(public.email_cfg('stale_sending_minutes'),'')::int, 10);
  v_grace     integer := coalesce(nullif(public.email_cfg('reconcile_grace_seconds'),'')::int, 90);
  v_reclaimed integer; v_unknown integer; v_attempts integer;
begin
  update public.email_outbox
  set state = 'QUEUED', locked_at = null, locked_by = null, updated_at = now(),
      audit_log = audit_log || jsonb_build_array(jsonb_build_object(
        'at', now(), 'from', 'CLAIMED', 'to', 'QUEUED', 'by', 'stale-recovery',
        'note', 'claim lease expired; no attempt was started'))
  where state = 'CLAIMED' and locked_at < now() - make_interval(mins => v_claim_m);
  get diagnostics v_reclaimed = row_count;

  update public.email_send_attempts
  set status = 'unknown', request_finished_at = coalesce(request_finished_at, now()),
      error_code = 'stale', error_message = 'worker vanished mid-send; outcome ambiguous'
  where status = 'sending'
    and request_started_at < now() - make_interval(mins => v_sending_m);
  get diagnostics v_attempts = row_count;

  update public.email_outbox
  set state = 'UNKNOWN', locked_at = null, locked_by = null,
      next_attempt_at = now() + make_interval(secs => v_grace), updated_at = now(),
      audit_log = audit_log || jsonb_build_array(jsonb_build_object(
        'at', now(), 'from', 'SENDING', 'to', 'UNKNOWN', 'by', 'stale-recovery',
        'note', 'worker vanished mid-send; will reconcile with same idempotency key'))
  where state = 'SENDING' and locked_at < now() - make_interval(mins => v_sending_m);
  get diagnostics v_unknown = row_count;

  return jsonb_build_object('reclaimed_claims', v_reclaimed, 'marked_unknown', v_unknown,
                            'attempts_marked_unknown', v_attempts);
end $$;

-- ----------------------------------------------------------------------------
-- SECTION M — PROVIDER EVENT INGEST + PROCESSOR (state machine, suppression)
-- ----------------------------------------------------------------------------
create or replace function public.email_provider_event_ingest(
  p_provider_event_id text, p_event jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_type     text := p_event->>'type';
  v_data     jsonb := coalesce(p_event->'data','{}'::jsonb);
  v_eid      text := coalesce(nullif(p_provider_event_id,''),
                    'synth-' || md5(coalesce(v_type,'') || coalesce(v_data->>'email_id','') || coalesce(p_event->>'created_at','') || v_data::text));
  v_id       uuid;
  v_n        integer;
begin
  if v_type is null or jsonb_typeof(v_data) <> 'object' then
    raise exception 'malformed provider event: missing type/data';
  end if;
  insert into public.email_provider_events
    (provider_event_id, provider_email_id, event_type, raw_payload, occurred_at)
  values
    (v_eid, v_data->>'email_id', v_type, p_event,
     coalesce((nullif(v_data->>'created_at',''))::timestamptz,
              (nullif(p_event->>'created_at',''))::timestamptz, now()))
  on conflict (provider, provider_event_id) do nothing
  returning id into v_id;
  get diagnostics v_n = row_count;
  return jsonb_build_object('inserted', v_n > 0, 'duplicate', v_n = 0,
                            'event_row_id', v_id, 'provider_event_id', v_eid, 'event_type', v_type);
end $$;

comment on function public.email_provider_event_ingest is
  'Persist-first inbox. UNIQUE(provider, provider_event_id) makes duplicate and concurrent deliveries harmless. Never touches email_log/outbox state — processing is separate and retriable.';

create or replace function public.process_provider_events(p_limit integer default 200)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  ev          record;
  v_outbox    uuid;
  v_target    text;
  v_res       jsonb;
  v_btype     text;
  v_bsubtype  text;
  v_recipient text;
  v_tags      jsonb;
  v_counts    jsonb := jsonb_build_object('processed',0,'skipped',0,'failed',0,'orphaned',0);
begin
  for ev in
    select * from public.email_provider_events
    where processing_status in ('pending','failed') and retry_count < 10
    order by received_at asc
    limit greatest(1, least(coalesce(p_limit,200), 1000))
  loop
    begin
      v_outbox := null; v_target := null; v_tags := ev.raw_payload->'data'->'tags';

      -- Correlation 1: provider_email_id → attempt ledger → outbox
      if ev.provider_email_id is not null then
        select a.outbox_id into v_outbox from public.email_send_attempts a
        where a.provider_email_id = ev.provider_email_id
        order by a.request_started_at asc limit 1;
      end if;
      -- Correlation 2 (fallback): logical_event_id tag echoed by provider —
      -- works even if the send-result write raced the webhook.
      if v_outbox is null and jsonb_typeof(v_tags) = 'object' then
        select o.id into v_outbox from public.email_outbox o
        where o.logical_event_id = upper(coalesce(v_tags->>'logical_event_id','')) 
          and v_tags->>'logical_event_id' is not null
        limit 1;
      end if;

      -- suppression.* payloads carry the address directly
      v_recipient := lower(btrim(coalesce(
        ev.raw_payload->'data'->'to'->>0,
        ev.raw_payload->'data'->>'email', '')));

      case ev.event_type
        when 'email.sent'             then v_target := 'ACCEPTED';
        when 'email.delivered'        then v_target := 'DELIVERED';
        when 'email.delivery_delayed' then v_target := 'DELAYED';
        when 'email.complained'       then v_target := 'COMPLAINED';
        when 'email.failed'           then v_target := 'FAILED';
        when 'email.suppressed'       then v_target := 'FAILED';
        when 'email.bounced' then
          v_btype    := lower(coalesce(ev.raw_payload->'data'->'bounce'->>'type',''));
          v_bsubtype := lower(coalesce(ev.raw_payload->'data'->'bounce'->>'subType',''));
          v_target   := case when v_btype in ('', 'permanent') or v_bsubtype = 'suppressed'
                             then 'BOUNCED' else 'DELAYED' end;  -- temporary bounce ≠ terminal
        else v_target := null;  -- opened/clicked/received/scheduled: recorded, no state
      end case;

      if v_outbox is null and v_target is not null and ev.event_type not like 'suppression.%' then
        -- Orphan: durably kept (raw_payload), retried up to 10 times, then
        -- surfaced for operators. NEVER dropped, NEVER blocks other events.
        update public.email_provider_events
        set processing_status = 'failed', retry_count = retry_count + 1,
            processing_error = 'orphan: no attempt row and no logical_event_id tag'
        where id = ev.id;
        v_counts := jsonb_set(v_counts, '{orphaned}', to_jsonb((v_counts->>'orphaned')::int + 1));
        continue;
      end if;

      -- Apply state transition (rank-guarded: duplicates & reordering are safe)
      if v_outbox is not null and v_target is not null then
        v_res := public.email_apply_provider_state(v_outbox, v_target, 'provider:resend',
                   ev.event_type || ' @ ' || coalesce(ev.occurred_at::text,'?'));
        if coalesce((v_res->>'skipped_stale')::boolean, false) then
          v_counts := jsonb_set(v_counts, '{skipped}', to_jsonb((v_counts->>'skipped')::int + 1));
        end if;
        update public.email_provider_events set outbox_id = v_outbox where id = ev.id;
      end if;

      -- Suppression rules (source is ALWAYS 'resend' here — ownership matters)
      if ev.event_type = 'email.complained' and v_recipient <> '' then
        perform public.email_apply_suppression(v_recipient, 'resend', 'complaint',
                  jsonb_build_object('provider_event_id', ev.provider_event_id));
      elsif ev.event_type = 'email.bounced' and v_target = 'BOUNCED' and v_recipient <> '' then
        perform public.email_apply_suppression(v_recipient, 'resend', 'bounce',
                  jsonb_build_object('provider_event_id', ev.provider_event_id,
                                     'bounce_type', ev.raw_payload->'data'->'bounce'->>'type'));
      elsif ev.event_type in ('email.suppressed','suppression.added') and v_recipient <> '' then
        perform public.email_apply_suppression(v_recipient, 'resend', 'suppressed',
                  jsonb_build_object('provider_event_id', ev.provider_event_id));
      elsif ev.event_type = 'suppression.removed' and v_recipient <> '' then
        perform public.email_remove_provider_suppression(v_recipient);
      end if;

      update public.email_provider_events
      set processing_status = 'processed', processed_at = now(), processing_error = null,
          outbox_id = coalesce(outbox_id, v_outbox)
      where id = ev.id;
      v_counts := jsonb_set(v_counts, '{processed}', to_jsonb((v_counts->>'processed')::int + 1));

    exception when others then
      update public.email_provider_events
      set processing_status = 'failed', retry_count = retry_count + 1,
          processing_error = left(sqlerrm, 500)
      where id = ev.id;
      v_counts := jsonb_set(v_counts, '{failed}', to_jsonb((v_counts->>'failed')::int + 1));
    end;
  end loop;
  return v_counts;
end $$;

comment on function public.process_provider_events is
  'Async inbox processor (cron */2 + best-effort inline after ingest). Per-event exception isolation; orphans retained for operators; rank-guarded transitions make duplicates/reordering deterministic.';

-- ----------------------------------------------------------------------------
-- SECTION N — SCHEMA MAPPING v2 (TYPE-VALIDATED; fails loudly)
-- ----------------------------------------------------------------------------
-- Helper: pick the first candidate column that EXISTS and has a COMPATIBLE
-- type. A candidate that exists with an INCOMPATIBLE type raises immediately
-- (no blind casts, no silently-invalid views). Dropped at end of migration.
create or replace function public._email_pick_col(
  p_table text, p_candidates text[], p_types text[])
returns table(col text, dtype text)
language plpgsql as $$
declare c text; r record; v_bad text; v_badtype text;
begin
  foreach c in array p_candidates loop
    select column_name, data_type into r from information_schema.columns
    where table_schema = 'public' and table_name = p_table and column_name = c;
    if r.column_name is not null then
      if r.data_type = any (p_types) then
        col := r.column_name; dtype := r.data_type; return next; return;
      else
        v_bad := c; v_badtype := r.data_type;
      end if;
    end if;
  end loop;
  if v_bad is not null then
    raise exception 'SCHEMA MAPPING: public.%.% exists but type "%" is incompatible (expected one of: %). Fix the column or adjust the candidate list in migration 001 §N.',
      p_table, v_bad, v_badtype, array_to_string(p_types, ', ');
  end if;
  return;
end $$;

do $$
declare
  v_pk text; v_pk_t text;
  v_renter text; v_renter_t text;
  v_listing text; v_listing_t text;
  v_status text; v_status_t text;
  v_start text; v_start_t text;
  v_end text; v_end_t text;
  v_amount text; v_amount_t text;
  v_currency text; v_tz text; v_tz_table text;
  v_owner text; v_owner_t text;
  v_title text;
  v_pemail text; v_pname text;
  v_has_listings boolean; v_has_profiles boolean; v_has_authusers boolean;
  v_sel text; v_joins text := '';
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  iso_re  constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9:.+-]*)?$';
begin
  if to_regclass('public.bookings') is null then
    raise warning 'bookings missing — skipping ctx view rebuild (create it and re-run)';
    return;
  end if;

  -- REQUIRED slots: missing or type-incompatible ⇒ hard failure
  select col, dtype into v_pk, v_pk_t from public._email_pick_col('bookings',
    array['id','booking_id','uuid'], array['uuid']);
  if v_pk is null then raise exception 'SCHEMA MAPPING: bookings has no uuid primary-key candidate (id/booking_id/uuid)'; end if;

  select col, dtype into v_renter, v_renter_t from public._email_pick_col('bookings',
    array['renter_id','user_id','customer_id','guest_id','renter_uuid'],
    array['uuid','text','character varying']);
  if v_renter is null then raise exception 'SCHEMA MAPPING: bookings has no renter reference column (renter_id/user_id/customer_id/guest_id)'; end if;

  select col, dtype into v_status, v_status_t from public._email_pick_col('bookings',
    array['status','booking_status','state'], array['text','character varying','USER-DEFINED']);
  if v_status is null then raise exception 'SCHEMA MAPPING: bookings has no status column (status/booking_status/state)'; end if;

  -- OPTIONAL slots: degrade loudly (WARNING) but keep working
  select col, dtype into v_listing, v_listing_t from public._email_pick_col('bookings',
    array['listing_id','property_id','item_id','listing_uuid'], array['uuid','text','character varying']);
  select col, dtype into v_start, v_start_t from public._email_pick_col('bookings',
    array['start_date','starts_at','start_time','check_in','checkin_date','start_at'],
    array['timestamp with time zone','timestamp without time zone','date','text','character varying']);
  select col, dtype into v_end, v_end_t from public._email_pick_col('bookings',
    array['end_date','ends_at','end_time','check_out','checkout_date','end_at'],
    array['timestamp with time zone','timestamp without time zone','date','text','character varying']);
  select col, dtype into v_amount, v_amount_t from public._email_pick_col('bookings',
    array['total_amount','amount','total_price','total','price'],
    array['numeric','integer','bigint','double precision','real','text','character varying']);
  select col into v_currency from public._email_pick_col('bookings',
    array['currency','currency_code'], array['text','character varying']);
  select col into v_tz from public._email_pick_col('bookings',
    array['timezone','time_zone','tz'], array['text','character varying']);
  v_tz_table := case when v_tz is not null then 'b' else null end;

  v_has_listings  := to_regclass('public.listings') is not null;
  v_has_profiles  := to_regclass('public.profiles') is not null;
  v_has_authusers := to_regclass('auth.users') is not null;

  if v_has_listings then
    select col, dtype into v_owner, v_owner_t from public._email_pick_col('listings',
      array['owner_id','user_id','host_id','landlord_id','vendor_id'], array['uuid','text','character varying']);
    select col into v_title from public._email_pick_col('listings',
      array['title','name','listing_title'], array['text','character varying']);
    if v_tz is null then
      select col into v_tz from public._email_pick_col('listings',
        array['timezone','time_zone','tz'], array['text','character varying']);
      v_tz_table := case when v_tz is not null then 'l' else null end;
    end if;
  end if;

  if v_has_profiles then
    select col into v_pemail from public._email_pick_col('profiles',
      array['email','contact_email','email_address'], array['text','character varying']);
    select col into v_pname from public._email_pick_col('profiles',
      array['full_name','name','display_name','first_name','username'], array['text','character varying']);
  end if;

  if v_start is null then raise warning 'MAPPING: no booking start column — booking_reminder scan disabled'; end if;
  if v_end   is null then raise warning 'MAPPING: no booking end column — review_request scan disabled'; end if;
  if v_amount is null then raise warning 'MAPPING: no amount column — templates omit price'; end if;
  if v_currency is null then raise warning 'MAPPING: no currency column — defaulting to config currency (USD). Per-booking currency recommended.'; end if;
  if v_tz is null then raise warning 'MAPPING: no timezone column — customer-facing times render in UTC'; end if;

  insert into public.email_config (key, value) values
    ('ctx_booking_id_col', v_pk), ('ctx_renter_col', v_renter),
    ('ctx_listing_col', coalesce(v_listing,'')), ('ctx_status_col', v_status),
    ('ctx_start_col', coalesce(v_start,'')), ('ctx_end_col', coalesce(v_end,'')),
    ('ctx_amount_col', coalesce(v_amount,'')), ('ctx_currency_col', coalesce(v_currency,'')),
    ('ctx_tz_col', coalesce(v_tz,'')), ('ctx_owner_col', coalesce(v_owner,'')),
    ('ctx_title_col', coalesce(v_title,'')), ('ctx_profile_email_col', coalesce(v_pemail,'')),
    ('ctx_profile_name_col', coalesce(v_pname,'')), ('ctx_mapping_version', '2')
  on conflict (key) do update set value = excluded.value, updated_at = now();

  raise notice '===== GoRentals schema reconciliation (v2, type-validated) =====';
  raise notice 'pk=% renter=%(%) status=% start=% end=% amount=% currency=% tz=%',
    v_pk, v_renter, v_renter_t, v_status, coalesce(v_start,'-'), coalesce(v_end,'-'),
    coalesce(v_amount,'-'), coalesce(v_currency,'(default)'), coalesce(v_tz,'(UTC)');
  raise notice 'listings.owner=% listings.title=% profiles.email=% profiles.name=% auth.users=%',
    coalesce(v_owner,'-'), coalesce(v_title,'-'), coalesce(v_pemail,'(auth fallback)'), coalesce(v_pname,'(generic greeting)'), v_has_authusers;
  raise notice '==============================================================';

  -- type-safe cast expression builders (inline)
  v_sel := format(
    'select b.%I::uuid as booking_id, %s as renter_id, %s as renter_email, %s as renter_name, %s as owner_id, %s as owner_email, %s as owner_name, %s as listing_id, %s as listing_title, %s as status, %s as starts_at, %s as ends_at, %s as amount, %s as currency, %s as timezone, b.created_at as created_at',
    v_pk,
    -- renter_id (safe uuid cast for text columns)
    case when v_renter_t = 'uuid' then format('b.%I::uuid', v_renter)
         else format('case when b.%1$I ~* ''%2$s'' then b.%1$I::uuid else null end', v_renter, uuid_re) end,
    -- renter_email
    case
      when v_has_profiles and v_pemail is not null and v_has_authusers then
        format('nullif(lower(btrim(coalesce(pr.%I, ur.email, ''''))), '''')', v_pemail)
      when v_has_profiles and v_pemail is not null then
        format('nullif(lower(btrim(coalesce(pr.%I, ''''))), '''')', v_pemail)
      when v_has_authusers then 'nullif(lower(btrim(coalesce(ur.email, ''''))), '''')'
      else 'null::text' end,
    -- renter_name
    case when v_has_profiles and v_pname is not null then
      format('coalesce(nullif(btrim(pr.%I), ''''), ''there'')', v_pname) else '''there''' end,
    -- owner_id
    case when v_has_listings and v_owner is not null and v_listing is not null then
      case when v_owner_t = 'uuid' then format('l.%I::uuid', v_owner)
           else format('case when l.%1$I ~* ''%2$s'' then l.%1$I::uuid else null end', v_owner, uuid_re) end
      else 'null::uuid' end,
    -- owner_email
    case
      when v_has_listings and v_owner is not null and v_listing is not null and v_has_profiles and v_pemail is not null and v_has_authusers then
        format('nullif(lower(btrim(coalesce(po.%I, uo.email, ''''))), '''')', v_pemail)
      when v_has_listings and v_owner is not null and v_listing is not null and v_has_profiles and v_pemail is not null then
        format('nullif(lower(btrim(coalesce(po.%I, ''''))), '''')', v_pemail)
      when v_has_listings and v_owner is not null and v_listing is not null and v_has_authusers then
        'nullif(lower(btrim(coalesce(uo.email, ''''))), '''')'
      else 'null::text' end,
    -- owner_name
    case when v_has_profiles and v_pname is not null and v_has_listings and v_owner is not null and v_listing is not null then
      format('coalesce(nullif(btrim(po.%I), ''''), ''Host'')', v_pname) else '''Host''' end,
    -- listing_id
    case when v_listing is null then 'null::uuid'
         when v_listing_t = 'uuid' then format('b.%I::uuid', v_listing)
         else format('case when b.%1$I ~* ''%2$s'' then b.%1$I::uuid else null end', v_listing, uuid_re) end,
    -- listing_title
    case when v_has_listings and v_title is not null and v_listing is not null then
      format('coalesce(l.%I, ''Your booking'')', v_title) else '''Your booking''' end,
    -- status (text/enum safe)
    format('lower(coalesce(b.%I::text, ''''))', v_status),
    -- starts_at / ends_at (type-safe)
    case when v_start is null then 'null::timestamptz'
         when v_start_t like 'timestamp%' or v_start_t = 'date' then format('b.%I::timestamptz', v_start)
         else format('case when b.%1$I ~ ''%2$s'' then b.%1$I::timestamptz else null end', v_start, iso_re) end,
    case when v_end is null then 'null::timestamptz'
         when v_end_t like 'timestamp%' or v_end_t = 'date' then format('b.%I::timestamptz', v_end)
         else format('case when b.%1$I ~ ''%2$s'' then b.%1$I::timestamptz else null end', v_end, iso_re) end,
    -- amount (type-safe)
    case when v_amount is null then 'null::numeric'
         when v_amount_t in ('numeric','integer','bigint','double precision','real') then format('b.%I::numeric', v_amount)
         else format('case when b.%1$I ~ ''^[0-9]+(\.[0-9]+)?$'' then b.%1$I::numeric else null end', v_amount) end,
    -- currency
    case when v_currency is null then 'coalesce(nullif(public.email_cfg(''default_currency''),''''), ''USD'')'
         else format('coalesce(nullif(upper(btrim(b.%I)), ''''), ''USD'')', v_currency) end,
    -- timezone (may live on bookings OR listings — use the right alias)
    case when v_tz is null then '''UTC'''
         else format('coalesce(nullif(btrim(%s.%I), ''''), ''UTC'')', v_tz_table, v_tz) end
  );

  if v_has_listings and v_listing is not null then
    v_joins := v_joins || case when v_listing_t = 'uuid'
      then format(' left join public.listings l on l.id = b.%I', v_listing)
      else format(' left join public.listings l on l.id::text = b.%I', v_listing) end;
  end if;
  if v_has_profiles then
    v_joins := v_joins || case when v_renter_t = 'uuid'
      then format(' left join public.profiles pr on pr.id = b.%I', v_renter)
      else format(' left join public.profiles pr on pr.id::text = b.%I', v_renter) end;
  end if;
  if v_has_authusers then
    v_joins := v_joins || case when v_renter_t = 'uuid'
      then format(' left join auth.users ur on ur.id = b.%I', v_renter)
      else format(' left join auth.users ur on ur.id::text = b.%I', v_renter) end;
  end if;
  if v_has_listings and v_owner is not null and v_listing is not null and v_has_profiles then
    v_joins := v_joins || case when v_owner_t = 'uuid'
      then format(' left join public.profiles po on po.id = l.%I', v_owner)
      else format(' left join public.profiles po on po.id::text = l.%I', v_owner) end;
  end if;
  if v_has_listings and v_owner is not null and v_listing is not null and v_has_authusers then
    v_joins := v_joins || case when v_owner_t = 'uuid'
      then format(' left join auth.users uo on uo.id = l.%I', v_owner)
      else format(' left join auth.users uo on uo.id::text = l.%I', v_owner) end;
  end if;

  execute 'drop view if exists public.email_bookings_ctx';
  execute format('create view public.email_bookings_ctx as %s from public.bookings b %s', v_sel, v_joins);
  execute 'alter view public.email_bookings_ctx set (security_invoker = off)';
  raise notice 'email_bookings_ctx v2 (re)created with currency + timezone.';

  -- refunds mapping (type-validated)
  if to_regclass('public.refunds') is not null then
    declare
      v_rb text; v_rb_t text; v_ra text; v_ra_t text; v_rs text; v_rp text; v_rp_t text;
    begin
      select col, dtype into v_rb, v_rb_t from public._email_pick_col('refunds',
        array['id','refund_id'], array['uuid']);
      select col, dtype into v_rp, v_rp_t from public._email_pick_col('refunds',
        array['booking_id','booking','reservation_id'], array['uuid','text','character varying']);
      select col, dtype into v_ra, v_ra_t from public._email_pick_col('refunds',
        array['amount','refund_amount','total'], array['numeric','integer','bigint','double precision','real','text','character varying']);
      select col into v_rs from public._email_pick_col('refunds',
        array['status','state'], array['text','character varying','USER-DEFINED']);
      insert into public.email_config (key, value) values
        ('ctx_refund_id_col',      coalesce(v_rb,'')),
        ('ctx_refund_booking_col', coalesce(v_rp,'')),
        ('ctx_refund_amount_col',  coalesce(v_ra,'')),
        ('ctx_refund_status_col',  coalesce(v_rs,''))
      on conflict (key) do update set value = excluded.value, updated_at = now();
      raise notice 'refunds mapping: id=% booking=% amount=% status=%',
        coalesce(v_rb,'(none — refund emails disabled)'), coalesce(v_rp,'(none)'),
        coalesce(v_ra,'(none)'), coalesce(v_rs,'(none — every final-state write notifies)');
    end;
  end if;
end $$;

insert into public.email_config (key, value) values ('default_currency','USD')
on conflict (key) do nothing;

drop function if exists public._email_pick_col(text, text[], text[]);

-- ----------------------------------------------------------------------------
-- SECTION O — LIFECYCLE TRIGGERS v2 (FAIL-LOUD transactional outbox)
-- ----------------------------------------------------------------------------
-- Durability contract: the outbox row is written INSIDE the business
-- transaction. If outbox creation fails (invalid payload, unknown/disabled
-- template, underivable logical id), the trigger RAISES and the business
-- transaction ROLLS BACK — an email intent is never silently lost.
-- The ONLY legitimate no-op is "recipient has no email address" (a person
-- without an email must not block a booking).
create or replace function public.email_trg_bookings_v2()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_status_col text := coalesce(nullif(public.email_cfg('ctx_status_col'),''), 'status');
  v_pk_col     text := coalesce(nullif(public.email_cfg('ctx_booking_id_col'),''), 'id');
  v_ctx        public.email_bookings_ctx%rowtype;
  v_new        text;
  v_old        text;
  v_payload    jsonb;
begin
  if coalesce(public.email_cfg('enqueue_source'),'trigger') <> 'trigger' then
    return new;   -- webhook mode owns enqueueing
  end if;

  v_new := lower(coalesce(to_jsonb(new) ->> v_status_col, ''));
  v_old := case when tg_op = 'UPDATE' then lower(coalesce(to_jsonb(old) ->> v_status_col, '')) else null end;
  if tg_op = 'UPDATE' and v_new = v_old then
    return new;
  end if;

  select * into v_ctx from public.email_bookings_ctx
  where booking_id = ((to_jsonb(new) ->> v_pk_col)::uuid);
  if v_ctx.booking_id is null then
    raise exception 'email outbox: booking % not resolvable via email_bookings_ctx — cannot record email intent', (to_jsonb(new) ->> v_pk_col);
  end if;

  v_payload := jsonb_build_object(
    'booking_id',    v_ctx.booking_id,
    'renter_name',   v_ctx.renter_name,
    'owner_name',    v_ctx.owner_name,
    'listing_title', v_ctx.listing_title,
    'starts_at',     v_ctx.starts_at,
    'ends_at',       v_ctx.ends_at,
    'amount',        v_ctx.amount,
    'currency',      v_ctx.currency,
    'timezone',      v_ctx.timezone);

  if v_new in ('confirmed','approved','accepted')
     and (v_old is null or v_old not in ('confirmed','approved','accepted')) then
    if v_ctx.renter_email is not null then
      perform public.enqueue_email_v2('booking_confirmation', v_ctx.renter_email, v_payload);
    else raise notice 'email outbox: booking % renter has no email — confirmation skipped', v_ctx.booking_id; end if;
    if v_ctx.owner_email is not null then
      perform public.enqueue_email_v2('booking_host_confirmation', v_ctx.owner_email, v_payload);
    end if;
  elsif v_new = 'pending' and tg_op = 'INSERT' then
    if v_ctx.owner_email is not null then
      perform public.enqueue_email_v2('booking_request_owner', v_ctx.owner_email, v_payload);
    end if;
  elsif v_new in ('cancelled','canceled')
     and (v_old is null or v_old not in ('cancelled','canceled')) then
    if v_ctx.renter_email is not null then
      perform public.enqueue_email_v2('booking_cancelled_renter', v_ctx.renter_email, v_payload);
    end if;
    if v_ctx.owner_email is not null then
      perform public.enqueue_email_v2('booking_cancelled_owner', v_ctx.owner_email, v_payload);
    end if;
  end if;

  return new;
  -- NOTE: deliberately NO exception handler. Any failure propagates and rolls
  -- back the business transaction (P0-1 fix). Silent loss is unacceptable.
end $$;

create or replace function public.email_trg_refunds_v2()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_id_col   text := coalesce(nullif(public.email_cfg('ctx_refund_id_col'),''), 'id');
  v_bkg_col  text := coalesce(nullif(public.email_cfg('ctx_refund_booking_col'),''), 'booking_id');
  v_amt_col  text := coalesce(nullif(public.email_cfg('ctx_refund_amount_col'),''), 'amount');
  v_stat_col text := coalesce(nullif(public.email_cfg('ctx_refund_status_col'),''), 'status');
  v_new_rec  jsonb := to_jsonb(new);
  v_old_rec  jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_new_st   text := lower(coalesce(v_new_rec ->> v_stat_col, ''));
  v_old_st   text := case when v_old_rec is not null then lower(coalesce(v_old_rec ->> v_stat_col, '')) else null end;
  v_final    text[] := array['processed','completed','approved','succeeded','issued','refunded'];
  v_ctx      public.email_bookings_ctx%rowtype;
  v_refund_id uuid;
begin
  if coalesce(public.email_cfg('enqueue_source'),'trigger') <> 'trigger' then
    return new;
  end if;

  -- Fire on TRANSITION INTO a final state only:
  --   INSERT with final status            → fire
  --   UPDATE non-final → final            → fire   (P0-3 fix: pending→processed works)
  --   UPDATE final → same/other final     → no     (no re-send)
  --   UPDATE final → non-final (reversal) → no     (documented: no retraction email)
  if not (v_new_st = any (v_final)) then return new; end if;
  if v_old_st is not null and v_old_st = any (v_final) then return new; end if;

  v_refund_id := (nullif(v_new_rec ->> v_id_col, ''))::uuid;
  select * into v_ctx from public.email_bookings_ctx
  where booking_id = (nullif(v_new_rec ->> v_bkg_col, ''))::uuid;
  if v_ctx.booking_id is null then
    raise exception 'email outbox: refund % references unresolvable booking — cannot record email intent', v_refund_id;
  end if;
  if v_ctx.renter_email is null then
    raise notice 'email outbox: refund % renter has no email — skipped', v_refund_id;
    return new;
  end if;

  -- logical id keyed by REFUND identity → multiple partial refunds each send once
  perform public.enqueue_email_v2('refund_issued', v_ctx.renter_email,
    jsonb_build_object(
      'refund_id',     v_refund_id,
      'booking_id',    v_ctx.booking_id,
      'renter_name',   v_ctx.renter_name,
      'amount',        coalesce((nullif(v_new_rec ->> v_amt_col, ''))::numeric, 0),
      'currency',      v_ctx.currency,
      'listing_title', v_ctx.listing_title),
    null, 'REFUND_ISSUED:' || upper(v_refund_id::text));
  return new;
end $$;

do $$
begin
  if to_regclass('public.bookings') is not null then
    execute 'drop trigger if exists trg_bookings_email on public.bookings';     -- v1
    execute 'drop trigger if exists trg_bookings_email_v2 on public.bookings';
    execute 'create trigger trg_bookings_email_v2 after insert or update on public.bookings for each row execute function public.email_trg_bookings_v2()';
    raise notice 'trigger trg_bookings_email_v2 attached (fail-loud).';
  end if;
  if to_regclass('public.refunds') is not null then
    execute 'drop trigger if exists trg_refunds_email on public.refunds';        -- v1
    execute 'drop trigger if exists trg_refunds_email_v2 on public.refunds';
    execute 'create trigger trg_refunds_email_v2 after insert or update on public.refunds for each row execute function public.email_trg_refunds_v2()';
    raise notice 'trigger trg_refunds_email_v2 attached (INSERT + UPDATE transitions).';
  end if;
end $$;

-- DB-webhook handler v2 (active only when enqueue_source='webhook')
create or replace function public.handle_db_webhook_event(p_event jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_table   text := p_event->>'table';
  v_op      text := upper(coalesce(p_event->>'type',''));
  v_rec     jsonb := coalesce(p_event->'record','{}'::jsonb);
  v_old     jsonb := p_event->'old_record';
  v_pk_col  text := coalesce(nullif(public.email_cfg('ctx_booking_id_col'),''), 'id');
  v_st_col  text := coalesce(nullif(public.email_cfg('ctx_status_col'),''), 'status');
  v_ctx     public.email_bookings_ctx%rowtype;
  v_bkg_id  uuid;
  v_new     text; v_old_st text;
  v_payload jsonb;
  v_enq     integer := 0;
  r         jsonb;
begin
  if coalesce(public.email_cfg('enqueue_source'),'trigger') <> 'webhook' then
    return jsonb_build_object('handled', false, 'reason', 'enqueue_source is not webhook');
  end if;

  if v_table = 'bookings' and v_op in ('INSERT','UPDATE') then
    v_bkg_id := (nullif(v_rec->>v_pk_col,''))::uuid;
    select * into v_ctx from public.email_bookings_ctx where booking_id = v_bkg_id;
    if v_ctx.booking_id is null then
      return jsonb_build_object('handled', false, 'reason', 'booking not in ctx view');
    end if;
    v_new := lower(coalesce(v_rec->>v_st_col,''));
    v_old_st := lower(coalesce(v_old->>v_st_col,''));
    if v_op = 'UPDATE' and v_new = v_old_st then
      return jsonb_build_object('handled', true, 'enqueued', 0, 'note', 'status unchanged');
    end if;
    v_payload := jsonb_build_object(
      'booking_id', v_ctx.booking_id, 'renter_name', v_ctx.renter_name,
      'owner_name', v_ctx.owner_name, 'listing_title', v_ctx.listing_title,
      'starts_at', v_ctx.starts_at, 'ends_at', v_ctx.ends_at,
      'amount', v_ctx.amount, 'currency', v_ctx.currency, 'timezone', v_ctx.timezone);
    if v_new in ('confirmed','approved','accepted') and (v_op='INSERT' or v_old_st not in ('confirmed','approved','accepted')) then
      r := public.enqueue_email_v2('booking_confirmation', v_ctx.renter_email, v_payload);
      v_enq := v_enq + (case when r->>'status' = 'queued' then 1 else 0 end);
      r := public.enqueue_email_v2('booking_host_confirmation', v_ctx.owner_email, v_payload);
      v_enq := v_enq + (case when r->>'status' = 'queued' then 1 else 0 end);
    elsif v_new = 'pending' and v_op = 'INSERT' then
      r := public.enqueue_email_v2('booking_request_owner', v_ctx.owner_email, v_payload);
      v_enq := v_enq + (case when r->>'status' = 'queued' then 1 else 0 end);
    elsif v_new in ('cancelled','canceled') and (v_op='INSERT' or v_old_st not in ('cancelled','canceled')) then
      r := public.enqueue_email_v2('booking_cancelled_renter', v_ctx.renter_email, v_payload);
      v_enq := v_enq + (case when r->>'status' = 'queued' then 1 else 0 end);
      r := public.enqueue_email_v2('booking_cancelled_owner', v_ctx.owner_email, v_payload);
      v_enq := v_enq + (case when r->>'status' = 'queued' then 1 else 0 end);
    end if;
    return jsonb_build_object('handled', true, 'enqueued', v_enq);
  end if;

  if v_table = 'refunds' and v_op in ('INSERT','UPDATE') then
    declare
      v_id_col text := coalesce(nullif(public.email_cfg('ctx_refund_id_col'),''), 'id');
      v_bk_col text := coalesce(nullif(public.email_cfg('ctx_refund_booking_col'),''), 'booking_id');
      v_am_col text := coalesce(nullif(public.email_cfg('ctx_refund_amount_col'),''), 'amount');
      v_st2_col text := coalesce(nullif(public.email_cfg('ctx_refund_status_col'),''), 'status');
      v_final text[] := array['processed','completed','approved','succeeded','issued','refunded'];
      v_ns text := lower(coalesce(v_rec->>v_st2_col,''));
      v_os text := lower(coalesce(v_old->>v_st2_col,''));
    begin
      if not (v_ns = any (v_final)) then
        return jsonb_build_object('handled', false, 'reason', 'refund not final: ' || v_ns);
      end if;
      if v_op = 'UPDATE' and v_os = any (v_final) then
        return jsonb_build_object('handled', true, 'enqueued', 0, 'note', 'already final before update');
      end if;
      select * into v_ctx from public.email_bookings_ctx
      where booking_id = (nullif(v_rec->>v_bk_col,''))::uuid;
      if v_ctx.booking_id is null then
        return jsonb_build_object('handled', false, 'reason', 'booking not found for refund');
      end if;
      r := public.enqueue_email_v2('refund_issued', v_ctx.renter_email,
        jsonb_build_object('refund_id', (nullif(v_rec->>v_id_col,''))::uuid,
                           'booking_id', v_ctx.booking_id, 'renter_name', v_ctx.renter_name,
                           'amount', coalesce((nullif(v_rec->>v_am_col,''))::numeric, 0),
                           'currency', v_ctx.currency, 'listing_title', v_ctx.listing_title),
        null, 'REFUND_ISSUED:' || upper(coalesce(v_rec->>v_id_col, '')));
      return jsonb_build_object('handled', true, 'enqueued', (case when r->>'status'='queued' then 1 else 0 end));
    end;
  end if;

  return jsonb_build_object('handled', false, 'reason', 'unsupported table/op');
end $$;

-- ----------------------------------------------------------------------------
-- SECTION P — SCANS v2, HEALTH v2, TRACE, REPLAY, CLEANUP
-- ----------------------------------------------------------------------------
create or replace function public.scan_booking_reminders(p_days_before integer default 1)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v_ctx record; v_enq integer := 0; v_n integer := 0; r jsonb;
begin
  for v_ctx in
    select * from public.email_bookings_ctx
    where status in ('confirmed','approved','accepted')
      and starts_at is not null
      and (starts_at at time zone coalesce(timezone,'UTC'))::date
          = (current_date + coalesce(p_days_before,1))
  loop
    v_n := v_n + 1;
    r := public.enqueue_email_v2('booking_reminder', v_ctx.renter_email,
      jsonb_build_object('booking_id', v_ctx.booking_id, 'renter_name', v_ctx.renter_name,
                         'listing_title', v_ctx.listing_title, 'starts_at', v_ctx.starts_at,
                         'ends_at', v_ctx.ends_at, 'timezone', v_ctx.timezone));
    v_enq := v_enq + (case when r->>'status' = 'queued' then 1 else 0 end);
  end loop;
  return jsonb_build_object('considered', v_n, 'enqueued', v_enq);
end $$;

create or replace function public.scan_review_requests(p_days_after integer default 3)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v_ctx record; v_enq integer := 0; v_n integer := 0; r jsonb;
begin
  for v_ctx in
    select * from public.email_bookings_ctx
    where status in ('completed','confirmed','approved','accepted')
      and ends_at is not null
      and (ends_at at time zone coalesce(timezone,'UTC'))::date
          = (current_date - coalesce(p_days_after,3))
  loop
    v_n := v_n + 1;
    r := public.enqueue_email_v2('review_request', v_ctx.renter_email,
      jsonb_build_object('booking_id', v_ctx.booking_id, 'renter_name', v_ctx.renter_name,
                         'listing_title', v_ctx.listing_title, 'starts_at', v_ctx.starts_at,
                         'ends_at', v_ctx.ends_at, 'timezone', v_ctx.timezone));
    v_enq := v_enq + (case when r->>'status' = 'queued' then 1 else 0 end);
  end loop;
  return jsonb_build_object('considered', v_n, 'enqueued', v_enq,
                            'campaign', public.email_cfg('review_campaign_version'));
end $$;

create or replace function public.email_health_snapshot()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare v_out jsonb;
begin
  select jsonb_build_object(
    'version', '2',
    'outbox', (select coalesce(jsonb_object_agg(state, n), '{}'::jsonb)
               from (select state, count(*) n from public.email_outbox group by state) s),
    'oldest_due_age_minutes', (
      select round(extract(epoch from now() - min(next_attempt_at)) / 60)
      from public.email_outbox
      where state in ('QUEUED','RETRY_WAIT','UNKNOWN') and next_attempt_at <= now()),
    'unknown_awaiting_reconcile', (select count(*) from public.email_outbox where state = 'UNKNOWN'),
    'daily_sends', public.email_daily_send_count(),
    'daily_soft_cap', coalesce(nullif(public.email_cfg('daily_soft_cap'),'')::int, 85),
    'daily_hard_cap', coalesce(nullif(public.email_cfg('daily_hard_cap'),'')::int, 100),
    'suppressions_active', (select count(*) from public.email_suppressions where removed_at is null),
    'events_pending', (select count(*) from public.email_provider_events where processing_status = 'pending'),
    'events_failed', (select count(*) from public.email_provider_events where processing_status = 'failed'),
    'dead_24h', (select count(*) from public.email_outbox
                 where state = 'DEAD' and updated_at > now() - interval '24 hours'),
    'bounced_24h', (select count(*) from public.email_outbox
                    where state = 'BOUNCED' and updated_at > now() - interval '24 hours'),
    'delivered_24h', (select count(*) from public.email_outbox
                      where state = 'DELIVERED' and updated_at > now() - interval '24 hours'),
    'drain_lease', (select jsonb_build_object('owner', owner_id, 'expires', lease_expires_at)
                    from public.email_runtime_state where key = 'drain'),
    'enqueue_source', public.email_cfg('enqueue_source'),
    'edge_function_url_set', coalesce(public.email_cfg('edge_function_url'),'') <> '',
    'server_now', now()
  ) into v_out;
  return v_out;
end $$;

-- Operator tooling: full trace of one logical email event
create or replace function public.email_trace(p_logical_event_id text default null, p_outbox_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare o public.email_outbox; v_out jsonb;
begin
  if p_outbox_id is not null then
    select * into o from public.email_outbox where id = p_outbox_id;
  elsif p_logical_event_id is not null then
    select * into o from public.email_outbox where logical_event_id = upper(p_logical_event_id);
  else
    raise exception 'email_trace: pass p_logical_event_id or p_outbox_id';
  end if;
  if o.id is null then return jsonb_build_object('found', false); end if;

  select jsonb_build_object(
    'found', true,
    'outbox', jsonb_build_object(
      'id', o.id, 'logical_event_id', o.logical_event_id,
      'template', o.template_key || '@' || o.template_version,
      'recipient', o.recipient, 'state', o.state, 'priority', o.priority,
      'attempts', o.attempts, 'max_attempts', o.max_attempts,
      'next_attempt_at', o.next_attempt_at, 'replay_count', o.replay_count,
      'first_failed_at', o.first_failed_at, 'last_error', o.last_error,
      'created_at', o.created_at, 'audit_log', o.audit_log),
    'attempts', (select coalesce(jsonb_agg(a order by a.attempt_number), '[]'::jsonb)
                 from (select attempt_number, provider, provider_idempotency_key, provider_email_id,
                              request_started_at, request_finished_at, status, error_code,
                              left(coalesce(error_message,''), 300) as error_message
                       from public.email_send_attempts where outbox_id = o.id) a),
    'provider_events', (select coalesce(jsonb_agg(e order by e.received_at), '[]'::jsonb)
                 from (select provider_event_id, event_type, occurred_at, received_at,
                              processing_status, processing_error
                       from public.email_provider_events where outbox_id = o.id) e),
    'suppression', (select jsonb_build_object('active', exists (select 1 from public.email_suppressions s
                          where s.email = o.recipient and s.removed_at is null)))
  ) into v_out;
  return v_out;
end $$;

-- Dead-letter replay: preserves the full ledger, starts a controlled new cycle.
create or replace function public.email_replay(p_outbox_id uuid, p_note text default 'operator replay')
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare o public.email_outbox;
begin
  select * into o from public.email_outbox where id = p_outbox_id for update;
  if o.id is null then raise exception 'outbox % not found', p_outbox_id; end if;
  if o.state not in ('DEAD','FAILED','BOUNCED','SUPPRESSED') then
    raise exception 'replay only allowed from DEAD/FAILED/BOUNCED/SUPPRESSED (current: %)', o.state;
  end if;
  if public.email_is_suppressed(o.recipient) then
    raise exception 'recipient is suppressed — remove the suppression first (email_unsuppress) if this is a false positive';
  end if;
  update public.email_outbox
  set state = 'QUEUED', attempts = 0, next_attempt_at = now(),
      replay_count = replay_count + 1, last_error = null,
      locked_at = null, locked_by = null, updated_at = now()
  where id = o.id;
  perform public.email_outbox_audit(o.id, o.state, 'QUEUED', 'replay', p_note);
  return jsonb_build_object('ok', true, 'outbox_id', o.id, 'replay_count', o.replay_count + 1);
end $$;

-- Retention / cleanup (daily cron). Never touches non-terminal rows, active
-- suppressions, or unprocessed events. Archives instead of hard-deleting outbox.
create table if not exists public.email_outbox_archive (like public.email_outbox including all);
alter table public.email_outbox_archive enable row level security;

create or replace function public.email_cleanup()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_ev_days  int := coalesce(nullif(public.email_cfg('retention_events_days'),'')::int, 90);
  v_at_days  int := coalesce(nullif(public.email_cfg('retention_attempts_days'),'')::int, 365);
  v_ob_days  int := coalesce(nullif(public.email_cfg('retention_outbox_days'),'')::int, 730);
  v_ev int; v_at int; v_ob int;
begin
  delete from public.email_provider_events
  where processing_status = 'processed'
    and received_at < now() - make_interval(days => v_ev_days);
  get diagnostics v_ev = row_count;

  delete from public.email_send_attempts a
  using public.email_outbox o
  where a.outbox_id = o.id
    and o.state in ('DELIVERED','ACCEPTED','DEAD','CANCELLED','BOUNCED','COMPLAINED','FAILED')
    and o.updated_at < now() - make_interval(days => v_at_days)
    and a.request_started_at < now() - make_interval(days => v_at_days);
  get diagnostics v_at = row_count;

  insert into public.email_outbox_archive
  select o.* from public.email_outbox o
  where o.state in ('DELIVERED','DEAD','CANCELLED','BOUNCED','COMPLAINED','SUPPRESSED')
    and o.updated_at < now() - make_interval(days => v_ob_days)
  on conflict (logical_event_id) do nothing;

  delete from public.email_outbox o
  where o.state in ('DELIVERED','DEAD','CANCELLED','BOUNCED','COMPLAINED','SUPPRESSED')
    and o.updated_at < now() - make_interval(days => v_ob_days);
  get diagnostics v_ob = row_count;

  return jsonb_build_object('events_deleted', v_ev, 'attempts_deleted', v_at, 'outbox_archived', v_ob);
end $$;

-- ----------------------------------------------------------------------------
-- SECTION Q — v1 → v2 DATA MIGRATION + DEPRECATION
-- ----------------------------------------------------------------------------
do $$
declare v_mig int; v_skip int; v_supp int;
begin
  if to_regclass('public.email_queue') is not null then
    insert into public.email_outbox
      (logical_event_id, template_key, template_version, recipient, payload, state,
       priority, attempts, max_attempts, next_attempt_at, created_at, updated_at,
       audit_log, last_error)
    select
      'LEGACY:' || upper(q.template) || ':' ||
        coalesce(q.payload->>'booking_id', q.payload->>'dedupe_key', q.id::text),
      q.template,
      (select max(t.version) from public.email_templates t where t.key = q.template),
      q.recipient, q.payload,
      case q.status when 'queued' then 'QUEUED'
                    when 'processing' then 'UNKNOWN'   -- honest: v1 may have called the provider
                    when 'sent' then 'ACCEPTED'
                    when 'dead' then 'DEAD'
                    else 'QUEUED' end,
      q.priority, q.attempts, q.max_attempts, coalesce(q.send_at, now()),
      q.created_at, now(),
      jsonb_build_array(jsonb_build_object(
        'at', now(), 'to', 'migrated', 'by', 'migration-001',
        'note', 'migrated from email_queue v1 (status=' || q.status || ')',
        'v1_error_log', q.error_log)),
      left(coalesce(q.error_log->-1->>'error',''), 500)
    from public.email_queue q
    where exists (select 1 from public.email_templates t where t.key = q.template)
    on conflict (logical_event_id) do nothing;
    get diagnostics v_mig = row_count;

    select count(*) into v_skip from public.email_queue q
    where not exists (select 1 from public.email_templates t where t.key = q.template);
    if v_skip > 0 then
      raise warning 'email_queue: % row(s) reference templates absent from the registry — NOT migrated; inspect: select * from email_queue q where not exists (select 1 from email_templates t where t.key=q.template);', v_skip;
    end if;
    raise notice 'migrated % email_queue rows into email_outbox (processing rows became UNKNOWN for reconciliation).', v_mig;
  end if;

  if to_regclass('public.suppression_list') is not null then
    insert into public.email_suppressions (email, source, reason, detail, created_at)
    select lower(btrim(sl.email)),
      case sl.reason when 'bounced' then 'resend' when 'complained' then 'resend'
                     when 'resend_suppressed' then 'resend' when 'unsubscribe' then 'user'
                     else 'manual' end,
      case sl.reason when 'bounced' then 'bounce' when 'complained' then 'complaint'
                     when 'resend_suppressed' then 'suppressed' when 'unsubscribe' then 'unsubscribe'
                     else 'manual_block' end,
      jsonb_build_object('migrated_from', 'suppression_list'), sl.created_at
    from public.suppression_list sl
    where not exists (select 1 from public.email_suppressions es
                      where es.email = lower(btrim(sl.email)) and es.removed_at is null)
    on conflict do nothing;
    get diagnostics v_supp = row_count;
    raise notice 'migrated % suppression_list rows into email_suppressions (source-aware).', v_supp;
  end if;
end $$;

-- Deprecate v1 objects (tables kept for audit; functions replaced)
comment on table public.email_queue is 'DEPRECATED (v1) — migrated to email_outbox by 001; retained read-only for audit.';
comment on table public.email_log   is 'DEPRECATED (v1) — superseded by email_send_attempts + email_provider_events + email_outbox.state; retained for history.';
comment on table public.suppression_list is 'DEPRECATED (v1) — migrated to email_suppressions (source-aware); retained for audit.';

drop function if exists public.enqueue_email(text, text, jsonb, integer);
drop function if exists public.claim_email_batch(integer);
drop function if exists public.email_send_precheck(uuid);
drop function if exists public.email_send_result(uuid, text, text, text, text, jsonb);
drop function if exists public.requeue_stale_locks(integer);
drop function if exists public.handle_resend_webhook_event(jsonb);
drop function if exists public.email_already_logged(uuid, text, text);
drop function if exists public.email_trg_bookings();
drop function if exists public.email_trg_refunds();

-- ----------------------------------------------------------------------------
-- SECTION R — CRON v2 + SECURITY (RLS, revokes, grants)
-- ----------------------------------------------------------------------------
do $$
declare v_http_cmd text;
begin
  if to_regnamespace('cron') is null or to_regnamespace('net') is null then
    raise warning 'pg_cron/pg_net not present — v2 cron jobs NOT scheduled.';
    return;
  end if;

  v_http_cmd := $CMD$
    do $job$
    declare v_url text := public.email_cfg('edge_function_url');
    begin
      if coalesce(v_url,'') = '' then
        raise notice 'edge_function_url not configured — skipping HTTP call';
        return;
      end if;
      perform net.http_post(
        url     := v_url,
        headers := jsonb_build_object(
                     'Content-Type',      'application/json',
                     'X-Internal-Secret', coalesce(
                       (select decrypted_secret from vault.decrypted_secrets
                        where name = 'EMAIL_INTERNAL_SECRET' limit 1),
                       'MISSING_VAULT_SECRET')),
        body    := jsonb_build_object('action', '%ACTION%'),
        timeout_milliseconds := 120000);
    end $job$;
  $CMD$;

  perform cron.schedule_in_database('gorentals-email-queue-drain', '*/5 * * * *',
    replace(v_http_cmd, '%ACTION%', 'DRAIN_QUEUE'), current_database());
  perform cron.schedule_in_database('gorentals-email-booking-reminder', '0 9 * * *',
    replace(v_http_cmd, '%ACTION%', 'SCAN_REMINDERS'), current_database());
  perform cron.schedule_in_database('gorentals-email-review-request', '5 10 * * *',
    replace(v_http_cmd, '%ACTION%', 'SCAN_REVIEWS'), current_database());

  -- pure-SQL jobs (no secret needed)
  perform cron.schedule_in_database('gorentals-email-requeue-stale', '*/10 * * * *',
    'select public.outbox_recover_stale();', current_database());
  perform cron.schedule_in_database('gorentals-email-process-events', '*/2 * * * *',
    'select public.process_provider_events(500);', current_database());
  perform cron.schedule_in_database('gorentals-email-cleanup', '0 3 * * *',
    'select public.email_cleanup();', current_database());

  raise notice 'cron v2 scheduled: drain */5, stale */10, events */2, cleanup 03:00, reminder 09:00, review 10:05 (UTC).';
end $$;

alter table public.email_outbox            enable row level security;
alter table public.email_send_attempts     enable row level security;
alter table public.email_provider_events   enable row level security;
alter table public.email_suppressions      enable row level security;
alter table public.email_outbox_archive    enable row level security;
-- email_templates: RLS on (service_role bypasses); no public policies anywhere.

do $$
declare r text; f record;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.email_outbox, public.email_send_attempts, public.email_provider_events, public.email_suppressions, public.email_templates, public.email_outbox_archive from %I', r);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.email_outbox, public.email_send_attempts, public.email_provider_events,
      public.email_suppressions, public.email_templates, public.email_outbox_archive to service_role;
  end if;

  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'enqueue_email_v2','claim_outbox_batch','outbox_pre_send_checks','outbox_begin_send',
        'outbox_record_result','outbox_recover_stale','email_provider_event_ingest',
        'process_provider_events','email_apply_suppression','email_remove_provider_suppression',
        'email_is_suppressed','email_suppress','email_unsuppress','email_unsub_token',
        'email_unsub_verify','email_apply_unsubscribe','email_replay','email_trace',
        'email_cleanup','email_health_snapshot','scan_booking_reminders','scan_review_requests',
        'handle_db_webhook_event','email_validate_payload','email_derive_logical_id',
        'email_resolve_template','email_rate_decision','email_daily_send_count',
        'email_is_critical_template','email_outbox_transition','email_apply_provider_state',
        'email_state_transition_ok','email_state_rank','email_suppression_rank','email_log_event')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', f.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
  raise notice 'v2 lockdown complete: RLS + revokes on all new tables and RPCs.';
end $$;

do $$
begin
  raise notice 'V2 MIGRATION COMPLETE. Next: deploy edge function v2 + routes, set UNSUB usage, re-run scripts/curl_tests.sh, review NOTICE report above.';
end $$;
