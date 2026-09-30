-- ============================================================================
-- GoRentls Email System — 003_gorentls_full_catalog.sql
-- ============================================================================
-- Completes the GoRentls end-to-end catalog on top of the hardened v2 core
-- (000 + 001 + 002 required):
--
--   * BRAND CORRECTION: GoRentals/gorentals.com → GoRentls/gorentls.com in
--     config + registry subject lines; cron jobs renamed gorentls-email-*.
--     (Renderer-side brand strings come from edge-fn env: BRAND_NAME,
--      BRAND_DOMAIN, APP_URL, SUPPORT_EMAIL, UNSUBSCRIBE_EMAIL.)
--   * NEW TEMPLATES (registry rows; renderers in lib/templates.ts, Zod mirrors
--     in lib/schemas.ts, previews in emails/):
--       otp · kyc_submitted · kyc_approved · kyc_rejected · kyc_doc_expiring
--       refund_initiated · refund_failed · deposit_released
--       payment_receipt · payment_failed
--   * OTP FAST LANE: priority-1 rows get an async DRAIN_QUEUE kick via pg_net
--     on insert (seconds, not the */5 cron worst case). Best-effort: the cron
--     drain remains the backstop; concurrent kicks are safe (drain lease +
--     SKIP LOCKED claims — proven by tests/chaos/parallel_drains).
--   * OTP SUPERSEDE: a newer QUEUED otp cancels older QUEUED/RETRY_WAIT otp
--     rows for the same recipient (one live code per user; audited).
--   * REFUND LIFECYCLE v3: pending/initiated → refund_initiated;
--     failed/rejected → refund_failed; final states → refund_issued (unchanged).
--     Optional reason/payment_method columns auto-mapped when present.
--   * KYC PRODUCER: auto-detects a KYC table (kyc_verifications, …) and
--     attaches a fail-loud status-transition trigger. No table → no-op with a
--     NOTICE (templates remain usable via the ENQUEUE action / DB webhook).
--     kyc_doc_expiring has NO scan producer yet (needs an expiry-date column —
--     enqueue app-side until the document schema is known).
--
-- IDEMPOTENT. Business tables are never modified. Re-run after creating a KYC
-- table to attach its producer.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- SECTION A — brand + fastlane configuration
-- ----------------------------------------------------------------------------
insert into public.email_config (key, value) values
  ('brand_name',         'GoRentls'),
  ('brand_domain',       'gorentls.com'),
  ('app_url',            'https://www.gorentls.com'),
  ('support_email',      'support@gorentls.com'),
  ('unsubscribe_email',  'unsubscribe@gorentls.com'),
  ('fastlane_enabled',   'true')            -- 'false' = priority-1 kick off (cron-only)
on conflict (key) do nothing;                -- operator-customized values are never clobbered

-- ----------------------------------------------------------------------------
-- SECTION B — brand fix in existing registry rows (guarded, idempotent)
-- ----------------------------------------------------------------------------
update public.email_templates
set subject_template = replace(replace(subject_template, 'GoRentals', 'GoRentls'), 'gorentals.com', 'gorentls.com'),
    description      = replace(description, 'GoRentals', 'GoRentls')
where subject_template like '%GoRentals%' or subject_template like '%gorentals.com%'
   or description like '%GoRentals%';

-- ----------------------------------------------------------------------------
-- SECTION C — new template registry rows
-- payload_schema types supported by email_validate_payload:
-- uuid | string | number | timestamptz | object | array (+ enum)
-- ----------------------------------------------------------------------------
insert into public.email_templates
  (key, version, enabled, category, critical, logical_id_pattern, payload_schema, subject_template, description)
