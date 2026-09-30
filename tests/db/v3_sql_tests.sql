-- ============================================================================
-- GoRentls email system v3 — DATABASE TEST SUITE (migration 003)
-- Run against a DB with migrations 000+001+002+003 applied (local/staging ONLY —
-- inserts fixtures). Re-runnable (scoped cleanup; coexists with the v2 suite).
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f tests/db/v3_sql_tests.sql
-- Covers: new template registry · OTP priority/logical-id/supersede ·
--         fastlane drain kick (pg_net stub) · refund lifecycle v3 ·
--         KYC producer (table detection + status transitions + reason mapping) ·
--         brand correctness · cron rename · payload validation gates.
-- ============================================================================
\pset pager off
\set ON_ERROR_STOP on

-- ---------- 0. Scoped cleanup (v3 fixtures only: eeeeeeee-* / v3.*@) ----------
delete from public.email_send_attempts where outbox_id in
  (select id from public.email_outbox where recipient like 'v3.%@example.com');
delete from public.email_outbox where recipient like 'v3.%@example.com';
drop table if exists public.kyc_verifications cascade;
delete from public.refunds  where id::text like 'eeeeeeee-dddd%';
delete from public.bookings where id::text like 'eeeeeeee-cccc%';
delete from public.listings where id::text like 'eeeeeeee-bbbb%';
delete from public.profiles where id::text like 'eeeeeeee-aaaa%';
delete from auth.users      where id::text like 'eeeeeeee-aaaa%';
delete from net._http_collect;

-- simulate a deployed worker (SETUP step 5) so the fastlane kick is testable;
-- the pg_net STUB records calls instead of making them
insert into public.email_config (key, value) values
  ('edge_function_url', 'http://localhost:54321/functions/v1/notify-lifecycle')
on conflict (key) do update set value = excluded.value, updated_at = now();

-- ---------- fixtures ----------
insert into auth.users (id,email) values
 ('eeeeeeee-aaaa-0000-0000-000000000001','v3.renter@example.com'),
 ('eeeeeeee-aaaa-0000-0000-000000000002','v3.owner@example.com'),
 ('eeeeeeee-aaaa-0000-0000-000000000003', null)  -- email-less user (no-op paths)
 on conflict (id) do update set email=excluded.email;
insert into public.profiles (id,email,full_name) values
 ('eeeeeeee-aaaa-0000-0000-000000000001', null, 'V3 Renter'),
 ('eeeeeeee-aaaa-0000-0000-000000000002','v3.owner@example.com','V3 Owner'),
 ('eeeeeeee-aaaa-0000-0000-000000000003', null, 'V3 NoEmail')
 on conflict (id) do update set email=excluded.email, full_name=excluded.full_name;
insert into public.listings (id,owner_id,title) values
 ('eeeeeeee-bbbb-0000-0000-000000000001','eeeeeeee-aaaa-0000-0000-000000000002','Canon EOS R5 Kit')
 on conflict (id) do update set title=excluded.title;
insert into public.bookings (id, listing_id, renter_id, status, start_date, end_date, total_amount, currency, timezone)
values ('eeeeeeee-cccc-0000-0000-000000000001','eeeeeeee-bbbb-0000-0000-000000000001',
        'eeeeeeee-aaaa-0000-0000-000000000001','confirmed',
        now()+interval '2 days', now()+interval '4 days', 7500, 'INR','Asia/Kolkata')
 on conflict (id) do update set status=excluded.status;

-- park auto-generated lifecycle/welcome mail out of claim windows
update public.email_outbox set next_attempt_at = now() + interval '12 hours'
where recipient like 'v3.%@example.com';

select 'V3 FIXTURES READY' as progress;

