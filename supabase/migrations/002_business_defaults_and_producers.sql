-- ============================================================================
-- GoRentals Email System — 002_business_defaults_and_producers.sql
-- ============================================================================
-- Implements the GoRentals launch blueprint on top of the hardened v2 core:
--
--   * BUSINESS DEFAULTS: INR default currency, Asia/Kolkata business timezone
--     (rate-cap day window + presentation follow the BUSINESS timezone;
--     per-booking currency/timezone columns still take precedence)
--   * NEW PRODUCERS:
--       - welcome email on profiles INSERT (WELCOME:{user_id})
--       - win-back tiers 30/60/90 (weekly scan, sliding windows, campaign-
--         scoped logical ids → each user gets at most one email per tier)
--   * SCHEMA MAPPING v3: bookings.owner_id/host_id now takes precedence over
--     listings.owner_id (blueprint schema carries owner on bookings);
--     listings.city/location/town mapped into ctx + payloads + templates
--   * CRON: reminder/review rescheduled to IST mornings; weekly win-back job;
--     HTTP jobs accept EMAIL_INTERNAL_SECRET with WEBHOOK_SECRET vault alias
--   * profiles added to the DB-webhook handler (webhook enqueue mode)
--
-- IDEMPOTENT. Requires 000 + 001. Business tables are never modified except
-- the additive nullable currency/timezone columns introduced by 001.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- SECTION A — business configuration
-- ----------------------------------------------------------------------------
insert into public.email_config (key, value) values
  ('business_timezone', 'Asia/Kolkata'),   -- rate-cap day boundary + scan scheduling anchor
  ('email_locale',      'en-IN')           -- presentation locale default (edge fn may override via env)
on conflict (key) do nothing;

-- GoRentals is INR-native: flip the 001 default only if it is still the
-- untouched factory value; per-booking currency columns always win.
update public.email_config set value = 'INR', updated_at = now()
where key = 'default_currency' and value = 'USD';

-- ----------------------------------------------------------------------------
-- SECTION B — daily send count on the BUSINESS-timezone day boundary
-- (language change sql→plpgsql requires drop+create)
-- ----------------------------------------------------------------------------
drop function if exists public.email_daily_send_count();
create function public.email_daily_send_count()
returns integer
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_tz    text := coalesce(nullif(public.email_cfg('business_timezone'), ''), 'UTC');
  v_start timestamptz;
  v_n     integer;
begin
  begin
    v_start := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  exception when others then
    raise warning 'invalid business_timezone "%" — falling back to UTC day window', v_tz;
    v_start := date_trunc('day', now());
  end;
  select count(*)::integer into v_n
  from public.email_send_attempts
  where status = 'accepted' and request_finished_at >= v_start;
  return v_n;
end $$;

-- ----------------------------------------------------------------------------
-- SECTION C — template registry additions + extended logical-id tokens
-- ----------------------------------------------------------------------------
insert into public.email_templates
  (key, version, enabled, category, critical, logical_id_pattern, payload_schema, subject_template, description)
values
  ('welcome', 1, true, 'transactional', true,
   'WELCOME:{user_id}',
   '{"required":["user_id"],"properties":{"user_id":{"type":"uuid"},"name":{"type":"string"}}}',
   'Welcome to GoRentals, {name}', 'Signup welcome (critical, once per user)')
on conflict (key, version) do update
  set enabled = excluded.enabled, category = excluded.category, critical = excluded.critical,
      logical_id_pattern = excluded.logical_id_pattern, payload_schema = excluded.payload_schema,
      subject_template = excluded.subject_template, description = excluded.description;

-- derive v2: adds {user_id} and {name} tokens (welcome), keeps every v1 token
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
    (select array_agg(distinct m[1]) from regexp_matches(v_pattern, '\{([a-z_0-9]+)\}', 'g') as m),
    '{}'::text[])
  loop
    v_val := case v_token
      when 'booking_id'  then nullif(p_payload->>'booking_id','')
      when 'refund_id'   then nullif(p_payload->>'refund_id','')
      when 'user_id'     then nullif(p_payload->>'user_id','')
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

-- ----------------------------------------------------------------------------
-- SECTION D — SCHEMA MAPPING v3 (type-validated): owner-on-bookings + city
-- ----------------------------------------------------------------------------
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
    raise exception 'SCHEMA MAPPING: public.%.% exists but type "%" is incompatible (expected one of: %). Fix the column or adjust the candidate list in migration 002 §D.',
      p_table, v_bad, v_badtype, array_to_string(p_types, ', ');
  end if;
  return;