values
  ('otp', 1, true, 'transactional', true,
   'OTP:{recipient}:{dedupe_key}',
   '{"required":["dedupe_key","otp_code"],"properties":{"user_id":{"type":"uuid"},"dedupe_key":{"type":"string"},"otp_code":{"type":"string"},"expiry_minutes":{"type":"number"},"action_type":{"type":"string"}}}',
   'Your GoRentls verification code', 'Login/2FA OTP — priority 1, fast-lane drained, superseded on re-request'),
  ('kyc_submitted', 1, true, 'transactional', true,
   'KYC_SUBMITTED:{dedupe_key}',
   '{"required":["dedupe_key"],"properties":{"dedupe_key":{"type":"string"},"user_id":{"type":"uuid"},"name":{"type":"string"},"document_type":{"type":"string"},"cta_url":{"type":"string"}}}',
   'Verification received — we''re reviewing your documents', 'KYC documents received (dedupe_key = verification attempt id)'),
  ('kyc_approved', 1, true, 'transactional', true,
   'KYC_APPROVED:{dedupe_key}',
   '{"required":["dedupe_key"],"properties":{"dedupe_key":{"type":"string"},"user_id":{"type":"uuid"},"name":{"type":"string"},"document_type":{"type":"string"},"cta_url":{"type":"string"}}}',
   'You''re verified — welcome aboard', 'KYC approved'),
  ('kyc_rejected', 1, true, 'transactional', true,
   'KYC_REJECTED:{dedupe_key}',
   '{"required":["dedupe_key","reason"],"properties":{"dedupe_key":{"type":"string"},"reason":{"type":"string"},"user_id":{"type":"uuid"},"name":{"type":"string"},"document_type":{"type":"string"},"cta_url":{"type":"string"}}}',
   'Action needed — your verification was not approved', 'KYC rejected (reason required; trigger supplies a default when the column is empty)'),
  ('kyc_doc_expiring', 1, true, 'transactional', false,
   'KYC_DOC_EXPIRING:{dedupe_key}:{campaign}',
   '{"required":["dedupe_key","campaign"],"properties":{"dedupe_key":{"type":"string"},"campaign":{"type":"string"},"document_type":{"type":"string"},"expiry_date":{"type":"timestamptz"},"name":{"type":"string"},"cta_url":{"type":"string"}}}',
   'Your document expires soon — update it to keep renting', 'DL/RC/insurance expiry nudges (app-side ENQUEUE; no scan producer yet)'),
  ('refund_initiated', 1, true, 'transactional', true,
   'REFUND_INITIATED:{refund_id}',
   '{"required":["refund_id","amount"],"properties":{"refund_id":{"type":"uuid"},"booking_id":{"type":"uuid"},"amount":{"type":"number"},"currency":{"type":"string"},"renter_name":{"type":"string"},"listing_title":{"type":"string"},"payment_method":{"type":"string"},"eta_days":{"type":"string"}}}',
   'Refund initiated — your money is being processed', 'Refund request accepted / processing'),
  ('refund_failed', 1, true, 'transactional', true,
   'REFUND_FAILED:{refund_id}',
   '{"required":["refund_id"],"properties":{"refund_id":{"type":"uuid"},"booking_id":{"type":"uuid"},"amount":{"type":"number"},"currency":{"type":"string"},"reason":{"type":"string"},"renter_name":{"type":"string"},"listing_title":{"type":"string"}}}',
   'Action needed — we couldn''t send your refund', 'Provider rejected the refund transfer; support CTA'),
  ('deposit_released', 1, true, 'transactional', true,
   'DEPOSIT_RELEASED:{booking_id}',
   '{"required":["booking_id","amount"],"properties":{"booking_id":{"type":"uuid"},"amount":{"type":"number"},"currency":{"type":"string"},"renter_name":{"type":"string"},"listing_title":{"type":"string"},"deductions":{"type":"string"},"eta_days":{"type":"string"}}}',
   'Security deposit released', 'Post-return inspection passed; deposit on the way back (deductions itemized when present)'),
  ('payment_receipt', 1, true, 'transactional', true,
   'PAYMENT_RECEIPT:{dedupe_key}',
   '{"required":["dedupe_key","amount"],"properties":{"dedupe_key":{"type":"string"},"amount":{"type":"number"},"currency":{"type":"string"},"booking_id":{"type":"uuid"},"invoice_id":{"type":"string"},"invoice_url":{"type":"string"},"payment_method":{"type":"string"},"date":{"type":"timestamptz"},"renter_name":{"type":"string"},"listing_title":{"type":"string"}}}',
   'Payment received — receipt inside', 'Payment success receipt; invoice_url = app-minted signed PDF link'),
  ('payment_failed', 1, true, 'transactional', true,
   'PAYMENT_FAILED:{dedupe_key}',
   '{"required":["dedupe_key"],"properties":{"dedupe_key":{"type":"string"},"amount":{"type":"number"},"currency":{"type":"string"},"reason":{"type":"string"},"booking_id":{"type":"uuid"},"retry_url":{"type":"string"},"renter_name":{"type":"string"},"listing_title":{"type":"string"}}}',
   'Payment failed — action needed to keep your booking', 'Charge declined; retry CTA')