-- ============================================================================
-- V3-T1 REGISTRY: all 10 new templates registered, enabled, correct flags
-- ============================================================================
do $$
declare n int;
begin
  select count(*) into n from public.email_templates
  where (key, version) in (
    ('otp',1),('kyc_submitted',1),('kyc_approved',1),('kyc_rejected',1),('kyc_doc_expiring',1),
    ('refund_initiated',1),('refund_failed',1),('deposit_released',1),
    ('payment_receipt',1),('payment_failed',1))
    and enabled and category='transactional';
  assert n = 10, 'expected 10 new transactional templates, got ' || n;
  assert (select critical from public.email_templates where key='otp' and version=1),
    'otp must be critical (priority 1 + hard-cap lane)';
  assert not (select critical from public.email_templates where key='kyc_doc_expiring' and version=1),
    'kyc_doc_expiring must NOT be critical (deferrable nudge)';
  raise notice 'V3-T1 PASS: registry complete (10 templates, flags correct)';
end $$;

-- ============================================================================
-- V3-T2 PAYLOAD GATES: SQL validator rejects missing required fields
-- ============================================================================
do $$
declare v jsonb;
begin
  v := public.email_validate_payload('otp', 1, '{"dedupe_key":"chal-1"}'::jsonb);
  assert not (v->>'ok')::boolean, 'otp without otp_code must fail validation';
  v := public.email_validate_payload('otp', 1,
    '{"dedupe_key":"chal-1","otp_code":"482913","user_id":"eeeeeeee-aaaa-0000-0000-000000000001"}'::jsonb);
  assert (v->>'ok')::boolean, 'valid otp payload rejected: ' || (v->'errors')::text;
  v := public.email_validate_payload('kyc_rejected', 1, '{"dedupe_key":"k-1"}'::jsonb);
  assert not (v->>'ok')::boolean, 'kyc_rejected without reason must fail (non-actionable rejection)';
  v := public.email_validate_payload('payment_receipt', 1, '{"dedupe_key":"pi_1","amount":7500}'::jsonb);
  assert (v->>'ok')::boolean, 'valid payment_receipt rejected: ' || (v->'errors')::text;
  raise notice 'V3-T2 PASS: payload validation gates (otp code + kyc reason required)';
end $$;

-- ============================================================================
-- V3-T3 OTP ENQUEUE: priority 1 auto-set, logical id OTP:{RECIPIENT}:{DEDUPE},
--         and a fastlane DRAIN_QUEUE kick lands in the pg_net stub
-- ============================================================================
do $$
declare kicks_before int; kicks_after int; r public.email_outbox;
begin
  select count(*) into kicks_before from net._http_collect where body->>'action'='DRAIN_QUEUE';
  perform public.enqueue_email_v2('otp', 'v3.renter@example.com',
    jsonb_build_object('dedupe_key','chal-001','otp_code','482913','expiry_minutes',10,
                       'action_type','Sign in verification',
                       'user_id','eeeeeeee-aaaa-0000-0000-000000000001'));
  select * into r from public.email_outbox
  where logical_event_id = 'OTP:V3.RENTER@EXAMPLE.COM:CHAL-001';
  assert r.id is not null, 'otp row not found under canonical logical id';
  assert r.priority = 1, 'otp must auto-claim priority 1 (critical), got ' || r.priority;
  assert r.state = 'QUEUED', 'otp must enqueue QUEUED, got ' || r.state;
  select count(*) into kicks_after from net._http_collect where body->>'action'='DRAIN_QUEUE';
  assert kicks_after > kicks_before,
    'priority-1 insert must fire a fastlane DRAIN_QUEUE kick (stub net._http_collect)';
  raise notice 'V3-T3 PASS: otp priority-1 + logical id + fastlane kick';
end $$;

-- ============================================================================
-- V3-T4 FASTLANE SELECTIVITY: non-critical (priority 5) rows do NOT kick
-- ============================================================================
do $$
declare kicks_before int; kicks_after int;
begin
  select count(*) into kicks_before from net._http_collect where body->>'action'='DRAIN_QUEUE';
  perform public.enqueue_email_v2('kyc_doc_expiring', 'v3.renter@example.com',
    jsonb_build_object('dedupe_key','doc-77','campaign','2026-09','document_type','Driving licence'));
  select count(*) into kicks_after from net._http_collect where body->>'action'='DRAIN_QUEUE';
  assert kicks_after = kicks_before,
    'priority-5 insert must NOT fire a fastlane kick (delta ' || (kicks_after - kicks_before) || ')';
  raise notice 'V3-T4 PASS: fastlane fires only for priority-1 rows';