end $$;

do $$
declare
  v_pk text; v_pk_t text;
  v_renter text; v_renter_t text;
  v_listing text; v_listing_t text;
  v_status text;
  v_start text; v_start_t text;
  v_end text; v_end_t text;
  v_amount text; v_amount_t text;
  v_currency text; v_tz text; v_tz_table text;
  v_bowner text; v_bowner_t text;          -- NEW: owner directly on bookings
  v_owner text; v_owner_t text;            -- owner on listings (fallback)
  v_title text; v_city text;               -- NEW: listings.city
  v_pemail text; v_pname text;
  v_has_listings boolean; v_has_profiles boolean; v_has_authusers boolean;
  v_sel text; v_joins text := ''; v_owner_desc text;
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  iso_re  constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9:.+-]*)?$';
  v_owner_ref text;                        -- qualified owner reference (b.x or l.x)
begin
  if to_regclass('public.bookings') is null then
    raise warning 'bookings missing — skipping ctx v3 rebuild';
    return;
  end if;

  select col, dtype into v_pk, v_pk_t from public._email_pick_col('bookings',
    array['id','booking_id','uuid'], array['uuid']);
  if v_pk is null then raise exception 'SCHEMA MAPPING: bookings has no uuid PK candidate'; end if;

  select col, dtype into v_renter, v_renter_t from public._email_pick_col('bookings',
    array['renter_id','user_id','customer_id','guest_id','renter_uuid'],
    array['uuid','text','character varying']);
  if v_renter is null then raise exception 'SCHEMA MAPPING: bookings has no renter reference column'; end if;

  select col into v_status from public._email_pick_col('bookings',
    array['status','booking_status','state'], array['text','character varying','USER-DEFINED']);
  if v_status is null then raise exception 'SCHEMA MAPPING: bookings has no status column'; end if;

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

  -- NEW: owner carried directly on bookings (blueprint schema) takes precedence
  select col, dtype into v_bowner, v_bowner_t from public._email_pick_col('bookings',
    array['owner_id','host_id'], array['uuid','text','character varying']);

  v_has_listings  := to_regclass('public.listings') is not null;
  v_has_profiles  := to_regclass('public.profiles') is not null;
  v_has_authusers := to_regclass('auth.users') is not null;

  if v_has_listings then
    select col, dtype into v_owner, v_owner_t from public._email_pick_col('listings',
      array['owner_id','user_id','host_id','landlord_id','vendor_id'], array['uuid','text','character varying']);
    select col into v_title from public._email_pick_col('listings',
      array['title','name','listing_title'], array['text','character varying']);
    select col into v_city from public._email_pick_col('listings',
      array['city','location','town','area'], array['text','character varying']);
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

  if v_start is null then raise warning 'MAPPING v3: no booking start column — reminders disabled'; end if;
  if v_end is null then raise warning 'MAPPING v3: no booking end column — review scan disabled'; end if;
  if v_city is null then raise warning 'MAPPING v3: no listings city column — templates omit location'; end if;

  insert into public.email_config (key, value) values
    ('ctx_booking_id_col', v_pk), ('ctx_renter_col', v_renter),
    ('ctx_listing_col', coalesce(v_listing,'')), ('ctx_status_col', v_status),
    ('ctx_start_col', coalesce(v_start,'')), ('ctx_end_col', coalesce(v_end,'')),
    ('ctx_amount_col', coalesce(v_amount,'')), ('ctx_currency_col', coalesce(v_currency,'')),
    ('ctx_tz_col', coalesce(v_tz,'')), ('ctx_tz_table', coalesce(v_tz_table,'')),
    ('ctx_bookings_owner_col', coalesce(v_bowner,'')),
    ('ctx_owner_col', coalesce(v_owner,'')),
    ('ctx_title_col', coalesce(v_title,'')), ('ctx_city_col', coalesce(v_city,'')),
    ('ctx_profile_email_col', coalesce(v_pemail,'')),
    ('ctx_profile_name_col', coalesce(v_pname,'')), ('ctx_mapping_version', '3')
  on conflict (key) do update set value = excluded.value, updated_at = now();

  raise notice '===== GoRentals schema reconciliation (v3) =====';
  raise notice 'pk=% renter=%(%) status=% start=% end=% amount=% currency=% tz=%(%)',
    v_pk, v_renter, v_renter_t, v_status, coalesce(v_start,'-'), coalesce(v_end,'-'),
    coalesce(v_amount,'-'), coalesce(v_currency,'(default INR)'), coalesce(v_tz,'(business tz)'), coalesce(v_tz_table,'-');
  v_owner_desc := case when v_bowner is not null then 'bookings.' || v_bowner
                       when v_owner is not null and v_listing is not null then 'listings.' || v_owner
                       else '(none — owner emails disabled)' end;
  raise notice 'owner source: %   listings.title=% listings.city=%',
    v_owner_desc, coalesce(v_title,'-'), coalesce(v_city,'-');
  raise notice '===============================================';

  -- owner reference: prefer bookings.<owner col>, else listings.<owner col>
  if v_bowner is not null then
    v_owner_ref := case when v_bowner_t = 'uuid' then format('b.%I::uuid', v_bowner)
      else format('case when b.%1$I ~* ''%2$s'' then b.%1$I::uuid else null end', v_bowner, uuid_re) end;
  elsif v_owner is not null and v_listing is not null then
    v_owner_ref := case when v_owner_t = 'uuid' then format('l.%I::uuid', v_owner)
      else format('case when l.%1$I ~* ''%2$s'' then l.%1$I::uuid else null end', v_owner, uuid_re) end;
  else
    v_owner_ref := 'null::uuid';
  end if;

  v_sel := format(
    'select b.%I::uuid as booking_id, %s as renter_id, %s as renter_email, %s as renter_name, %s as owner_id, %s as owner_email, %s as owner_name, %s as listing_id, %s as listing_title, %s as city, %s as status, %s as starts_at, %s as ends_at, %s as amount, %s as currency, %s as timezone, b.created_at as created_at',
    v_pk,
    case when v_renter_t = 'uuid' then format('b.%I::uuid', v_renter)
         else format('case when b.%1$I ~* ''%2$s'' then b.%1$I::uuid else null end', v_renter, uuid_re) end,
    case
      when v_has_profiles and v_pemail is not null and v_has_authusers then
        format('nullif(lower(btrim(coalesce(pr.%I, ur.email, ''''))), '''')', v_pemail)
      when v_has_profiles and v_pemail is not null then
        format('nullif(lower(btrim(coalesce(pr.%I, ''''))), '''')', v_pemail)
      when v_has_authusers then 'nullif(lower(btrim(coalesce(ur.email, ''''))), '''')'
      else 'null::text' end,
    case when v_has_profiles and v_pname is not null then
      format('coalesce(nullif(btrim(pr.%I), ''''), ''there'')', v_pname) else '''there''' end,
    v_owner_ref,
    -- owner_email: profiles/auth join keyed off whichever table carries owner
    case
      when v_bowner is null and (v_owner is null or v_listing is null) then 'null::text'
      when v_has_profiles and v_pemail is not null and v_has_authusers then
        format('nullif(lower(btrim(coalesce(po.%I, uo.email, ''''))), '''')', v_pemail)
      when v_has_profiles and v_pemail is not null then
        format('nullif(lower(btrim(coalesce(po.%I, ''''))), '''')', v_pemail)
      when v_has_authusers then 'nullif(lower(btrim(coalesce(uo.email, ''''))), '''')'
      else 'null::text' end,
    case when v_has_profiles and v_pname is not null and (v_bowner is not null or (v_owner is not null and v_listing is not null)) then
      format('coalesce(nullif(btrim(po.%I), ''''), ''Host'')', v_pname) else '''Host''' end,
    case when v_listing is null then 'null::uuid'
         when v_listing_t = 'uuid' then format('b.%I::uuid', v_listing)
         else format('case when b.%1$I ~* ''%2$s'' then b.%1$I::uuid else null end', v_listing, uuid_re) end,
    case when v_has_listings and v_title is not null and v_listing is not null then
      format('coalesce(l.%I, ''Your booking'')', v_title) else '''Your booking''' end,
    case when v_has_listings and v_city is not null and v_listing is not null then
      format('l.%I', v_city) else 'null::text' end,
    format('lower(coalesce(b.%I::text, ''''))', v_status),
    case when v_start is null then 'null::timestamptz'
         when v_start_t like 'timestamp%' or v_start_t = 'date' then format('b.%I::timestamptz', v_start)
         else format('case when b.%1$I ~ ''%2$s'' then b.%1$I::timestamptz else null end', v_start, iso_re) end,
    case when v_end is null then 'null::timestamptz'
         when v_end_t like 'timestamp%' or v_end_t = 'date' then format('b.%I::timestamptz', v_end)
         else format('case when b.%1$I ~ ''%2$s'' then b.%1$I::timestamptz else null end', v_end, iso_re) end,
    case when v_amount is null then 'null::numeric'
         when v_amount_t in ('numeric','integer','bigint','double precision','real') then format('b.%I::numeric', v_amount)
         else format('case when b.%1$I ~ ''^[0-9]+(\.[0-9]+)?$'' then b.%1$I::numeric else null end', v_amount) end,
    case when v_currency is null then 'coalesce(nullif(public.email_cfg(''default_currency''),''''), ''INR'')'
         else format('coalesce(nullif(upper(btrim(b.%I)), ''''), coalesce(nullif(public.email_cfg(''default_currency''),''''), ''INR''))', v_currency) end,
    case when v_tz is null then 'coalesce(nullif(public.email_cfg(''business_timezone''),''''), ''UTC'')'
         else format('coalesce(nullif(btrim(%s.%I), ''''), public.email_cfg(''business_timezone''), ''UTC'')', v_tz_table, v_tz) end
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
  -- owner profiles/auth joins keyed off the owning table
  if v_has_profiles and (v_bowner is not null or (v_owner is not null and v_listing is not null)) then
    v_joins := v_joins || case
      when v_bowner is not null and v_bowner_t = 'uuid' then format(' left join public.profiles po on po.id = b.%I', v_bowner)
      when v_bowner is not null then format(' left join public.profiles po on po.id::text = b.%I', v_bowner)
      when v_owner_t = 'uuid' then format(' left join public.profiles po on po.id = l.%I', v_owner)
      else format(' left join public.profiles po on po.id::text = l.%I', v_owner) end;
  end if;
  if v_has_authusers and (v_bowner is not null or (v_owner is not null and v_listing is not null)) then
    v_joins := v_joins || case
      when v_bowner is not null and v_bowner_t = 'uuid' then format(' left join auth.users uo on uo.id = b.%I', v_bowner)
      when v_bowner is not null then format(' left join auth.users uo on uo.id::text = b.%I', v_bowner)
      when v_owner_t = 'uuid' then format(' left join auth.users uo on uo.id = l.%I', v_owner)
      else format(' left join auth.users uo on uo.id::text = l.%I', v_owner) end;
  end if;

  execute 'drop view if exists public.email_bookings_ctx';
  execute format('create view public.email_bookings_ctx as %s from public.bookings b %s', v_sel, v_joins);
  execute 'alter view public.email_bookings_ctx set (security_invoker = off)';
  raise notice 'email_bookings_ctx v3 (re)created: + city, owner-source aware, business tz/currency defaults.';
end $$;

drop function if exists public._email_pick_col(text, text[], text[]);

-- ----------------------------------------------------------------------------
-- SECTION E — LIFECYCLE TRIGGERS v3 (city in payload) + WELCOME producer
-- ----------------------------------------------------------------------------
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
    return new;
  end if;

  v_new := lower(coalesce(to_jsonb(new) ->> v_status_col, ''));
  v_old := case when tg_op = 'UPDATE' then lower(coalesce(to_jsonb(old) ->> v_status_col, '')) else null end;
  if tg_op = 'UPDATE' and v_new = v_old then
    return new;
  end if;

  select * into v_ctx from public.email_bookings_ctx
  where booking_id = ((to_jsonb(new) ->> v_pk_col)::uuid);
  if v_ctx.booking_id is null then
    raise exception 'email outbox: booking % not resolvable via email_bookings_ctx', (to_jsonb(new) ->> v_pk_col);
  end if;

  v_payload := jsonb_build_object(
    'booking_id',    v_ctx.booking_id,
    'renter_name',   v_ctx.renter_name,
    'owner_name',    v_ctx.owner_name,
    'listing_title', v_ctx.listing_title,
    'city',          v_ctx.city,
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
  -- NO exception handler: outbox failures roll back the business write (fail-loud).
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
  if not (v_new_st = any (v_final)) then return new; end if;
  if v_old_st is not null and v_old_st = any (v_final) then return new; end if;

  v_refund_id := (nullif(v_new_rec ->> v_id_col, ''))::uuid;
  select * into v_ctx from public.email_bookings_ctx
  where booking_id = (nullif(v_new_rec ->> v_bkg_col, ''))::uuid;
  if v_ctx.booking_id is null then
    raise exception 'email outbox: refund % references unresolvable booking', v_refund_id;
  end if;
  if v_ctx.renter_email is null then
    raise notice 'email outbox: refund % renter has no email — skipped', v_refund_id;
    return new;
  end if;

  perform public.enqueue_email_v2('refund_issued', v_ctx.renter_email,
    jsonb_build_object(
      'refund_id',     v_refund_id,
      'booking_id',    v_ctx.booking_id,
      'renter_name',   v_ctx.renter_name,
      'amount',        coalesce((nullif(v_new_rec ->> v_amt_col, ''))::numeric, 0),
      'currency',      v_ctx.currency,
      'city',          v_ctx.city,
      'listing_title', v_ctx.listing_title),
    null, 'REFUND_ISSUED:' || upper(v_refund_id::text));
  return new;
end $$;

-- NEW producer: welcome email on profiles INSERT (fail-loud like the others)
create or replace function public.email_trg_profiles_v2()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_email_col text := coalesce(nullif(public.email_cfg('ctx_profile_email_col'),''), 'email');
  v_name_col  text := coalesce(nullif(public.email_cfg('ctx_profile_name_col'),''),  'full_name');
  v_rec       jsonb := to_jsonb(new);
  v_uid       uuid  := (nullif(v_rec ->> 'id',''))::uuid;
  v_email     text  := nullif(lower(btrim(coalesce(v_rec ->> v_email_col, ''))), '');
  v_name      text;
begin
  if coalesce(public.email_cfg('enqueue_source'),'trigger') <> 'trigger' then
    return new;
  end if;

  if v_email is null and to_regclass('auth.users') is not null then
    select nullif(lower(btrim(email)),'') into v_email from auth.users where id = v_uid;
  end if;
  if v_email is null then
    raise notice 'email outbox: profile % has no email — welcome skipped', v_uid;
    return new;   -- legitimate no-op: a signup without an address cannot be emailed
  end if;

  v_name := coalesce(nullif(btrim(v_rec ->> v_name_col), ''), 'there');
  perform public.enqueue_email_v2('welcome', v_email,
    jsonb_build_object('user_id', v_uid, 'name', v_name, 'renter_name', v_name));
  return new;
end $$;

do $$
begin
  if to_regclass('public.profiles') is not null then
    execute 'drop trigger if exists trg_profiles_email_v2 on public.profiles';
    execute 'create trigger trg_profiles_email_v2 after insert on public.profiles for each row execute function public.email_trg_profiles_v2()';
    raise notice 'trigger trg_profiles_email_v2 attached (welcome emails).';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- SECTION F — DB-WEBHOOK HANDLER v3 (adds profiles branch + city payload)
-- ----------------------------------------------------------------------------
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

  if v_table = 'profiles' and v_op = 'INSERT' then
    declare
      v_ec text := coalesce(nullif(public.email_cfg('ctx_profile_email_col'),''),'email');
      v_nc text := coalesce(nullif(public.email_cfg('ctx_profile_name_col'),''),'full_name');
      v_uid uuid := (nullif(v_rec->>'id',''))::uuid;
      v_email text := nullif(lower(btrim(coalesce(v_rec->>v_ec,''))),'');
      v_name text := coalesce(nullif(btrim(v_rec->>v_nc),''),'there');
    begin
      if v_email is null and to_regclass('auth.users') is not null then
        select nullif(lower(btrim(email)),'') into v_email from auth.users where id = v_uid;
      end if;
      if v_email is null then
        return jsonb_build_object('handled', true, 'enqueued', 0, 'note', 'profile has no email');
      end if;
      r := public.enqueue_email_v2('welcome', v_email,
             jsonb_build_object('user_id', v_uid, 'name', v_name, 'renter_name', v_name));
      return jsonb_build_object('handled', true,
        'enqueued', (case when r->>'status' = 'queued' then 1 else 0 end), 'detail', r);
    end;
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
      'city', v_ctx.city, 'starts_at', v_ctx.starts_at, 'ends_at', v_ctx.ends_at,
      'amount', v_ctx.amount, 'currency', v_ctx.currency, 'timezone', v_ctx.timezone);
    if v_new in ('confirmed','approved','accepted') and (v_op='INSERT' or v_old_st not in ('confirmed','approved','accepted')) then
      r := public.enqueue_email_v2('booking_confirmation', v_ctx.renter_email, v_payload);
      v_enq := v_enq + (case when r->>'status'='queued' then 1 else 0 end);
      r := public.enqueue_email_v2('booking_host_confirmation', v_ctx.owner_email, v_payload);
      v_enq := v_enq + (case when r->>'status'='queued' then 1 else 0 end);
    elsif v_new = 'pending' and v_op = 'INSERT' then
      r := public.enqueue_email_v2('booking_request_owner', v_ctx.owner_email, v_payload);
      v_enq := v_enq + (case when r->>'status'='queued' then 1 else 0 end);
    elsif v_new in ('cancelled','canceled') and (v_op='INSERT' or v_old_st not in ('cancelled','canceled')) then
      r := public.enqueue_email_v2('booking_cancelled_renter', v_ctx.renter_email, v_payload);
      v_enq := v_enq + (case when r->>'status'='queued' then 1 else 0 end);
      r := public.enqueue_email_v2('booking_cancelled_owner', v_ctx.owner_email, v_payload);
      v_enq := v_enq + (case when r->>'status'='queued' then 1 else 0 end);
    end if;
    return jsonb_build_object('handled', true, 'enqueued', v_enq);
  end if;

  if v_table = 'refunds' and v_op in ('INSERT','UPDATE') then
    declare
      v_id_col text := coalesce(nullif(public.email_cfg('ctx_refund_id_col'),''),'id');
      v_bk_col text := coalesce(nullif(public.email_cfg('ctx_refund_booking_col'),''),'booking_id');
      v_am_col text := coalesce(nullif(public.email_cfg('ctx_refund_amount_col'),''),'amount');
      v_st2_col text := coalesce(nullif(public.email_cfg('ctx_refund_status_col'),''),'status');
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
                           'currency', v_ctx.currency, 'city', v_ctx.city,
                           'listing_title', v_ctx.listing_title),
        null, 'REFUND_ISSUED:' || upper(coalesce(v_rec->>v_id_col, '')));
      return jsonb_build_object('handled', true, 'enqueued', (case when r->>'status'='queued' then 1 else 0 end));
    end;
  end if;

  return jsonb_build_object('handled', false, 'reason', 'unsupported table/op: ' || coalesce(v_table,'?') || '/' || coalesce(v_op,'?'));