on conflict (key, version) do update
  set enabled = excluded.enabled, category = excluded.category, critical = excluded.critical,
      logical_id_pattern = excluded.logical_id_pattern, payload_schema = excluded.payload_schema,
      subject_template = excluded.subject_template, description = excluded.description;

-- ----------------------------------------------------------------------------
-- SECTION D — OUTBOX AFTER-INSERT: OTP supersede + priority-1 fastlane kick
-- ----------------------------------------------------------------------------
create or replace function public.email_outbox_after_insert_v3()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_url text; v_sec text; r record; n integer := 0;
begin
  -- 1) OTP SUPERSEDE: only one live code per recipient. Cancel older
  --    QUEUED/RETRY_WAIT otp rows (audited transition). In-flight rows
  --    (CLAIMED/SENDING) are left alone — the provider call already happened.
  --    Hygiene step: failures degrade to a warning (the new OTP must send).
  if new.template_key = 'otp' then
    begin
      for r in
        select id from public.email_outbox
        where template_key = 'otp' and recipient = new.recipient
          and state in ('QUEUED','RETRY_WAIT') and id <> new.id
        for update skip locked
      loop
        perform public.email_outbox_transition(r.id, 'CANCELLED', 'system:otp-supersede',
          'superseded by newer OTP ' || new.id::text);
        n := n + 1;
      end loop;
      if n > 0 then
        raise notice 'otp fastlane: cancelled % superseded code(s) for recipient', n;
      end if;
    exception when others then
      raise warning 'otp supersede skipped (non-fatal): %', sqlerrm;
    end;
  end if;

  -- 2) FASTLANE KICK: priority-1 (critical) rows trigger an async DRAIN_QUEUE
  --    immediately instead of waiting for the */5 cron. Fire-and-forget:
  --    every failure path degrades to a warning — the cron drain is the
  --    backstop and the row is already durable. Secret read from Vault at
  --    execution time (never stored on the trigger/cron definition).
  if new.priority <= 1
     and coalesce(public.email_cfg('fastlane_enabled'), 'true') <> 'false'
     and to_regnamespace('net') is not null then
    v_url := public.email_cfg('edge_function_url');
    if coalesce(v_url, '') <> '' then
      begin
        if to_regclass('vault.decrypted_secrets') is not null then
          select coalesce(
                   (select decrypted_secret from vault.decrypted_secrets where name = 'EMAIL_INTERNAL_SECRET' limit 1),
                   (select decrypted_secret from vault.decrypted_secrets where name = 'WEBHOOK_SECRET' limit 1),
                   'MISSING_VAULT_SECRET') into v_sec;
        else
          v_sec := 'MISSING_VAULT_SECRET';
        end if;
        perform net.http_post(
          url     := v_url,
          headers := jsonb_build_object(
                       'Content-Type',      'application/json',
                       'X-Internal-Secret', v_sec,
                       'X-Webhook-Secret',  v_sec),
          body    := jsonb_build_object('action', 'DRAIN_QUEUE'),
          timeout_milliseconds := 60000);
      exception when others then
        raise warning 'fastlane kick failed (cron backstop remains): %', sqlerrm;
      end;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists trg_outbox_after_insert_v3 on public.email_outbox;
create trigger trg_outbox_after_insert_v3
  after insert on public.email_outbox
  for each row when (new.state = 'QUEUED')
  execute function public.email_outbox_after_insert_v3();

-- ----------------------------------------------------------------------------
-- SECTION E — REFUND LIFECYCLE v3 (initiated / failed / issued)
-- Replaces email_trg_refunds_v2 IN PLACE (same name → existing trigger
-- binding keeps working). Final-state behaviour is byte-identical to 002:
-- T3/T4 in the v2 suite still hold ('pending' no longer emails *issued* —
-- it now emails *initiated*, a different logical id).
-- ----------------------------------------------------------------------------
-- optional column mapping: reason + payment method (empty when absent)
do $$
declare
  v_cand text; v_found_reason text := ''; v_found_method text := '';