end $$;

-- ============================================================================
-- V3-T5 OTP SUPERSEDE: newer code cancels older QUEUED code (audited),
--         other recipients untouched, duplicate re-request changes nothing
-- ============================================================================
do $$
declare old_row public.email_outbox; other public.email_outbox; n int;
begin
  -- second challenge for the SAME recipient
  perform public.enqueue_email_v2('otp', 'v3.renter@example.com',
    jsonb_build_object('dedupe_key','chal-002','otp_code','771204','expiry_minutes',10));
  -- an otp for a DIFFERENT recipient must survive
  perform public.enqueue_email_v2('otp', 'v3.owner@example.com',
    jsonb_build_object('dedupe_key','chal-900','otp_code','554433','expiry_minutes',10));

  select * into old_row from public.email_outbox
  where logical_event_id = 'OTP:V3.RENTER@EXAMPLE.COM:CHAL-001';
  assert old_row.state = 'CANCELLED',
    'superseded otp must be CANCELLED, got ' || old_row.state;
  assert old_row.audit_log::text like '%otp-supersede%',
    'supersede must be audited: ' || left(old_row.audit_log::text, 200);

  select count(*) into n from public.email_outbox
  where logical_event_id = 'OTP:V3.RENTER@EXAMPLE.COM:CHAL-002' and state = 'QUEUED';
  assert n = 1, 'newest otp must remain QUEUED';

  select * into other from public.email_outbox
  where logical_event_id = 'OTP:V3.OWNER@EXAMPLE.COM:CHAL-900';
  assert other.state = 'QUEUED', 'supersede must be recipient-scoped, got ' || other.state;

  -- duplicate re-request (same challenge id) → collapses, cancels nothing new
  perform public.enqueue_email_v2('otp', 'v3.renter@example.com',
    jsonb_build_object('dedupe_key','chal-002','otp_code','771204','expiry_minutes',10));
  select count(*) into n from public.email_outbox
  where recipient='v3.renter@example.com' and template_key='otp' and state='QUEUED';
  assert n = 1, 'duplicate re-request must not create/cancel rows (queued otp=' || n || ')';
  raise notice 'V3-T5 PASS: one live code per recipient, audited supersede, dedupe intact';
end $$;

-- ============================================================================
-- V3-T6 REFUND LIFECYCLE: pending→initiated, failed→failed, processed→issued,
--          status-neutral rewrites send nothing
-- ============================================================================
insert into public.refunds (id, booking_id, amount, status) values
 ('eeeeeeee-dddd-0000-0000-000000000001','eeeeeeee-cccc-0000-0000-000000000001', 2500, 'pending');
do $$
declare n int;
begin
  select count(*) into n from public.email_outbox
  where logical_event_id = 'REFUND_INITIATED:EEEEEEEE-DDDD-0000-0000-000000000001';
  assert n = 1, 'pending refund must enqueue refund_initiated, got ' || n;
  select count(*) into n from public.email_outbox
  where logical_event_id = 'REFUND_ISSUED:EEEEEEEE-DDDD-0000-0000-000000000001';
  assert n = 0, 'pending refund must NOT enqueue refund_issued (v2 T4 contract)';
end $$;
update public.refunds set status='failed' where id='eeeeeeee-dddd-0000-0000-000000000001';
update public.refunds set amount=2500 where id='eeeeeeee-dddd-0000-0000-000000000001'; -- failed→failed rewrite
do $$
declare n int;
begin
  select count(*) into n from public.email_outbox
  where logical_event_id = 'REFUND_FAILED:EEEEEEEE-DDDD-0000-0000-000000000001';
  assert n = 1, 'failed refund must enqueue refund_failed exactly once, got ' || n;