end $$;

-- ----------------------------------------------------------------------------
-- SECTION G — SCANS v3 (city payload) + WIN-BACK TIERS
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
                         'listing_title', v_ctx.listing_title, 'city', v_ctx.city,
                         'starts_at', v_ctx.starts_at, 'ends_at', v_ctx.ends_at,
                         'timezone', v_ctx.timezone));
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
                         'listing_title', v_ctx.listing_title, 'city', v_ctx.city,
                         'starts_at', v_ctx.starts_at, 'ends_at', v_ctx.ends_at,
                         'timezone', v_ctx.timezone));
    v_enq := v_enq + (case when r->>'status' = 'queued' then 1 else 0 end);
  end loop;
  return jsonb_build_object('considered', v_n, 'enqueued', v_enq,
                            'campaign', public.email_cfg('review_campaign_version'));
end $$;

-- Win-back tiers: users idle for [tier, tier+7) days (weekly cadence ⇒ each
-- user passes through each tier window exactly once). Campaign id includes the
-- ISO week ⇒ re-runs inside a week dedupe via UNIQUE(logical_event_id).
create or replace function public.scan_winbacks(p_tier_days integer default 30)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare r record; v_enq integer := 0; v_n integer := 0; v_res jsonb; v_campaign text;
begin
  v_campaign := 'WB' || p_tier_days || '-' || to_char(now(), 'IYYY-"W"IW');
  for r in
    select renter_email,
           max(renter_name)          as renter_name,
           max(renter_id::text)::uuid as renter_id
    from public.email_bookings_ctx
    where renter_email is not null and renter_id is not null
    group by renter_email
    having floor(extract(epoch from (now() - max(coalesce(ends_at, created_at)))) / 86400)
             between p_tier_days and p_tier_days + 6
  loop
    v_n := v_n + 1;
    v_res := public.enqueue_email_v2('win_back', r.renter_email,
      jsonb_build_object('campaign', v_campaign, 'renter_name', r.renter_name,
                         'user_id', r.renter_id));
    if v_res->>'status' = 'queued' then v_enq := v_enq + 1; end if;
  end loop;
  return jsonb_build_object('tier_days', p_tier_days, 'campaign', v_campaign,
                            'considered', v_n, 'enqueued', v_enq);