begin
  if to_regclass('public.refunds') is null then
    raise notice 'refunds missing — refund column mapping skipped';
    return;
  end if;
  foreach v_cand in array array['reason','failure_reason','reject_reason','rejection_reason','failure_message','notes','remarks'] loop
    if exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='refunds' and column_name=v_cand
                 and data_type in ('text','character varying')) then
      v_found_reason := v_cand; exit;
    end if;
  end loop;
  foreach v_cand in array array['payment_method','refund_method','method','payment_provider'] loop
    if exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='refunds' and column_name=v_cand
                 and data_type in ('text','character varying')) then
      v_found_method := v_cand; exit;
    end if;
  end loop;
  insert into public.email_config (key, value) values
    ('ctx_refund_reason_col', v_found_reason),
    ('ctx_refund_method_col', v_found_method)
  on conflict (key) do update set value = excluded.value, updated_at = now();
  raise notice 'refund mapping v3: reason=% method=%',
    coalesce(nullif(v_found_reason,''),'(none)'), coalesce(nullif(v_found_method,''),'(none)');
end $$;

create or replace function public.email_trg_refunds_v2()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_id_col     text := coalesce(nullif(public.email_cfg('ctx_refund_id_col'),''), 'id');
  v_bkg_col    text := coalesce(nullif(public.email_cfg('ctx_refund_booking_col'),''), 'booking_id');
  v_amt_col    text := coalesce(nullif(public.email_cfg('ctx_refund_amount_col'),''), 'amount');
  v_stat_col   text := coalesce(nullif(public.email_cfg('ctx_refund_status_col'),''), 'status');
  v_reason_col text := nullif(public.email_cfg('ctx_refund_reason_col'),'');
  v_method_col text := nullif(public.email_cfg('ctx_refund_method_col'),'');
  v_new_rec  jsonb := to_jsonb(new);
  v_old_rec  jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_new_st   text := lower(coalesce(v_new_rec ->> v_stat_col, ''));
  v_old_st   text := case when v_old_rec is not null then lower(coalesce(v_old_rec ->> v_stat_col, '')) else null end;
  v_final     text[] := array['processed','completed','approved','succeeded','issued','refunded'];
  v_initiated text[] := array['initiated','pending','processing','requested','in_progress'];
  v_failed    text[] := array['failed','rejected','error'];
  v_ctx      public.email_bookings_ctx%rowtype;
  v_refund_id uuid;
  v_payload  jsonb;
  v_tpl      text;
begin
  if coalesce(public.email_cfg('enqueue_source'),'trigger') <> 'trigger' then
    return new;
  end if;

  -- classify the transition (final wins; no re-fire within the same class)
  if v_new_st = any (v_final) then
    if v_old_st is not null and v_old_st = any (v_final) then return new; end if;
    v_tpl := 'refund_issued';
  elsif v_new_st = any (v_failed) then
    if v_old_st is not null and v_old_st = any (v_failed) then return new; end if;
    v_tpl := 'refund_failed';
  elsif v_new_st = any (v_initiated) then
    if v_old_st is not null and (v_old_st = any (v_initiated) or v_old_st = any (v_final)) then return new; end if;
    v_tpl := 'refund_initiated';
  else
    return new;
  end if;

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

  v_payload := jsonb_build_object(
    'refund_id',      v_refund_id,
    'booking_id',     v_ctx.booking_id,
    'renter_name',    v_ctx.renter_name,
    'amount',         coalesce((nullif(v_new_rec ->> v_amt_col, ''))::numeric, 0),
    'currency',       v_ctx.currency,
    'city',           v_ctx.city,
    'listing_title',  v_ctx.listing_title);
  if v_reason_col is not null then
    v_payload := v_payload || jsonb_build_object('reason', nullif(btrim(coalesce(v_new_rec ->> v_reason_col, '')), ''));
  end if;
  if v_method_col is not null then
    v_payload := v_payload || jsonb_build_object('payment_method', nullif(btrim(coalesce(v_new_rec ->> v_method_col, '')), ''));
  end if;

  if v_tpl = 'refund_issued' then
    perform public.enqueue_email_v2('refund_issued', v_ctx.renter_email, v_payload,
      null, 'REFUND_ISSUED:' || upper(v_refund_id::text));
  elsif v_tpl = 'refund_failed' then
    perform public.enqueue_email_v2('refund_failed', v_ctx.renter_email, v_payload);
  else
    perform public.enqueue_email_v2('refund_initiated', v_ctx.renter_email, v_payload);
  end if;
  return new;
  -- NO exception handler: outbox failures roll back the business write (fail-loud).