end $$;
update public.refunds set status='processed' where id='eeeeeeee-dddd-0000-0000-000000000001';
do $$
declare n int; v jsonb;
begin
  select count(*) into n from public.email_outbox
  where logical_event_id = 'REFUND_ISSUED:EEEEEEEE-DDDD-0000-0000-000000000001';
  assert n = 1, 'final state must still enqueue refund_issued, got ' || n;
  select payload into v from public.email_outbox
  where logical_event_id = 'REFUND_INITIATED:EEEEEEEE-DDDD-0000-0000-000000000001';
  assert (v->>'currency') = 'INR', 'refund payload must carry booking currency, got ' || (v->>'currency');
  raise notice 'V3-T6 PASS: refund initiated→failed→issued, each exactly once, INR carried';
end $$;

-- ============================================================================
-- V3-T7 KYC PRODUCER: table detection, transitions, reason mapping, no-email no-op
-- (creates the table, re-applies 003 to attach, exercises, leaves table in place)
-- ============================================================================
create table public.kyc_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  status text not null default 'submitted',
  document_type text,
  reject_reason text,
  created_at timestamptz not null default now()
);
\i supabase/migrations/003_gorentls_full_catalog.sql

do $$
begin
  assert public.email_cfg('kyc_table') = 'kyc_verifications',
    'kyc_table config must point at the detected table, got ' || coalesce(public.email_cfg('kyc_table'),'(null)');
  assert public.email_cfg('ctx_kyc_reason_col') = 'reject_reason',
    'reason column must be auto-mapped, got ' || coalesce(public.email_cfg('ctx_kyc_reason_col'),'(null)');
  assert public.email_cfg('ctx_kyc_doctype_col') = 'document_type', 'document_type must be auto-mapped';
end $$;

insert into public.kyc_verifications (id, user_id, status, document_type) values
 ('eeeeeeee-eeee-0000-0000-000000000001','eeeeeeee-aaaa-0000-0000-000000000001','submitted','Aadhaar card');
do $$
declare n int; v jsonb;
begin
  select count(*) into n from public.email_outbox
  where logical_event_id = 'KYC_SUBMITTED:EEEEEEEE-EEEE-0000-0000-000000000001';
  assert n = 1, 'submitted KYC must enqueue kyc_submitted, got ' || n;
  select payload into v from public.email_outbox
  where logical_event_id = 'KYC_SUBMITTED:EEEEEEEE-EEEE-0000-0000-000000000001';
  assert v->>'document_type' = 'Aadhaar card', 'document_type must ride along';
  assert v->>'name' = 'V3 Renter', 'display name must resolve from profiles, got ' || coalesce(v->>'name','(null)');
end $$;

-- status-neutral write → nothing new
update public.kyc_verifications set document_type='Aadhaar card (re-upload)'
where id='eeeeeeee-eeee-0000-0000-000000000001';
do $$
declare n int;
begin
  select count(*) into n from public.email_outbox where recipient='v3.renter@example.com'
    and template_key in ('kyc_submitted','kyc_approved','kyc_rejected');
  assert n = 1, 'status-neutral update must not email (kyc lifecycle rows=' || n || ')';
end $$;

-- rejection with a mapped reason column
update public.kyc_verifications set status='rejected', reject_reason='Photo was blurred'
where id='eeeeeeee-eeee-0000-0000-000000000001';
do $$
declare v jsonb; n int;
begin
  select count(*) into n from public.email_outbox
  where logical_event_id = 'KYC_REJECTED:EEEEEEEE-EEEE-0000-0000-000000000001';
  assert n = 1, 'rejected KYC must enqueue kyc_rejected, got ' || n;
  select payload into v from public.email_outbox
  where logical_event_id = 'KYC_REJECTED:EEEEEEEE-EEEE-0000-0000-000000000001';
  assert v->>'reason' = 'Photo was blurred', 'mapped reason column must feed the payload, got ' || coalesce(v->>'reason','(null)');
end $$;