end $$;

-- ----------------------------------------------------------------------------
-- SECTION H — CRON v3: IST-morning schedules, win-back job, Vault secret alias
-- ----------------------------------------------------------------------------
do $$
declare v_http_cmd text;
begin
  if to_regnamespace('cron') is null or to_regnamespace('net') is null then
    raise warning 'pg_cron/pg_net not present — cron v3 not scheduled.';
    return;
  end if;

  -- Secret resolved AT EXECUTION TIME from Vault; WEBHOOK_SECRET accepted as an
  -- alias so either naming convention works. Both header spellings are sent.
  v_http_cmd := $CMD$
    do $job$
    declare
      v_url text := public.email_cfg('edge_function_url');
      v_sec text := coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'EMAIL_INTERNAL_SECRET' limit 1),
        (select decrypted_secret from vault.decrypted_secrets where name = 'WEBHOOK_SECRET' limit 1),
        'MISSING_VAULT_SECRET');
    begin
      if coalesce(v_url,'') = '' then
        raise notice 'edge_function_url not configured — skipping HTTP call';
        return;
      end if;
      perform net.http_post(
        url     := v_url,
        headers := jsonb_build_object(
                     'Content-Type',      'application/json',
                     'X-Internal-Secret', v_sec,
                     'X-Webhook-Secret',  v_sec),
        body    := jsonb_build_object('action', '%ACTION%'),
        timeout_milliseconds := 120000);
    end $job$;
  $CMD$;

  perform cron.schedule_in_database('gorentals-email-queue-drain', '*/5 * * * *',
    replace(v_http_cmd, '%ACTION%', 'DRAIN_QUEUE'), current_database());
  -- 03:30/03:35 UTC = 09:00/09:05 IST (GoRentals market mornings)
  perform cron.schedule_in_database('gorentals-email-booking-reminder', '30 3 * * *',
    replace(v_http_cmd, '%ACTION%', 'SCAN_REMINDERS'), current_database());
  perform cron.schedule_in_database('gorentals-email-review-request', '35 3 * * *',
    replace(v_http_cmd, '%ACTION%', 'SCAN_REVIEWS'), current_database());
  -- Monday 04:00 UTC = 09:30 IST: win-back tiers (pure SQL, no secret needed)
  perform cron.schedule_in_database('gorentals-email-winback', '0 4 * * 1',
    'select public.scan_winbacks(30); select public.scan_winbacks(60); select public.scan_winbacks(90);',
    current_database());
  -- unchanged pure-SQL jobs (re-declared for completeness/idempotence)
  perform cron.schedule_in_database('gorentals-email-requeue-stale', '*/10 * * * *',
    'select public.outbox_recover_stale();', current_database());
  perform cron.schedule_in_database('gorentals-email-process-events', '*/2 * * * *',
    'select public.process_provider_events(500);', current_database());
  perform cron.schedule_in_database('gorentals-email-cleanup', '0 3 * * *',
    'select public.email_cleanup();', current_database());

  raise notice 'cron v3: drain */5, stale */10, events */2, cleanup 03:00 UTC, reminder 09:00 IST, review 09:05 IST, winback Mon 09:30 IST.';
end $$;

-- ----------------------------------------------------------------------------
-- SECTION I — grants for new RPCs
-- ----------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('scan_winbacks','email_daily_send_count','email_derive_logical_id')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname='anon') then
      execute format('revoke all on function %s from anon', f.sig); end if;
    if exists (select 1 from pg_roles where rolname='authenticated') then
      execute format('revoke all on function %s from authenticated', f.sig); end if;
    if exists (select 1 from pg_roles where rolname='service_role') then
      execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
  raise notice '002 grants applied.';
end $$;

do $$
begin
  raise notice '002 COMPLETE: INR/IST defaults, welcome + win-back producers, owner-on-bookings + city mapping, cron v3.';
end $$;