end $$;

-- ----------------------------------------------------------------------------
-- SECTION F — KYC PRODUCER (optional table; re-run 003 after creating it)
-- ----------------------------------------------------------------------------
create or replace function public.email_trg_kyc_v1()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_pk_col      text := coalesce(nullif(public.email_cfg('ctx_kyc_pk_col'),''), 'id');
  v_user_col    text := coalesce(nullif(public.email_cfg('ctx_kyc_user_col'),''), 'user_id');
  v_status_col  text := coalesce(nullif(public.email_cfg('ctx_kyc_status_col'),''), 'status');
  v_reason_col  text := nullif(public.email_cfg('ctx_kyc_reason_col'),'');
  v_doctype_col text := nullif(public.email_cfg('ctx_kyc_doctype_col'),'');
  v_pemail_col  text := coalesce(nullif(public.email_cfg('ctx_profile_email_col'),''), 'email');
  v_pname_col   text := coalesce(nullif(public.email_cfg('ctx_profile_name_col'),''), 'full_name');
  v_new_rec  jsonb := to_jsonb(new);
  v_old_rec  jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_new_st   text := lower(btrim(coalesce(v_new_rec ->> v_status_col, '')));
  v_old_st   text := case when v_old_rec is not null then lower(btrim(coalesce(v_old_rec ->> v_status_col, ''))) else null end;
  v_submitted text[] := array['submitted','pending','in_review','under_review','awaiting_review','received','uploaded'];
  v_approved  text[] := array['approved','verified','passed','completed','accepted','success','successful'];
  v_rejected  text[] := array['rejected','declined','failed','denied','needs_action','action_required'];
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_tpl      text;
  v_pk       uuid;
  v_user_raw text;
  v_email    text;
  v_name     text := 'there';
  v_payload  jsonb;
