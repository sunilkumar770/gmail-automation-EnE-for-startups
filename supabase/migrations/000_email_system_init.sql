-- ============================================================================
-- GoRentals — Event-Driven Transactional & Queued Email System
-- Migration: 000_email_system_init.sql
-- ============================================================================
-- WHAT THIS DOES
--   1. Creates (IF MISSING ONLY) canonical business tables so the pipeline is
--      testable on greenfield/local DBs. EXISTING tables are NEVER altered.
--   2. Auto-detects naming variants (renter_id vs user_id, owner_id vs
--      host_id, start_date vs starts_at, ...) and builds the canonical view
--      public.email_bookings_ctx; the mapping is persisted in email_config
--      and printed as NOTICEs (this IS the Step-1 reconciliation report).
--   3. Creates email_queue / email_log / suppression_list with:
--        - deterministic MD5 idempotency keys (unique indexes)
--        - FOR UPDATE SKIP LOCKED claim RPC (race-free concurrent drains)
--        - drain lease (one active drainer) + stale-lock requeue
--        - Resend free-plan rate guard (soft cap 85 / hard cap 100 per day)
--        - suppression checks before every enqueue AND every send
--   4. Registers pg_cron jobs (queue_drain */5, requeue_stale */10,
--      review_request daily, booking_reminder daily). HTTP jobs read the
--      shared secret from Supabase Vault AT EXECUTION TIME — the secret is
--      never inlined into cron definitions.
--   5. Lockdown: RLS on + no public policies + explicit REVOKEs;
--      SECURITY DEFINER RPCs executable only by service_role / postgres.
--
-- IDEMPOTENT: safe to re-run.
-- PREREQS (Supabase cloud): pg_cron + pg_net + pgcrypto enabled
--   (Dashboard → Database → Extensions). Guarded below either way.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- SECTION 0 — EXTENSIONS
-- ----------------------------------------------------------------------------
create extension if not exists pgcrypto;

do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron not installable in this session (%). Enable via Dashboard -> Database -> Extensions, then re-run.', sqlerrm;
  end;
  begin
    create extension if not exists pg_net;
  exception when others then
    raise notice 'pg_net not installable in this session (%). Enable via Dashboard -> Database -> Extensions, then re-run.', sqlerrm;
  end;
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 1 — CANONICAL BUSINESS TABLES (CREATED ONLY IF ABSENT)
-- If production already has bookings/listings/profiles/refunds, none of this
-- executes and Section 3 adapts to the real column names instead.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key,
  email      text,
  full_name  text,
  created_at timestamptz not null default now()
);