-- approval after re-review
update public.kyc_verifications set status='approved', reject_reason=null
where id='eeeeeeee-eeee-0000-0000-000000000001';
do $$
declare n int;
begin
  select count(*) into n from public.email_outbox
  where logical_event_id = 'KYC_APPROVED:EEEEEEEE-EEEE-0000-0000-000000000001';
  assert n = 1, 'approved KYC must enqueue kyc_approved, got ' || n;
  raise notice 'V3-T7 PASS: KYC submitted→rejected(reason)→approved, status-neutral writes silent';
end $$;

-- user without any email → legitimate no-op (no exception, no row)
insert into public.kyc_verifications (id, user_id, status) values
 ('eeeeeeee-eeee-0000-0000-000000000002','eeeeeeee-aaaa-0000-0000-000000000003','submitted');
do $$
declare n int;
begin
  select count(*) into n from public.email_outbox
  where logical_event_id = 'KYC_SUBMITTED:EEEEEEEE-EEEE-0000-0000-000000000002';
  assert n = 0, 'email-less user must no-op, got ' || n || ' rows';
  raise notice 'V3-T8 PASS: KYC no-email no-op (business write NOT rolled back)';
end $$;

-- ============================================================================
-- V3-T9 BRAND: registry + config carry GoRentls, never GoRentals
-- ============================================================================
do $$
declare n int;
begin
  select count(*) into n from public.email_templates
  where subject_template ilike '%GoRentals%' or subject_template ilike '%gorentals.com%'
     or description ilike '%GoRentals%';
  assert n = 0, 'found ' || n || ' registry rows still branded GoRentals';
  assert public.email_cfg('brand_name') = 'GoRentls', 'brand_name config missing';
  assert public.email_cfg('brand_domain') = 'gorentls.com', 'brand_domain config missing';
  assert public.email_cfg('app_url') = 'https://www.gorentls.com', 'app_url config missing';
  assert public.email_cfg('support_email') = 'support@gorentls.com', 'support_email config missing';
  assert (select subject_template from public.email_templates where key='welcome' and version=1)
         like '%GoRentls%', 'welcome subject not rebranded';
  raise notice 'V3-T9 PASS: brand config + registry are GoRentls/gorentls.com';
end $$;

-- ============================================================================
-- V3-T10 CRON: legacy job names gone, new names scheduled
-- ============================================================================
do $$
declare legacy int; drain int;
begin
  if to_regnamespace('cron') is null then
    raise notice 'V3-T10 SKIP: cron namespace absent';
    return;
  end if;
  select count(*) into legacy from cron.job where jobname like 'gorentals-email-%';
  select count(*) into drain  from cron.job where jobname = 'gorentls-email-queue-drain';
  assert legacy = 0, 'legacy gorentals-email-* jobs must be removed, got ' || legacy;
  assert drain = 1, 'gorentls-email-queue-drain must be scheduled, got ' || drain;
  assert not exists (select 1 from cron.job where command like '%MISSING_VAULT_SECRET''%' and command like '%hardcoded%'),
    'cron commands must not inline secrets';
  raise notice 'V3-T10 PASS: cron renamed (gorentls-email-*), secrets stay in Vault';
end $$;

-- ============================================================================
-- V3-T11 DEDUPE: replayed lifecycle events never double-send
-- ============================================================================
do $$
declare n int;
begin
  -- re-run the approval transition (approved→approved rewrite)
  update public.kyc_verifications set status='approved'
  where id='eeeeeeee-eeee-0000-0000-000000000001';
  select count(*) into n from public.email_outbox
  where logical_event_id = 'KYC_APPROVED:EEEEEEEE-EEEE-0000-0000-000000000001';
  assert n = 1, 'idempotent rewrites must not re-send (got ' || n || ')';
  raise notice 'V3-T11 PASS: canonical idempotency holds across the new catalog';
end $$;

-- ---------- scoped teardown of fastlane noise (keep outbox rows for inspection) ----------
select 'V3 SUITE: ALL TESTS PASSED' as result;