begin
  if coalesce(public.email_cfg('enqueue_source'),'trigger') <> 'trigger' then
    return new;
  end if;
  if tg_op = 'UPDATE' and v_new_st = v_old_st then
    return new;   -- status-neutral writes never email
  end if;

  -- classify (approved/rejected take precedence; submitted re-entry after a
  -- rejection re-notifies via dedupe only when the row is a NEW attempt —
  -- same-row resubmits collapse on the logical id, matching booking semantics)
  if v_new_st = any (v_approved) and (v_old_st is null or v_old_st <> any (v_approved)) then
    v_tpl := 'kyc_approved';
  elsif v_new_st = any (v_rejected) and (v_old_st is null or v_old_st <> any (v_rejected)) then
    v_tpl := 'kyc_rejected';
  elsif v_new_st = any (v_submitted)
        and (v_old_st is null or (v_old_st <> any (v_submitted) and v_old_st <> any (v_approved))) then
    v_tpl := 'kyc_submitted';
  else
    return new;
  end if;

  v_pk := (nullif(v_new_rec ->> v_pk_col, ''))::uuid;      -- fail-loud on garbage
  v_user_raw := btrim(coalesce(v_new_rec ->> v_user_col, ''));

  -- resolve recipient + display name (profiles → auth.users fallback)
  v_email := null;
  if v_user_raw ~ uuid_re then
    if to_regclass('public.profiles') is not null then
      execute format('select nullif(lower(btrim(coalesce(%I, ''''))), ''''), coalesce(nullif(btrim(%I), ''''), ''there'')
                      from public.profiles where id = $1', v_pemail_col, v_pname_col)
        into v_email, v_name using v_user_raw::uuid;
    end if;
    if v_email is null and to_regclass('auth.users') is not null then
      select nullif(lower(btrim(email)),'') into v_email from auth.users where id = v_user_raw::uuid;
    end if;
  elsif v_user_raw <> '' then
    -- text-keyed user reference: match profiles.id::text
    if to_regclass('public.profiles') is not null then
      execute format('select nullif(lower(btrim(coalesce(%I, ''''))), ''''), coalesce(nullif(btrim(%I), ''''), ''there'')
                      from public.profiles where id::text = $1', v_pemail_col, v_pname_col)
        into v_email, v_name using v_user_raw;
    end if;
  end if;

  if v_email is null then
    raise notice 'email outbox: kyc % user % has no resolvable email — % skipped', v_pk, left(v_user_raw, 8), v_tpl;
    return new;   -- legitimate no-op (same policy as bookings/refunds)
  end if;

  v_payload := jsonb_build_object(
    'dedupe_key', v_pk::text,
    'name',       v_name,
    'renter_name', v_name);
  if v_user_raw ~ uuid_re then
    v_payload := v_payload || jsonb_build_object('user_id', v_user_raw::uuid);
  end if;
  if v_doctype_col is not null then
    v_payload := v_payload || jsonb_build_object('document_type', nullif(btrim(coalesce(v_new_rec ->> v_doctype_col, '')), ''));
  end if;
  if v_tpl = 'kyc_rejected' then
    -- reason is REQUIRED by schema; empty column → actionable default copy
    v_payload := v_payload || jsonb_build_object('reason',
      coalesce(nullif(btrim(case when v_reason_col is not null then coalesce(v_new_rec ->> v_reason_col, '') else '' end), ''),
               'Your documents could not be verified. Please re-upload clear, valid documents.'));
  end if;

  perform public.enqueue_email_v2(v_tpl, v_email, v_payload);
  return new;
  -- NO exception handler: fail-loud (a broken template registry must not
  -- silently swallow verification emails).
end $$;

-- column-mapping helper (same contract as 002 §D; recreated + dropped here)
create or replace function public._email_pick_col_v3(
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
    raise warning 'KYC MAPPING: public.%.% exists but type "%" incompatible (expected %)',
      p_table, v_bad, v_badtype, array_to_string(p_types, ', ');
  end if;
  return;
end $$;

do $$
declare
  v_table text; v_cand text;
  v_pk text; v_user text; v_user_t text; v_status text; v_reason text; v_doctype text;
begin
  foreach v_cand in array array['kyc_verifications','kyc_requests','kyc_applications',
                                'identity_verifications','user_verifications','verifications','kyc_documents'] loop
    if to_regclass('public.' || v_cand) is not null then v_table := v_cand; exit; end if;
  end loop;

  if v_table is null then
    insert into public.email_config (key, value) values ('kyc_table', '')
    on conflict (key) do update set value = '', updated_at = now();
    raise notice 'KYC: no verification table detected — kyc_* templates stay available via ENQUEUE (app-side). Re-run migration 003 after creating the table to attach the trigger producer.';
    return;
  end if;

  select col into v_pk from public._email_pick_col_v3(v_table,
    array['id','verification_id','kyc_id','application_id'], array['uuid']);
  select col, dtype into v_user, v_user_t from public._email_pick_col_v3(v_table,
    array['user_id','profile_id','applicant_id','renter_id','owner_id'], array['uuid','text','character varying']);
  select col into v_status from public._email_pick_col_v3(v_table,
    array['status','state','verification_status','kyc_status','review_status'], array['text','character varying','USER-DEFINED']);
  select col into v_reason from public._email_pick_col_v3(v_table,
    array['reject_reason','rejection_reason','reason','failure_reason','review_notes','notes','remarks'], array['text','character varying']);
  select col into v_doctype from public._email_pick_col_v3(v_table,
    array['document_type','doc_type','verification_type','type'], array['text','character varying']);

  if v_pk is null or v_user is null or v_status is null then
    raise warning 'KYC: table % found but required columns missing/incompatible (pk=% user=% status=%) — trigger NOT attached; use app-side ENQUEUE.',
      v_table, coalesce(v_pk,'?'), coalesce(v_user,'?'), coalesce(v_status,'?');
    return;
  end if;

  insert into public.email_config (key, value) values
    ('kyc_table',          v_table),
    ('ctx_kyc_pk_col',     v_pk),
    ('ctx_kyc_user_col',   v_user),
    ('ctx_kyc_status_col', v_status),
    ('ctx_kyc_reason_col', coalesce(v_reason,'')),
    ('ctx_kyc_doctype_col',coalesce(v_doctype,''))
  on conflict (key) do update set value = excluded.value, updated_at = now();

  execute format('drop trigger if exists trg_kyc_email_v1 on public.%I', v_table);
  execute format('create trigger trg_kyc_email_v1 after insert or update on public.%I for each row execute function public.email_trg_kyc_v1()', v_table);
  raise notice 'KYC producer attached: public.% (pk=% user=%(%) status=% reason=% doctype=%)',
    v_table, v_pk, v_user, v_user_t, v_status, coalesce(v_reason,'-'), coalesce(v_doctype,'-');
end $$;

drop function if exists public._email_pick_col_v3(text, text[], text[]);

-- ----------------------------------------------------------------------------
-- SECTION G — cron rename gorentals-email-* → gorentls-email-* (same schedules)
-- ----------------------------------------------------------------------------
do $$
declare r record; v_http_cmd text; v_have_unsched boolean;
begin
  if to_regnamespace('cron') is null or to_regnamespace('net') is null then
    raise warning 'pg_cron/pg_net not present — cron rename skipped.';
    return;
  end if;
  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'unschedule') into v_have_unsched;
  if not v_have_unsched then
    raise warning 'cron.unschedule unavailable — keeping legacy gorentals-email-* job names.';
    return;
  end if;

  for r in select jobname from cron.job where jobname like 'gorentals-email-%' loop
    perform cron.unschedule(r.jobname);
  end loop;

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

  perform cron.schedule_in_database('gorentls-email-queue-drain', '*/5 * * * *',
    replace(v_http_cmd, '%ACTION%', 'DRAIN_QUEUE'), current_database());
  -- 03:30/03:35 UTC = 09:00/09:05 IST
  perform cron.schedule_in_database('gorentls-email-booking-reminder', '30 3 * * *',
    replace(v_http_cmd, '%ACTION%', 'SCAN_REMINDERS'), current_database());
  perform cron.schedule_in_database('gorentls-email-review-request', '35 3 * * *',
    replace(v_http_cmd, '%ACTION%', 'SCAN_REVIEWS'), current_database());
  -- Monday 04:00 UTC = 09:30 IST
  perform cron.schedule_in_database('gorentls-email-winback', '0 4 * * 1',
    'select public.scan_winbacks(30); select public.scan_winbacks(60); select public.scan_winbacks(90);',
    current_database());
  perform cron.schedule_in_database('gorentls-email-requeue-stale', '*/10 * * * *',
    'select public.outbox_recover_stale();', current_database());
  perform cron.schedule_in_database('gorentls-email-process-events', '*/2 * * * *',
    'select public.process_provider_events(500);', current_database());
  perform cron.schedule_in_database('gorentls-email-cleanup', '0 3 * * *',
    'select public.email_cleanup();', current_database());

  raise notice 'cron renamed to gorentls-email-* (schedules unchanged). Fastlane kick covers priority-1 latency between drains.';
end $$;

-- ----------------------------------------------------------------------------
-- SECTION H — grants for new/changed functions (same posture as 002 §I)
-- ----------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('email_outbox_after_insert_v3','email_trg_kyc_v1','email_trg_refunds_v2')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname='anon') then
      execute format('revoke all on function %s from anon', f.sig); end if;
    if exists (select 1 from pg_roles where rolname='authenticated') then
      execute format('revoke all on function %s from authenticated', f.sig); end if;
    -- trigger functions execute via the trigger (definer-owned); no explicit
    -- service_role grant needed, but keep parity with existing posture:
    if exists (select 1 from pg_roles where rolname='service_role')
       and f.sig::text not like '%email_outbox_after_insert_v3%' then
      execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
  raise notice '003 grants applied.';
end $$;

-- ----------------------------------------------------------------------------
-- SECTION I — capacity guidance (edit + run manually after upgrading Resend)
-- ----------------------------------------------------------------------------
-- Free tier (100/day) defaults are UNCHANGED (soft 85 / hard 100). After
-- upgrading, align caps with the plan, e.g. for 50k/month (~1600/day):
--   update public.email_config set value='1400', updated_at=now() where key='daily_soft_cap';
--   update public.email_config set value='1600', updated_at=now() where key='daily_hard_cap';
-- and set edge-fn env RATE_RPS/RATE_BURST per plan. NOTE: at the hard cap even
-- critical mail parks +15 min — OTPs included. Raise caps BEFORE launch traffic.

do $$
begin
  raise notice '003 COMPLETE: GoRentls brand config, 10 new templates (otp/kyc/refund-lifecycle/payments), OTP fastlane + supersede, refund trigger v3, KYC producer, cron rename.';
end $$;