create table if not exists public.listings (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid,
  title      text not null default 'Untitled listing',
  created_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id           uuid primary key default gen_random_uuid(),
  listing_id   uuid references public.listings(id),
  renter_id    uuid,
  status       text not null default 'pending'
               check (status in ('pending','confirmed','approved','accepted',
                                 'cancelled','canceled','completed')),
  start_date   timestamptz,
  end_date     timestamptz,
  total_amount numeric(12,2) default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.refunds (
  id         uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id),
  amount     numeric(12,2) not null default 0,
  status     text default 'processed'
             check (status in ('pending','processed','completed','approved',
                               'succeeded','issued','refunded','rejected','failed')),
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- SECTION 2 — CONFIG + RUNTIME STATE
-- ----------------------------------------------------------------------------
create table if not exists public.email_config (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
alter table public.email_config enable row level security;

insert into public.email_config (key, value) values
  -- REQUIRED in setup: https://<PROJECT_REF>.supabase.co/functions/v1/notify-lifecycle
  ('edge_function_url',  ''),
  -- 'trigger' (default; transactional, fires inside the booking write tx)
  -- 'webhook' (Supabase DB Webhooks -> edge fn; disable triggers path)
  ('enqueue_source',     'trigger'),
  ('daily_soft_cap',     '85'),    -- >= cap: non-critical deferred +1 day
  ('daily_hard_cap',     '100'),   -- >= cap: even critical paused briefly
  ('critical_templates', 'booking_confirmation,booking_host_confirmation,booking_request_owner,booking_cancelled_renter,booking_cancelled_owner,refund_issued,booking_reminder,access_instructions')
on conflict (key) do nothing;

create table if not exists public.email_runtime_state (
  key              text primary key,
  owner_id         text,
  lease_expires_at timestamptz,
  value            jsonb not null default '{}',
  updated_at       timestamptz not null default now()
);
alter table public.email_runtime_state enable row level security;

create or replace function public.email_cfg(p_key text)
returns text
language sql stable
set search_path = public
as $$
  select value from public.email_config where key = p_key;
$$;

-- ----------------------------------------------------------------------------
-- SECTION 3 — RECONCILIATION: detect real column names, build canonical view
-- ----------------------------------------------------------------------------
do $$
declare
  v_pk        text;
  v_renter    text;
  v_listing   text;
  v_status    text;
  v_start     text;
  v_end       text;
  v_amount    text;
  v_owner     text;
  v_title     text;
  v_pemail    text;
  v_pname     text;
  v_has_listings  boolean;
  v_has_profiles  boolean;
  v_has_authusers boolean;
  v_sel   text;
  v_joins text := '';
begin
  if to_regclass('public.bookings') is null then
    raise warning 'bookings table missing — skipping ctx view + triggers. Create bookings, then re-run this migration.';
    return;
  end if;

  -- bookings primary key column
  select a.attname into v_pk
  from pg_index i
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
  where i.indrelid = 'public.bookings'::regclass and i.indisprimary
  limit 1;
  v_pk := coalesce(v_pk, 'id');

  select column_name into v_renter from information_schema.columns
   where table_schema='public' and table_name='bookings'
     and column_name in ('renter_id','user_id','customer_id','guest_id','renter_uuid')
   order by array_position(array['renter_id','user_id','customer_id','guest_id','renter_uuid'], column_name)
   limit 1;

  select column_name into v_listing from information_schema.columns
   where table_schema='public' and table_name='bookings'
     and column_name in ('listing_id','property_id','item_id','listing_uuid')
   order by array_position(array['listing_id','property_id','item_id','listing_uuid'], column_name)
   limit 1;

  select column_name into v_status from information_schema.columns
   where table_schema='public' and table_name='bookings'
     and column_name in ('status','booking_status','state')
   order by array_position(array['status','booking_status','state'], column_name)
   limit 1;

  select column_name into v_start from information_schema.columns
   where table_schema='public' and table_name='bookings'
     and column_name in ('start_date','starts_at','start_time','check_in','checkin_date','start_at')
   order by array_position(array['start_date','starts_at','start_time','check_in','checkin_date','start_at'], column_name)
   limit 1;

  select column_name into v_end from information_schema.columns
   where table_schema='public' and table_name='bookings'
     and column_name in ('end_date','ends_at','end_time','check_out','checkout_date','end_at')
   order by array_position(array['end_date','ends_at','end_time','check_out','checkout_date','end_at'], column_name)
   limit 1;

  select column_name into v_amount from information_schema.columns
   where table_schema='public' and table_name='bookings'
     and column_name in ('total_amount','amount','total_price','total','price')
   order by array_position(array['total_amount','amount','total_price','total','price'], column_name)
   limit 1;

  v_has_listings  := to_regclass('public.listings')  is not null;
  v_has_profiles  := to_regclass('public.profiles')  is not null;
  v_has_authusers := to_regclass('auth.users')       is not null;

  if v_has_listings then
    select column_name into v_owner from information_schema.columns
     where table_schema='public' and table_name='listings'
       and column_name in ('owner_id','user_id','host_id','landlord_id','vendor_id')
     order by array_position(array['owner_id','user_id','host_id','landlord_id','vendor_id'], column_name)
     limit 1;
    select column_name into v_title from information_schema.columns
     where table_schema='public' and table_name='listings'
       and column_name in ('title','name','listing_title')
     order by array_position(array['title','name','listing_title'], column_name)
     limit 1;
  end if;

  if v_has_profiles then
    select column_name into v_pemail from information_schema.columns
     where table_schema='public' and table_name='profiles'
       and column_name in ('email','contact_email','email_address')
     order by array_position(array['email','contact_email','email_address'], column_name)
     limit 1;
    select column_name into v_pname from information_schema.columns
     where table_schema='public' and table_name='profiles'
       and column_name in ('full_name','name','display_name','first_name','username')
     order by array_position(array['full_name','name','display_name','first_name','username'], column_name)
     limit 1;
  end if;

  -- Persist the detected mapping (trigger fns read it via email_cfg at runtime)
  insert into public.email_config (key, value) values
    ('ctx_booking_id_col', v_pk),
    ('ctx_renter_col',     coalesce(v_renter,  '')),
    ('ctx_listing_col',    coalesce(v_listing, '')),
    ('ctx_status_col',     coalesce(v_status,  '')),
    ('ctx_start_col',      coalesce(v_start,   '')),
    ('ctx_end_col',        coalesce(v_end,     '')),
    ('ctx_amount_col',     coalesce(v_amount,  '')),
    ('ctx_owner_col',      coalesce(v_owner,   '')),
    ('ctx_title_col',      coalesce(v_title,   '')),
    ('ctx_profile_email_col', coalesce(v_pemail, '')),
    ('ctx_profile_name_col',  coalesce(v_pname,  ''))
  on conflict (key) do update set value = excluded.value, updated_at = now();

  -- ---- Reconciliation report (NOTICEs surface in `supabase db push`) ----
  raise notice '===== GoRentals schema reconciliation =====';
  raise notice 'bookings PK             : %', v_pk;
  raise notice 'bookings renter column  : %', coalesce(v_renter,  '!! NOT FOUND — renter emails disabled');
  raise notice 'bookings listing column : %', coalesce(v_listing, '!! NOT FOUND — owner emails disabled');
  raise notice 'bookings status column  : %', coalesce(v_status,  '!! NOT FOUND — lifecycle triggers disabled');
  raise notice 'bookings start column   : %', coalesce(v_start,   '(none — booking_reminder scan matches nothing)');
  raise notice 'bookings end column     : %', coalesce(v_end,     '(none — review_request scan matches nothing)');
  raise notice 'bookings amount column  : %', coalesce(v_amount,  '(none — amount omitted from templates)');
  raise notice 'listings owner column   : %', coalesce(v_owner,   '(n/a)');
  raise notice 'listings title column   : %', coalesce(v_title,   '(n/a)');
  raise notice 'profiles email column   : %', coalesce(v_pemail,  '(falling back to auth.users.email)');
  raise notice 'profiles name column    : %', coalesce(v_pname,   '(none — templates use generic greeting)');
  raise notice 'auth.users readable     : %', v_has_authusers;
  raise notice '===========================================';

  -- ---- Build the canonical view by assembling safe SQL fragments ----
  v_sel := format(
    'select b.%I::uuid as booking_id, %s as renter_id, %s as renter_email, %s as renter_name, %s as owner_id, %s as owner_email, %s as owner_name, %s as listing_id, %s as listing_title, %s as status, %s as starts_at, %s as ends_at, %s as amount, b.created_at as created_at',
    v_pk,
    -- renter_id
    case when v_renter  is not null then format('b.%I::uuid', v_renter)  else 'null::uuid' end,
    -- renter_email: profiles.email -> auth.users.email -> null
    case
      when v_has_profiles and v_pemail is not null and v_has_authusers and v_renter is not null then
        format('nullif(lower(btrim(coalesce(pr.%I, ur.email, ''''))), '''')', v_pemail)
      when v_has_profiles and v_pemail is not null and v_renter is not null then
        format('nullif(lower(btrim(coalesce(pr.%I, ''''))), '''')', v_pemail)
      when v_has_authusers and v_renter is not null then
        'nullif(lower(btrim(coalesce(ur.email, ''''))), '''')'
      else 'null::text'
    end,
    -- renter_name (personalization; falls back to a friendly generic)
    case when v_has_profiles and v_pname is not null and v_renter is not null then
      format('coalesce(nullif(btrim(pr.%I), ''''), ''there'')', v_pname)
    else '''there''' end,
    -- owner_id
    case when v_has_listings and v_owner is not null and v_listing is not null then
      format('l.%I::uuid', v_owner) else 'null::uuid' end,
    -- owner_email
    case
      when v_has_listings and v_owner is not null and v_listing is not null
           and v_has_profiles and v_pemail is not null and v_has_authusers then
        format('nullif(lower(btrim(coalesce(po.%I, uo.email, ''''))), '''')', v_pemail)
      when v_has_listings and v_owner is not null and v_listing is not null
           and v_has_profiles and v_pemail is not null then
        format('nullif(lower(btrim(coalesce(po.%I, ''''))), '''')', v_pemail)
      when v_has_listings and v_owner is not null and v_listing is not null and v_has_authusers then
        'nullif(lower(btrim(coalesce(uo.email, ''''))), '''')'
      else 'null::text'
    end,
    -- owner_name
    case when v_has_profiles and v_pname is not null and v_has_listings and v_owner is not null and v_listing is not null then
      format('coalesce(nullif(btrim(po.%I), ''''), ''Host'')', v_pname)
    else '''Host''' end,
    -- listing_id
    case when v_listing is not null then format('b.%I::uuid', v_listing) else 'null::uuid' end,
    -- listing_title
    case when v_has_listings and v_title is not null and v_listing is not null then
      format('coalesce(l.%I, ''Your booking'')', v_title) else '''Your booking''' end,
    -- status
    case when v_status is not null then format('lower(coalesce(b.%I::text, ''''))', v_status) else '''''' end,
    -- starts_at / ends_at
    case when v_start is not null then format('b.%I::timestamptz', v_start) else 'null::timestamptz' end,
    case when v_end   is not null then format('b.%I::timestamptz', v_end)   else 'null::timestamptz' end,
    -- amount
    case when v_amount is not null then format('b.%I::numeric', v_amount) else 'null::numeric' end
  );

  if v_has_listings and v_listing is not null then
    v_joins := v_joins || format(' left join public.listings l on l.id = b.%I', v_listing);
  end if;
  if v_has_profiles and v_renter is not null then
    v_joins := v_joins || format(' left join public.profiles pr on pr.id = b.%I', v_renter);
  end if;
  if v_has_authusers and v_renter is not null then
    v_joins := v_joins || format(' left join auth.users ur on ur.id = b.%I', v_renter);
  end if;
  if v_has_listings and v_owner is not null and v_listing is not null and v_has_profiles then
    v_joins := v_joins || format(' left join public.profiles po on po.id = l.%I', v_owner);
  end if;
  if v_has_listings and v_owner is not null and v_listing is not null and v_has_authusers then
    v_joins := v_joins || format(' left join auth.users uo on uo.id = l.%I', v_owner);
  end if;

  execute 'drop view if exists public.email_bookings_ctx';
  execute format('create view public.email_bookings_ctx as %s from public.bookings b %s', v_sel, v_joins);
  raise notice 'email_bookings_ctx view (re)created.';
end $$;

alter table public.email_bookings_ctx set (security_invoker = off); -- run as owner (postgres) so it can read auth.users

-- refunds column mapping (used by the refund trigger)
do $$
declare
  v_ref_bkg  text;
  v_ref_amt  text;
  v_ref_stat text;
begin
  if to_regclass('public.refunds') is null then return; end if;

  select column_name into v_ref_bkg from information_schema.columns
   where table_schema='public' and table_name='refunds'
     and column_name in ('booking_id','booking','reservation_id')
   order by array_position(array['booking_id','booking','reservation_id'], column_name) limit 1;
  select column_name into v_ref_amt from information_schema.columns
   where table_schema='public' and table_name='refunds'
     and column_name in ('amount','refund_amount','total')
   order by array_position(array['amount','refund_amount','total'], column_name) limit 1;
  select column_name into v_ref_stat from information_schema.columns
   where table_schema='public' and table_name='refunds'
     and column_name in ('status','state')
   order by array_position(array['status','state'], column_name) limit 1;

  insert into public.email_config (key, value) values
    ('ctx_refund_booking_col', coalesce(v_ref_bkg,  '')),
    ('ctx_refund_amount_col',  coalesce(v_ref_amt,  '')),
    ('ctx_refund_status_col',  coalesce(v_ref_stat, ''))
  on conflict (key) do update set value = excluded.value, updated_at = now();

  raise notice 'refunds columns — booking: %, amount: %, status: %',
    coalesce(v_ref_bkg,'(none)'), coalesce(v_ref_amt,'(none)'), coalesce(v_ref_stat,'(none — every refund insert notifies)');
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 4 — email_queue
-- ----------------------------------------------------------------------------
create table if not exists public.email_queue (
  id           uuid primary key default gen_random_uuid(),
  template     text not null,
  recipient    text not null,                       -- normalized lower/btrim on insert
  payload      jsonb not null default '{}',
  status       text not null default 'queued'
               check (status in ('queued','processing','sent','dead')),
  priority     smallint not null default 5,         -- 1 = critical transactional, 9 = bulk marketing
  attempts     integer not null default 0,          -- incremented atomically at claim time
  max_attempts integer not null default 3,
  send_at      timestamptz not null default now(),
  locked_at    timestamptz,                         -- set when claimed ('processing')
  error_log    jsonb not null default '[]',         -- [{at, attempt, error}]
  created_at   timestamptz not null default now(),
  -- deterministic idempotency key: one PENDING queue row per logical email
  dedupe_key   text generated always as (
                 md5(coalesce(template,'') || '|' || coalesce(recipient,'') || '|' ||
                     coalesce(payload->>'booking_id','') || '|' ||
                     coalesce(payload->>'dedupe_key',''))
               ) stored
);

-- partial unique: prevents duplicate PENDING entries (retries after terminal
-- states are allowed; already-logged sends are blocked at send time via email_log)
create unique index if not exists email_queue_pending_uidx
  on public.email_queue (dedupe_key)
  where status in ('queued','processing');
create index if not exists email_queue_claim_idx
  on public.email_queue (priority, send_at, created_at)
  where status = 'queued';
create index if not exists email_queue_processing_idx
  on public.email_queue (locked_at)
  where status = 'processing';

comment on table public.email_queue is
  'Transactional + scheduled email queue. Drained by notify-lifecycle edge fn via pg_cron. Rows are claimed with FOR UPDATE SKIP LOCKED; status flow: queued -> processing -> sent|dead.';

-- ----------------------------------------------------------------------------
-- SECTION 5 — email_log (append-only event log, deterministic dedupe)
-- ----------------------------------------------------------------------------
create table if not exists public.email_log (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid,
  template        text not null,
  recipient       text not null,
  -- lifecycle events: accepted (Resend 200) -> sent -> delivered | bounced | complained | delivery_delayed | failed
  -- plus: skipped (suppressed/duplicate), never double-counted
  status_event    text not null
                  check (status_event in ('accepted','sent','delivered','bounced','complained',
                                          'delivery_delayed','failed','suppressed','skipped')),
  resend_email_id text,
  subject         text,
  detail          jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  -- SPEC idempotency: MD5(booking_id + template + recipient + status_event)
  dedupe_key      text generated always as (
                    md5(coalesce(booking_id::text,'none') || '|' || coalesce(template,'') || '|' ||
                        coalesce(recipient,'') || '|' || coalesce(status_event,''))
                  ) stored
);

create unique index if not exists email_log_dedupe_uidx on public.email_log (dedupe_key);
create index if not exists email_log_resend_id_idx on public.email_log (resend_email_id) where resend_email_id is not null;
create index if not exists email_log_daily_idx     on public.email_log (created_at) where status_event = 'accepted';
create index if not exists email_log_booking_idx   on public.email_log (booking_id, template);

comment on table public.email_log is
  'Append-only email lifecycle event log. Unique MD5(booking_id|template|recipient|status_event) makes webhook replays and re-enqueues idempotent.';

-- Latest lifecycle status per sent message (convenience view)
create or replace view public.email_latest_status as
select distinct on (coalesce(resend_email_id, dedupe_key))
       id, booking_id, template, recipient, resend_email_id, status_event as latest_event, created_at
from public.email_log
where status_event in ('accepted','sent','delivered','bounced','complained','delivery_delayed','failed','suppressed')
order by coalesce(resend_email_id, dedupe_key),
         array_position(array['accepted','sent','delivery_delayed','delivered','bounced','complained','failed','suppressed'], status_event) desc,
         created_at desc;

-- ----------------------------------------------------------------------------
-- SECTION 6 — suppression_list
-- ----------------------------------------------------------------------------
create table if not exists public.suppression_list (
  email      text primary key,        -- always stored lower/btrim (trigger-enforced)
  reason     text not null default 'manual'
             check (reason in ('bounced','complained','resend_suppressed','manual','unsubscribe')),
  created_at timestamptz not null default now()
);

create or replace function public.suppression_list_normalize()
returns trigger language plpgsql as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end $$;

drop trigger if exists trg_suppression_normalize on public.suppression_list;
create trigger trg_suppression_normalize
  before insert or update of email on public.suppression_list
  for each row execute function public.suppression_list_normalize();

comment on table public.suppression_list is
  'Hard/soft suppression. Checked before EVERY enqueue and EVERY send. Auto-populated by the Resend webhook on permanent bounces and complaints.';

create or replace function public.email_suppress(p_email text, p_reason text default 'manual')
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare v_email text := lower(btrim(coalesce(p_email,'')));
begin
  if v_email = '' or position('@' in v_email) = 0 then return false; end if;
  insert into public.suppression_list (email, reason)
  values (v_email, p_reason)
  on conflict (email) do nothing;
  return found;
end $$;

create or replace function public.email_unsuppress(p_email text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  delete from public.suppression_list where email = lower(btrim(coalesce(p_email,'')));
  return found;
end $$;

create or replace function public.email_is_suppressed(p_email text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.suppression_list
                 where email = lower(btrim(coalesce(p_email,''))));
$$;

-- ----------------------------------------------------------------------------
-- SECTION 7 — rate-limit guard + idempotent logging helpers
-- ----------------------------------------------------------------------------
create or replace function public.email_is_critical_template(p_template text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select p_template = any (
    select btrim(x)
    from unnest(string_to_array(
           coalesce(public.email_cfg('critical_templates'), 'booking_confirmation'),
           ',')) as x
  );
$$;

create or replace function public.email_daily_send_count()
returns integer
language sql stable security definer
set search_path = public
as $$
  select count(*)::integer
  from public.email_log
  where status_event = 'accepted'
    and created_at >= date_trunc('day', now());
$$;

-- allow | defer_day (non-critical over soft cap) | defer_hour (anyone over hard cap)
create or replace function public.email_rate_decision(p_template text)
returns text
language sql stable security definer
set search_path = public
as $$
  select case
    when c.daily < coalesce(nullif(public.email_cfg('daily_soft_cap'),'')::int, 85)
      then 'allow'
    when public.email_is_critical_template(p_template)
         and c.daily < coalesce(nullif(public.email_cfg('daily_hard_cap'),'')::int, 100)
      then 'allow'
    when public.email_is_critical_template(p_template)
      then 'defer_hour'
    else 'defer_day'
  end
  from (select public.email_daily_send_count() as daily) c;
$$;

create or replace function public.email_already_logged(
  p_booking_id uuid, p_template text, p_recipient text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.email_log
    where status_event = 'accepted'
      and template  = p_template
      and recipient = lower(btrim(coalesce(p_recipient,'')))
      and coalesce(booking_id::text,'none') = coalesce(p_booking_id::text,'none')
  );
$$;

-- Append-only, replay-safe event logger. Returns TRUE only when a NEW row was inserted.
create or replace function public.email_log_event(
  p_booking_id      uuid,
  p_template        text,
  p_recipient       text,
  p_status_event    text,
  p_resend_email_id text    default null,
  p_subject         text    default null,
  p_detail          jsonb   default '{}'::jsonb
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare v_n integer;
begin
  insert into public.email_log
    (booking_id, template, recipient, status_event, resend_email_id, subject, detail)
  values
    (p_booking_id, p_template, lower(btrim(coalesce(p_recipient,''))),
     p_status_event, p_resend_email_id, p_subject, coalesce(p_detail,'{}'::jsonb))
  on conflict (dedupe_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 8 — enqueue_email (single entry point; suppression + rate aware)
-- ----------------------------------------------------------------------------
create or replace function public.enqueue_email(
  p_template  text,
  p_recipient text,
  p_payload   jsonb   default '{}'::jsonb,
  p_priority  integer default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_recipient text := lower(btrim(coalesce(p_recipient,'')));
  v_booking   uuid := (nullif(p_payload->>'booking_id',''))::uuid;
  v_priority  smallint;
  v_send_at   timestamptz := now();
  v_rate      text;
  v_id        uuid;
  v_n         integer;
begin
  if v_recipient = '' or position('@' in v_recipient) = 0 then
    return null;  -- invalid address: silently drop (caller logs if desired)
  end if;

  if public.email_is_suppressed(v_recipient) then
    perform public.email_log_event(v_booking, p_template, v_recipient, 'skipped',
                                   null, null, jsonb_build_object('reason','suppressed'));
    return null;
  end if;

  v_priority := coalesce(
    p_priority::smallint,
    case when public.email_is_critical_template(p_template) then 1 else 5 end);

  -- Rate guard at ENQUEUE time (checked again at SEND time — defense in depth)
  v_rate := public.email_rate_decision(p_template);
  if v_rate = 'defer_day' then
    v_send_at := now() + interval '1 day';
  elsif v_rate = 'defer_hour' then
    v_send_at := now() + interval '15 minutes';
  end if;

  insert into public.email_queue
    (template, recipient, payload, priority, send_at)
  values
    (p_template, v_recipient, coalesce(p_payload,'{}'::jsonb), v_priority, v_send_at)
  on conflict (dedupe_key) where status in ('queued','processing')
  do nothing
  returning id into v_id;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    perform public.email_log_event(v_booking, p_template, v_recipient, 'skipped',
                                   null, null, jsonb_build_object('reason','duplicate_pending'));
    return null;
  end if;

  if v_send_at > now() then
    perform public.email_log_event(v_booking, p_template, v_recipient, 'skipped',
                                   null, null, jsonb_build_object('reason','rate_deferred','until', v_send_at));
  end if;
  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 9 — ATOMIC QUEUE CLAIM (FOR UPDATE SKIP LOCKED)
-- ----------------------------------------------------------------------------
create or replace function public.claim_email_batch(p_batch_size integer default 25)
returns setof public.email_queue
language plpgsql security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select q.id
    from public.email_queue q
    where q.status = 'queued'
      and q.send_at <= now()
    order by q.priority asc, q.send_at asc, q.created_at asc
    limit greatest(1, least(coalesce(p_batch_size, 25), 100))
    for update skip locked
  )
  update public.email_queue q
  set status    = 'processing',
      locked_at = now(),
      attempts  = q.attempts + 1        -- attempt consumed atomically at claim
  from claimed c
  where q.id = c.id
  returning q.*;
end $$;

comment on function public.claim_email_batch(integer) is
  'Race-free batch claim: CTE locks rows FOR UPDATE SKIP LOCKED, the outer UPDATE flips status=processing + locked_at=now() in the SAME transaction. Concurrent drainers always get disjoint batches.';

-- Per-row pre-send checks (suppression / idempotency / rate cap)
create or replace function public.email_send_precheck(p_queue_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare r public.email_queue;
begin
  select * into r from public.email_queue where id = p_queue_id;
  if r.id is null then
    return jsonb_build_object('ok', false, 'error', 'queue row not found');
  end if;
  return jsonb_build_object(
    'ok',              true,
    'suppressed',      public.email_is_suppressed(r.recipient),
    'already_logged',  public.email_already_logged((nullif(r.payload->>'booking_id',''))::uuid, r.template, r.recipient),
    'rate_decision',   public.email_rate_decision(r.template),
    'daily_sends',     public.email_daily_send_count(),
    'attempts',        r.attempts,
    'max_attempts',    r.max_attempts
  );
end $$;

-- Single outcome sink for the edge function.
-- p_outcome: sent | retry | dead | defer | skipped_suppressed | skipped_duplicate
create or replace function public.email_send_result(
  p_queue_id        uuid,
  p_outcome         text,
  p_resend_email_id text  default null,
  p_subject         text  default null,
  p_error           text  default null,
  p_detail          jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  r      public.email_queue;
  v_bkg  uuid;
  v_new_status text;
  v_backoff interval;
begin
  select * into r from public.email_queue where id = p_queue_id for update;
  if r.id is null then
    return jsonb_build_object('ok', false, 'error', 'queue row not found');
  end if;
  v_bkg := (nullif(r.payload->>'booking_id',''))::uuid;

  case p_outcome
  when 'sent' then
    v_new_status := 'sent';
    perform public.email_log_event(v_bkg, r.template, r.recipient, 'accepted',
                                   p_resend_email_id, p_subject,
                                   coalesce(p_detail,'{}'::jsonb) || jsonb_build_object('queue_id', r.id));
  when 'skipped_duplicate' then
    v_new_status := 'sent';   -- logically delivered earlier; nothing more to do
  when 'skipped_suppressed' then
    v_new_status := 'dead';
    perform public.email_log_event(v_bkg, r.template, r.recipient, 'skipped',
                                   null, null, jsonb_build_object('reason','suppressed_at_send'));
  when 'defer' then
    -- rate-limited: put back WITHOUT consuming the claim attempt
    update public.email_queue
    set status    = 'queued',
        locked_at = null,
        attempts  = greatest(attempts - 1, 0),
        send_at   = now() + make_interval(mins => coalesce((p_detail->>'defer_minutes')::int, 1440)),
        error_log = error_log || jsonb_build_array(jsonb_build_object(
                    'at', now(), 'attempt', attempts, 'note', coalesce(p_error,'rate deferred')))
    where id = r.id;
    return jsonb_build_object('ok', true, 'status', 'queued', 'deferred_to', now() + make_interval(mins => coalesce((p_detail->>'defer_minutes')::int, 1440)));
  when 'retry' then
    if r.attempts >= r.max_attempts then
      v_new_status := 'dead';
    else
      v_backoff := least(interval '5 minutes' * power(2, greatest(r.attempts - 1, 0)), interval '6 hours');
      update public.email_queue
      set status    = 'queued',
          locked_at = null,
          send_at   = now() + v_backoff,
          error_log = error_log || jsonb_build_array(jsonb_build_object(
                      'at', now(), 'attempt', r.attempts, 'error', coalesce(p_error,'retryable failure')))
      where id = r.id;
      return jsonb_build_object('ok', true, 'status', 'queued', 'retry_at', now() + v_backoff);
    end if;
  when 'dead' then
    v_new_status := 'dead';
  else
    return jsonb_build_object('ok', false, 'error', 'unknown outcome: ' || coalesce(p_outcome,'(null)'));
  end case;

  -- terminal bookkeeping (sent / dead paths)
  update public.email_queue
  set status    = v_new_status,
      error_log = case when p_error is not null
                       then error_log || jsonb_build_array(jsonb_build_object(
                              'at', now(), 'attempt', r.attempts, 'error', p_error))
                       else error_log end
  where id = r.id;

  if v_new_status = 'dead' then
    perform public.email_log_event(v_bkg, r.template, r.recipient, 'failed',
                                   p_resend_email_id, p_subject,
                                   jsonb_build_object('error', coalesce(p_error,''), 'attempts', r.attempts)
                                   || coalesce(p_detail,'{}'::jsonb));
    -- Resend-side suppression (403 on suppressed recipient) → mirror locally
    if coalesce((p_detail->>'resend_suppressed')::boolean, false) then
      perform public.email_suppress(r.recipient, 'resend_suppressed');
    end if;
  end if;

  return jsonb_build_object('ok', true, 'status', v_new_status, 'attempts', r.attempts);
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 10 — DRAIN LEASE (single active drainer) + STALE-LOCK RECOVERY
-- ----------------------------------------------------------------------------
create or replace function public.acquire_drain_lease(p_seconds integer default 240, p_owner text default '')
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare v_n integer;
begin
  insert into public.email_runtime_state (key, owner_id, lease_expires_at)
  values ('drain', p_owner, now() + make_interval(secs => greatest(p_seconds, 30)))
  on conflict (key) do update
    set owner_id         = excluded.owner_id,
        lease_expires_at = excluded.lease_expires_at,
        updated_at       = now()
    where public.email_runtime_state.lease_expires_at is null
       or public.email_runtime_state.lease_expires_at < now();
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

create or replace function public.release_drain_lease(p_owner text default '')
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  update public.email_runtime_state
  set lease_expires_at = null, updated_at = now()
  where key = 'drain' and (owner_id = p_owner or p_owner = '');
end $$;

-- Crash recovery: processing rows whose drainer died. Attempts were already
-- consumed at claim, so repeated crashes eventually dead-letter the row.
create or replace function public.requeue_stale_locks(p_minutes integer default 15)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare v_n integer;
begin
  update public.email_queue
  set status = case when attempts >= max_attempts then 'dead' else 'queued' end,
      locked_at = null,
      error_log = error_log || jsonb_build_array(jsonb_build_object(
                  'at', now(), 'note', 'stale processing lock requeued'))
  where status = 'processing'
    and locked_at < now() - make_interval(mins => greatest(p_minutes, 1));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 11 — RESEND WEBHOOK EVENT HANDLER (used by Next.js route + edge fn)
-- One RPC = atomic, idempotent, replay-safe (email_log dedupe).
-- ----------------------------------------------------------------------------
create or replace function public.handle_resend_webhook_event(p_event jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_type      text := p_event->>'type';
  v_data      jsonb := coalesce(p_event->'data', '{}'::jsonb);
  v_email_id  text := v_data->>'email_id';
  v_recipient text := lower(btrim(coalesce(v_data->'to'->>0, v_data->>'email', '')));
  v_event     text;
  v_anchor    public.email_log;
  v_template  text;
  v_booking   uuid;
  v_subject   text := v_data->>'subject';
  v_inserted  boolean;
  v_suppressed boolean := false;
  v_btype     text := v_data->'bounce'->>'type';
  v_bsubtype  text := v_data->'bounce'->>'subType';
begin
  -- map Resend event -> internal status_event
  v_event := case v_type
    when 'email.sent'             then 'sent'
    when 'email.delivered'        then 'delivered'
    when 'email.bounced'          then 'bounced'
    when 'email.complained'       then 'complained'
    when 'email.delivery_delayed' then 'delivery_delayed'
    when 'email.failed'           then 'failed'
    when 'email.suppressed'       then 'suppressed'
    when 'suppression.added'      then 'suppressed'
    else null
  end;

  if v_event is null then
    return jsonb_build_object('handled', false, 'reason', 'ignored event type: ' || coalesce(v_type,'?'));
  end if;

  -- suppression.removed: only drop entries that Resend itself created
  if v_type = 'suppression.removed' then
    delete from public.suppression_list
    where email = lower(btrim(coalesce(v_data->>'email','')))
      and reason = 'resend_suppressed';
    return jsonb_build_object('handled', true, 'action', 'unsuppressed_if_resend_only');
  end if;

  -- anchor back to the original send (booking/template) via resend_email_id
  if v_email_id is not null then
    select * into v_anchor from public.email_log
    where resend_email_id = v_email_id and status_event = 'accepted'
    order by created_at asc limit 1;
  end if;
  v_template := coalesce(v_anchor.template, v_data->>'template_id', 'unknown');
  v_booking  := v_anchor.booking_id;
  if v_recipient = '' then v_recipient := coalesce(v_anchor.recipient, 'unknown'); end if;

  v_inserted := public.email_log_event(
    v_booking, v_template, v_recipient, v_event, v_email_id, coalesce(v_subject, v_anchor.subject),
    jsonb_build_object('resend_event_type', v_type,
                       'bounce', v_data->'bounce',
                       'complaint', v_data->'complaint',
                       'received_at', p_event->>'created_at'));

  -- AUTO-SUPPRESSION RULES (deliverability-safe):
  --  * complaints → always suppress
  --  * permanent bounces / Resend-suppressed → suppress
  --  * TEMPORARY bounces → DO NOT suppress (retryable; delivery_delayed path)
  if v_type = 'email.complained' then
    v_suppressed := public.email_suppress(v_recipient, 'complained');
  elsif v_type in ('email.suppressed', 'suppression.added') then
    v_suppressed := public.email_suppress(v_recipient, 'resend_suppressed');
  elsif v_type = 'email.bounced'
        and (v_btype is null or lower(v_btype) = 'permanent' or lower(coalesce(v_bsubtype,'')) = 'suppressed') then
    v_suppressed := public.email_suppress(v_recipient, 'bounced');
  end if;

  return jsonb_build_object(
    'handled',       true,
    'event',         v_event,
    'log_inserted',  v_inserted,          -- false ⇒ duplicate/replayed webhook (safe no-op)
    'suppressed',    v_suppressed,
    'matched_booking', v_booking);
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 12 — SUPABASE DB WEBHOOK HANDLER (alternative to triggers)
-- Active only when email_config.enqueue_source = 'webhook'.
-- Payload shape: {type:'INSERT'|'UPDATE', table:'bookings'|'refunds',
--                 record:{...}, old_record:{...}}
-- ----------------------------------------------------------------------------
create or replace function public.handle_db_webhook_event(p_event jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_table   text := p_event->>'table';
  v_op      text := upper(coalesce(p_event->>'type',''));
  v_rec     jsonb := coalesce(p_event->'record', '{}'::jsonb);
  v_old     jsonb := p_event->'old_record';
  v_ctx     public.email_bookings_ctx%rowtype;
  v_status_col text := coalesce(nullif(public.email_cfg('ctx_status_col'),''), 'status');
  v_new     text;
  v_old_st  text;
  v_bkg_id  uuid;
  v_enq     integer := 0;
  v_payload jsonb;
begin
  if coalesce(public.email_cfg('enqueue_source'),'trigger') <> 'webhook' then
    return jsonb_build_object('handled', false, 'reason', 'enqueue_source is not webhook (triggers are authoritative)');
  end if;

  if v_table = 'bookings' and v_op in ('INSERT','UPDATE') then
    v_bkg_id := (nullif(v_rec->>'id',''))::uuid;
    if v_bkg_id is null then
      return jsonb_build_object('handled', false, 'reason', 'record.id missing');
    end if;
    select * into v_ctx from public.email_bookings_ctx where booking_id = v_bkg_id;
    if v_ctx.booking_id is null then
      return jsonb_build_object('handled', false, 'reason', 'booking not found in ctx view');
    end if;

    v_new    := lower(coalesce(v_rec->>v_status_col, ''));
    v_old_st := lower(coalesce(v_old->>v_status_col, ''));
    if v_op = 'UPDATE' and v_new = v_old_st then
      return jsonb_build_object('handled', true, 'enqueued', 0, 'note', 'status unchanged');
    end if;

    v_payload := jsonb_build_object(
      'booking_id',    v_ctx.booking_id,
      'renter_name',   v_ctx.renter_name,
      'owner_name',    v_ctx.owner_name,
      'listing_title', v_ctx.listing_title,
      'starts_at',     v_ctx.starts_at,
      'ends_at',       v_ctx.ends_at,
      'amount',        v_ctx.amount);

    if v_new in ('confirmed','approved','accepted')
       and (v_op = 'INSERT' or v_old_st not in ('confirmed','approved','accepted')) then
      if public.enqueue_email('booking_confirmation', v_ctx.renter_email, v_payload, 1) is not null then v_enq := v_enq + 1; end if;
      if public.enqueue_email('booking_host_confirmation', v_ctx.owner_email, v_payload, 1) is not null then v_enq := v_enq + 1; end if;
    elsif v_new = 'pending' and v_op = 'INSERT' then
      if public.enqueue_email('booking_request_owner', v_ctx.owner_email, v_payload, 1) is not null then v_enq := v_enq + 1; end if;
    elsif v_new in ('cancelled','canceled')
       and (v_op = 'INSERT' or v_old_st not in ('cancelled','canceled')) then
      if public.enqueue_email('booking_cancelled_renter', v_ctx.renter_email, v_payload, 1) is not null then v_enq := v_enq + 1; end if;
      if public.enqueue_email('booking_cancelled_owner', v_ctx.owner_email, v_payload, 1) is not null then v_enq := v_enq + 1; end if;
    end if;
    return jsonb_build_object('handled', true, 'enqueued', v_enq);
  end if;

  if v_table = 'refunds' and v_op = 'INSERT' then
    declare
      v_rstat_col text := coalesce(nullif(public.email_cfg('ctx_refund_status_col'),''), 'status');
      v_rbkg_col  text := coalesce(nullif(public.email_cfg('ctx_refund_booking_col'),''), 'booking_id');
      v_ramt_col  text := coalesce(nullif(public.email_cfg('ctx_refund_amount_col'),''), 'amount');
      v_rstat     text := lower(coalesce(v_rec->>v_rstat_col, ''));
    begin
      if v_rstat <> '' and v_rstat not in ('processed','completed','approved','succeeded','issued','refunded') then
        return jsonb_build_object('handled', false, 'reason', 'refund status not final: ' || v_rstat);
      end if;
      v_bkg_id := (nullif(v_rec->>v_rbkg_col,''))::uuid;
      select * into v_ctx from public.email_bookings_ctx where booking_id = v_bkg_id;
      if v_ctx.booking_id is null then
        return jsonb_build_object('handled', false, 'reason', 'booking not found for refund');
      end if;
      v_payload := jsonb_build_object(
        'booking_id', v_ctx.booking_id,
        'refund_id',  v_rec->>'id',
        'renter_name', v_ctx.renter_name,
        'amount',     coalesce((v_rec->>v_ramt_col)::numeric, 0),
        'listing_title', v_ctx.listing_title);
      if public.enqueue_email('refund_issued', v_ctx.renter_email, v_payload, 1) is not null then v_enq := 1; end if;
      return jsonb_build_object('handled', true, 'enqueued', v_enq);
    end;
  end if;

  return jsonb_build_object('handled', false, 'reason', 'unsupported table/op: ' || coalesce(v_table,'?') || '/' || coalesce(v_op,'?'));
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 13 — LIFECYCLE TRIGGERS (authoritative enqueue path by default)
-- Static functions; column names read from email_config at runtime;
-- to_jsonb(NEW/OLD) gives naming-variant-safe access.
-- ----------------------------------------------------------------------------
create or replace function public.email_trg_bookings()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_status_col text := coalesce(nullif(public.email_cfg('ctx_status_col'),''), 'status');
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
    return new;   -- status unchanged → nothing to do
  end if;

  select * into v_ctx from public.email_bookings_ctx
  where booking_id = ((to_jsonb(new) ->> coalesce(nullif(public.email_cfg('ctx_booking_id_col'),''),'id'))::uuid);
  if v_ctx.booking_id is null then
    return new;
  end if;

  v_payload := jsonb_build_object(
    'booking_id',    v_ctx.booking_id,
    'renter_name',   v_ctx.renter_name,
    'owner_name',    v_ctx.owner_name,
    'listing_title', v_ctx.listing_title,
    'starts_at',     v_ctx.starts_at,
    'ends_at',       v_ctx.ends_at,
    'amount',        v_ctx.amount);

  if v_new in ('confirmed','approved','accepted')
     and (v_old is null or v_old not in ('confirmed','approved','accepted')) then
    perform public.enqueue_email('booking_confirmation',      v_ctx.renter_email, v_payload, 1);
    perform public.enqueue_email('booking_host_confirmation', v_ctx.owner_email,  v_payload, 1);
  elsif v_new = 'pending' and tg_op = 'INSERT' then
    perform public.enqueue_email('booking_request_owner', v_ctx.owner_email, v_payload, 1);
  elsif v_new in ('cancelled','canceled')
     and (v_old is null or v_old not in ('cancelled','canceled')) then
    perform public.enqueue_email('booking_cancelled_renter', v_ctx.renter_email, v_payload, 1);
    perform public.enqueue_email('booking_cancelled_owner',  v_ctx.owner_email,  v_payload, 1);
  end if;

  return new;
exception
  when others then
    -- NEVER break the booking transaction because of email plumbing
    raise warning 'email_trg_bookings failed for booking %: %', (to_jsonb(new)->>'id'), sqlerrm;
    return new;
end $$;

create or replace function public.email_trg_refunds()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_bkg_col  text := coalesce(nullif(public.email_cfg('ctx_refund_booking_col'),''), 'booking_id');
  v_amt_col  text := coalesce(nullif(public.email_cfg('ctx_refund_amount_col'),''),  'amount');
  v_stat_col text := coalesce(nullif(public.email_cfg('ctx_refund_status_col'),''),  'status');
  v_rec      jsonb := to_jsonb(new);
  v_status   text := lower(coalesce(v_rec ->> v_stat_col, ''));
  v_bkg      uuid := (nullif(v_rec ->> v_bkg_col,''))::uuid;
  v_ctx      public.email_bookings_ctx%rowtype;
begin
  if coalesce(public.email_cfg('enqueue_source'),'trigger') <> 'trigger' then
    return new;
  end if;
  if v_status <> '' and v_status not in ('processed','completed','approved','succeeded','issued','refunded') then
    return new;   -- refund not final yet
  end if;

  select * into v_ctx from public.email_bookings_ctx where booking_id = v_bkg;
  if v_ctx.booking_id is null then return new; end if;

  perform public.enqueue_email('refund_issued', v_ctx.renter_email,
    jsonb_build_object(
      'booking_id',    v_ctx.booking_id,
      'refund_id',     v_rec->>'id',
      'renter_name',   v_ctx.renter_name,
      'amount',        coalesce((nullif(v_rec->>v_amt_col,''))::numeric, 0),
      'listing_title', v_ctx.listing_title), 1);
  return new;
exception
  when others then
    raise warning 'email_trg_refunds failed: %', sqlerrm;
    return new;
end $$;

-- attach triggers (guarded — tables may not exist)
do $$
begin
  if to_regclass('public.bookings') is not null then
    execute 'drop trigger if exists trg_bookings_email on public.bookings';
    execute 'create trigger trg_bookings_email after insert or update on public.bookings for each row execute function public.email_trg_bookings()';
    raise notice 'trigger trg_bookings_email attached to public.bookings';
  end if;
  if to_regclass('public.refunds') is not null then
    execute 'drop trigger if exists trg_refunds_email on public.refunds';
    execute 'create trigger trg_refunds_email after insert on public.refunds for each row execute function public.email_trg_refunds()';
    raise notice 'trigger trg_refunds_email attached to public.refunds';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 14 — SCHEDULED SCANS (review requests + booking reminders)
-- Pure SQL; idempotent via email_log/email_queue dedupe keys.
-- ----------------------------------------------------------------------------
create or replace function public.scan_booking_reminders(p_days_before integer default 1)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v_ctx record; v_enq integer := 0; v_n integer := 0;
begin
  for v_ctx in
    select * from public.email_bookings_ctx
    where status in ('confirmed','approved','accepted')
      and starts_at is not null
      and starts_at::date = (current_date + coalesce(p_days_before,1))
  loop
    v_n := v_n + 1;
    if public.enqueue_email('booking_reminder', v_ctx.renter_email,
         jsonb_build_object('booking_id', v_ctx.booking_id,
                            'renter_name', v_ctx.renter_name,
                            'listing_title', v_ctx.listing_title,
                            'starts_at', v_ctx.starts_at,
                            'ends_at', v_ctx.ends_at,
                            'amount', v_ctx.amount), 1) is not null then
      v_enq := v_enq + 1;
    end if;
  end loop;
  return jsonb_build_object('considered', v_n, 'enqueued', v_enq);
end $$;

create or replace function public.scan_review_requests(p_days_after integer default 3)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v_ctx record; v_enq integer := 0; v_n integer := 0;
begin
  for v_ctx in
    select * from public.email_bookings_ctx
    where status in ('completed','confirmed','approved','accepted')
      and ends_at is not null
      and ends_at::date = (current_date - coalesce(p_days_after,3))
  loop
    v_n := v_n + 1;
    if public.enqueue_email('review_request', v_ctx.renter_email,
         jsonb_build_object('booking_id', v_ctx.booking_id,
                            'renter_name', v_ctx.renter_name,
                            'listing_title', v_ctx.listing_title,
                            'starts_at', v_ctx.starts_at,
                            'ends_at', v_ctx.ends_at), 7) is not null then
      v_enq := v_enq + 1;
    end if;
  end loop;
  return jsonb_build_object('considered', v_n, 'enqueued', v_enq);
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 15 — HEALTH SNAPSHOT (used by edge fn HEALTHCHECK + runbook SQL)
-- ----------------------------------------------------------------------------
create or replace function public.email_health_snapshot()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare v_out jsonb;
begin
  select jsonb_build_object(
    'queue', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*) n from public.email_queue group by status) s),
    'oldest_queued_age_minutes', (
      select round(extract(epoch from now() - min(send_at)) / 60)
      from public.email_queue where status = 'queued' and send_at <= now()),
    'daily_sends',        public.email_daily_send_count(),
    'daily_soft_cap',     coalesce(nullif(public.email_cfg('daily_soft_cap'),'')::int, 85),
    'daily_hard_cap',     coalesce(nullif(public.email_cfg('daily_hard_cap'),'')::int, 100),
    'suppression_count',  (select count(*) from public.suppression_list),
    'dead_last_24h',      (select count(*) from public.email_log
                           where status_event = 'failed' and created_at > now() - interval '24 hours'),
    'bounced_last_24h',   (select count(*) from public.email_log
                           where status_event = 'bounced' and created_at > now() - interval '24 hours'),
    'delivered_last_24h', (select count(*) from public.email_log
                           where status_event = 'delivered' and created_at > now() - interval '24 hours'),
    'drain_lease',        (select jsonb_build_object('owner', owner_id, 'expires', lease_expires_at)
                           from public.email_runtime_state where key = 'drain'),
    'enqueue_source',     public.email_cfg('enqueue_source'),
    'edge_function_url_set', coalesce(public.email_cfg('edge_function_url'),'') <> '',
    'server_now',         now()
  ) into v_out;
  return v_out;
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 16 — pg_cron JOBS (secret pulled from Vault AT EXECUTION TIME)
-- ----------------------------------------------------------------------------
do $$
declare
  v_http_cmd text;
begin
  if to_regnamespace('cron') is null or to_regnamespace('net') is null then
    raise warning 'pg_cron/pg_net not present — cron jobs NOT scheduled. Enable extensions and re-run this migration.';
    return;
  end if;

  -- Shared HTTP command template. NOTE:
  --  * URL comes from email_config (no hardcoding)
  --  * secret comes from vault.decrypted_secrets at RUN time (never stored in cron.job)
  --  * job no-ops safely until edge_function_url is configured
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
                     'Content-Type',     'application/json',
                     'X-Internal-Secret', coalesce(
                       (select decrypted_secret from vault.decrypted_secrets
                        where name = 'EMAIL_INTERNAL_SECRET' limit 1),
                       'MISSING_VAULT_SECRET')),
        body    := jsonb_build_object('action', '%ACTION%'),
        timeout_milliseconds := 120000);
    end $job$;
  $CMD$;

  -- 1) QUEUE DRAIN — every 5 minutes (re-entrancy safe via lease + SKIP LOCKED)
  perform cron.schedule_in_database(
    'gorentals-email-queue-drain', '*/5 * * * *',
    replace(v_http_cmd, '%ACTION%', 'DRAIN_QUEUE'), current_database());

  -- 2) STALE LOCK RECOVERY — every 10 minutes, pure SQL (no secret needed)
  perform cron.schedule_in_database(
    'gorentals-email-requeue-stale', '*/10 * * * *',
    'select public.requeue_stale_locks(15);', current_database());

  -- 3) BOOKING REMINDERS — daily 09:00 (server TZ = UTC on Supabase; adjust to market)
  perform cron.schedule_in_database(
    'gorentals-email-booking-reminder', '0 9 * * *',
    replace(v_http_cmd, '%ACTION%', 'SCAN_REMINDERS'), current_database());

  -- 4) REVIEW REQUESTS — daily 10:05 (staggered; non-critical → soft-capped)
  perform cron.schedule_in_database(
    'gorentals-email-review-request', '5 10 * * *',
    replace(v_http_cmd, '%ACTION%', 'SCAN_REVIEWS'), current_database());

  raise notice 'pg_cron jobs scheduled: queue-drain */5, requeue-stale */10, booking-reminder 09:00, review-request 10:05 (UTC).';
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 17 — LOCKDOWN: RLS + REVOKEs + function grants
-- ----------------------------------------------------------------------------
alter table public.email_queue        enable row level security;
alter table public.email_log          enable row level security;
alter table public.suppression_list   enable row level security;
alter table public.email_runtime_state enable row level security;
alter table public.email_config       enable row level security;
-- no policies for anon/authenticated ⇒ deny-by-default; service_role/postgres bypass.

do $$
declare r text; f record;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.email_queue, public.email_log, public.suppression_list, public.email_config, public.email_runtime_state from %I', r);
      -- NOTE: deliberately NO blanket 'revoke all on all functions in schema public' —
      -- that would break the app's existing client-facing RPCs. The email RPCs are
      -- revoked individually in the loop below (EXECUTE defaults to PUBLIC in pg).
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.email_queue, public.email_log, public.suppression_list, public.email_config, public.email_runtime_state to service_role;
  end if;

  -- SECURITY DEFINER RPC surface: service_role only (+ owner postgres)
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('enqueue_email','claim_email_batch','email_send_precheck','email_send_result',
                        'acquire_drain_lease','release_drain_lease','requeue_stale_locks',
                        'handle_resend_webhook_event','handle_db_webhook_event',
                        'scan_booking_reminders','scan_review_requests','email_health_snapshot',
                        'email_suppress','email_unsuppress','email_log_event',
                        'email_is_suppressed','email_rate_decision','email_daily_send_count',
                        'email_already_logged','email_is_critical_template','email_cfg')
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

  raise notice 'RLS enabled and grants locked down (service_role/postgres only).';
end $$;

-- ----------------------------------------------------------------------------
-- SECTION 18 — REMINDERS (human-readable)
-- ----------------------------------------------------------------------------
do $$
begin
  raise notice 'NEXT STEPS: (1) insert EMAIL_INTERNAL_SECRET into vault; (2) set email_config.edge_function_url; (3) supabase secrets set + functions deploy; (4) configure Resend webhook. See SETUP.md.';
end $$;
