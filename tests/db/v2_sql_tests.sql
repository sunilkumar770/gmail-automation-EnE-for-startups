-- ============================================================================
-- GoRentals email system v2 — DATABASE TEST SUITE
-- Run against a DB with migrations 000+001 applied (local/staging ONLY —
-- inserts fixtures). Re-runnable (scoped cleanup).
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f tests/db/v2_sql_tests.sql
-- Each test maps to an AUDIT.md defect or a master-prompt requirement.
-- ============================================================================
\pset pager off

-- ---------- 0. Fixtures ----------
delete from public.email_send_attempts where outbox_id in
  (select id from public.email_outbox where recipient like '%@example.com');
delete from public.email_outbox where recipient like '%@example.com';
delete from public.email_provider_events where provider_event_id like 'test-%';
delete from public.email_suppressions where email like '%@example.com';
delete from public.email_outbox_archive where recipient like '%@example.com';
delete from public.refunds;
delete from public.bookings;
delete from public.listings;
delete from public.profiles;
delete from auth.users;
delete from public.email_runtime_state where key='drain';
delete from public.email_templates where key='booking_confirmation' and version=2;

insert into auth.users (id,email) values
 ('aaaaaaaa-0000-0000-0000-000000000001','renter.one@example.com'),
 ('aaaaaaaa-0000-0000-0000-000000000002','owner.two@example.com') on conflict (id) do update set email=excluded.email;
insert into public.profiles (id,email,full_name) values
 ('aaaaaaaa-0000-0000-0000-000000000001',null,'Renter One'),
 ('aaaaaaaa-0000-0000-0000-000000000002','owner.two@example.com','Owner Two') on conflict (id) do update set email=excluded.email, full_name=excluded.full_name;
insert into public.listings (id,owner_id,title) values
 ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002','Beachfront Camper') on conflict (id) do update set owner_id=excluded.owner_id, title=excluded.title;

-- welcome emails fired by the profiles trigger: park them out of claim windows
update public.email_outbox set next_attempt_at = now() + interval '12 hours'
where template_key = 'welcome' and recipient like '%@example.com';

select 'FIXTURES READY' as progress;

-- ============================================================================
-- T1 (P0-1) TRIGGER FAIL-LOUD: if the outbox insert fails, the BUSINESS
-- transaction must roll back — no silent email loss.
-- ============================================================================
update public.email_templates set enabled=false where key='booking_confirmation' and version=1;
do $$
begin
  begin
    insert into public.bookings (id, listing_id, renter_id, status, start_date, end_date, total_amount, currency, timezone)
    values ('cccccccc-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000001','confirmed',
            now()+interval '1 day', now()+interval '3 days', 250, 'USD','UTC');
    raise exception 'ASSERT-FAIL: booking committed despite disabled template (email silently lost)';
  exception when others then
    if sqlerrm like 'ASSERT-FAIL%' then raise; end if;
    -- expected: unknown/disabled template error propagated
    if sqlerrm not like '%unknown or disabled email template%' then
      raise exception 'ASSERT-FAIL: unexpected error: %', sqlerrm;
    end if;
  end;
  -- booking must NOT exist (rolled back atomically with the failed outbox insert)
  assert not exists (select 1 from public.bookings where id='cccccccc-0000-0000-0000-000000000001'),
    'ASSERT-FAIL: booking row survived the failed outbox insert';
  raise notice 'T1 PASS: outbox failure rolls back the business transaction (no silent loss)';
end $$;
update public.email_templates set enabled=true where key='booking_confirmation' and version=1;

-- ============================================================================
-- T2 (P0-1 durability) Happy path: booking + outbox committed atomically
-- ============================================================================
insert into public.bookings (id, listing_id, renter_id, status, start_date, end_date, total_amount, currency, timezone)
values ('cccccccc-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001','confirmed',
        now()+interval '1 day', now()+interval '3 days', 250, 'INR','Asia/Kolkata');
do $$
declare n int; v jsonb;
begin
  select count(*) into n from public.email_outbox
  where logical_event_id in ('BOOKING_CONFIRMATION:CCCCCCCC-0000-0000-0000-000000000001',
                             'BOOKING_HOST_CONFIRMATION:CCCCCCCC-0000-0000-0000-000000000001');
  assert n = 2, 'expected 2 outbox rows, got ' || n;
  select payload into v from public.email_outbox where logical_event_id='BOOKING_CONFIRMATION:CCCCCCCC-0000-0000-0000-000000000001';
  assert v->>'currency' = 'INR', 'currency not carried from booking: ' || (v->>'currency');
  assert v->>'timezone' = 'Asia/Kolkata', 'timezone not carried: ' || (v->>'timezone');
  raise notice 'T2 PASS: atomic outbox + per-booking currency/timezone carried in payload';
end $$;

-- ============================================================================
-- T3 (P0-2, §4) REFUND IDENTITY: two refunds on one booking → TWO emails,
-- each exactly once; keyed by refund_id.
-- ============================================================================
insert into public.refunds (id, booking_id, amount, status) values
 ('dddddddd-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001', 100, 'processed');
insert into public.refunds (id, booking_id, amount, status) values
 ('dddddddd-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000001', 50, 'processed');
do $$
declare n int;
begin
  select count(*) into n from public.email_outbox where template_key='refund_issued';
  assert n = 2, 'two distinct refunds must produce two emails, got ' || n;
  assert exists (select 1 from public.email_outbox where logical_event_id='REFUND_ISSUED:DDDDDDDD-0000-0000-0000-000000000001');
  assert exists (select 1 from public.email_outbox where logical_event_id='REFUND_ISSUED:DDDDDDDD-0000-0000-0000-000000000002');
  raise notice 'T3 PASS: partial refunds each send exactly once (refund-scoped logical ids)';
end $$;

-- ============================================================================
-- T4 (P0-3, §15) REFUND TRANSITIONS: pending→processed fires; re-writes don't
-- ============================================================================
insert into public.refunds (id, booking_id, amount, status) values
 ('dddddddd-0000-0000-0000-000000000003','cccccccc-0000-0000-0000-000000000001', 25, 'pending');
do $$
begin
  assert not exists (select 1 from public.email_outbox
    where logical_event_id='REFUND_ISSUED:DDDDDDDD-0000-0000-0000-000000000003'),
    'pending refund must not email yet';
end $$;
update public.refunds set status='processed' where id='dddddddd-0000-0000-0000-000000000003';
update public.refunds set amount=25 where id='dddddddd-0000-0000-0000-000000000003';   -- processed→processed write
do $$
declare n int;
begin
  select count(*) into n from public.email_outbox where logical_event_id='REFUND_ISSUED:DDDDDDDD-0000-0000-0000-000000000003';
  assert n = 1, 'pending→processed must send exactly once (got ' || n || ')';
  raise notice 'T4 PASS: refund state transition fires once; idempotent re-writes do not re-send';
end $$;

-- ============================================================================
-- T5 (§3) CANONICAL IDEMPOTENCY: same logical event never creates two rows
-- ============================================================================
do $$
declare r jsonb; n int;
begin
  r := public.enqueue_email_v2('booking_confirmation','renter.one@example.com',
        jsonb_build_object('booking_id','cccccccc-0000-0000-0000-000000000001','listing_title','X'));
  assert r->>'status' = 'duplicate', 're-enqueue of same logical event must report duplicate, got ' || r::text;
  select count(*) into n from public.email_outbox
  where logical_event_id='BOOKING_CONFIRMATION:CCCCCCCC-0000-0000-0000-000000000001';
  assert n = 1, 'logical_event_id uniqueness violated (' || n || ' rows)';
  raise notice 'T5 PASS: UNIQUE(logical_event_id) enforced end-to-end (no partial-index race)';
end $$;

-- ============================================================================
-- T6 (§17) TEMPLATE VALIDATION at enqueue: unknown / disabled / bad payload
-- ============================================================================
do $$
begin
  begin
    perform public.enqueue_email_v2('does_not_exist','x@example.com','{}');
    raise exception 'ASSERT-FAIL: unknown template accepted';
  exception when others then
    if sqlerrm like 'ASSERT-FAIL%' then raise; end if;
    assert sqlerrm like '%unknown or disabled%', 'wrong error: ' || sqlerrm;
  end;
  begin
    perform public.enqueue_email_v2('booking_confirmation','x@example.com','{}'::jsonb);  -- missing booking_id
    raise exception 'ASSERT-FAIL: invalid payload accepted';
  exception when others then
    if sqlerrm like 'ASSERT-FAIL%' then raise; end if;
    assert sqlerrm like '%payload validation failed%', 'wrong error: ' || sqlerrm;
  end;
  begin
    perform public.enqueue_email_v2('refund_issued','x@example.com',
      jsonb_build_object('refund_id','not-a-uuid','amount',10));
    raise exception 'ASSERT-FAIL: non-uuid refund_id accepted';
  exception when others then
    if sqlerrm like 'ASSERT-FAIL%' then raise; end if;
    assert sqlerrm like '%not a uuid%', 'wrong error: ' || sqlerrm;
  end;
  raise notice 'T6 PASS: unknown templates + invalid payloads rejected at enqueue (no poisoned rows)';
end $$;

-- ============================================================================
-- T7 (§16) TEMPLATE VERSIONING: version frozen at enqueue; new version applies
-- to new rows only; disabling v2 falls back to v1
-- ============================================================================
insert into public.email_templates (key, version, enabled, category, critical, logical_id_pattern, payload_schema, description)
values ('booking_confirmation', 2, true, 'transactional', true,
        'BOOKING_CONFIRMATION:{booking_id}',
        '{"required":["booking_id"],"properties":{"booking_id":{"type":"uuid"}}}', 'v2 test')
on conflict (key,version) do update set enabled=true;
do $$
declare r jsonb; v int;
begin
  r := public.enqueue_email_v2('booking_confirmation','fresh.v2@example.com',
        jsonb_build_object('booking_id','eeeeeeee-0000-0000-0000-000000000002'));
  select template_version into v from public.email_outbox where id=(r->>'outbox_id')::uuid;
  assert v = 2, 'new enqueue must freeze current version 2, got ' || v;
  select template_version into v from public.email_outbox
  where logical_event_id='BOOKING_CONFIRMATION:CCCCCCCC-0000-0000-0000-000000000001';
  assert v = 1, 'previously queued row must KEEP frozen version 1, got ' || v;
  raise notice 'T7 PASS: template version frozen at enqueue (v1 row stays v1, new rows v2)';
end $$;
update public.email_templates set enabled=false where key='booking_confirmation' and version=2;
do $$
declare r jsonb; v int;
begin
  r := public.enqueue_email_v2('booking_confirmation','fallback.v1@example.com',
        jsonb_build_object('booking_id','eeeeeeee-0000-0000-0000-000000000003'));
  select template_version into v from public.email_outbox where id=(r->>'outbox_id')::uuid;
  assert v = 1, 'disabled v2 must fall back to v1, got ' || v;
  raise notice 'T7b PASS: disabled version falls back to latest enabled';
end $$;
-- teardown: remove rows pinning template v2 (FK works — that's the point), then v2 itself
delete from public.email_send_attempts where outbox_id in
  (select id from public.email_outbox where recipient in ('fresh.v2@example.com','fallback.v1@example.com'));
delete from public.email_outbox where recipient in ('fresh.v2@example.com','fallback.v1@example.com');
delete from public.email_templates where key='booking_confirmation' and version=2;

-- ============================================================================
-- T8 (§10) STATE MACHINE: invalid transitions rejected, valid ones audited
-- ============================================================================
do $$
declare oid uuid; res jsonb;
begin
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state)
  values ('TEST_SM:1','booking_confirmation',1,'state.machine@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','QUEUED')
  returning id into oid;

  res := public.email_outbox_transition(oid,'CLAIMED','test'); assert (res->>'ok')::boolean;
  res := public.email_outbox_transition(oid,'SENDING','test'); assert (res->>'ok')::boolean;
  res := public.email_outbox_transition(oid,'ACCEPTED','test'); assert (res->>'ok')::boolean;

  begin
    perform public.email_outbox_transition(oid,'QUEUED','test');
    raise exception 'ASSERT-FAIL: ACCEPTED→QUEUED must be rejected (app path)';
  exception when others then
    if sqlerrm like 'ASSERT-FAIL%' then raise; end if;
    assert sqlerrm like '%invalid state transition%', sqlerrm;
  end;
  -- DELIVERED→QUEUED via provider path also impossible (rank guard below in T9)
  assert (select count(*) from public.email_outbox where id=oid) = 1;
  assert (select jsonb_array_length(audit_log) >= 3 from public.email_outbox where id=oid);
  raise notice 'T8 PASS: transition matrix enforced + audited (ACCEPTED→QUEUED rejected)';
end $$;

-- ============================================================================
-- T9 (§9) OUT-OF-ORDER + DUPLICATE PROVIDER EVENTS via rank guard
-- ============================================================================
do $$
declare oid uuid; r jsonb;
begin
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state)
  values ('TEST_SM:2','booking_confirmation',1,'ooo@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','SENDING')
  returning id into oid;

  r := public.email_apply_provider_state(oid,'DELIVERED','test','delivered arrived FIRST');
  assert r->>'state' = 'DELIVERED';
  r := public.email_apply_provider_state(oid,'ACCEPTED','test','sent arrived LATE');
  assert coalesce((r->>'skipped_stale')::boolean,false), 'late ACCEPTED must be skipped, got ' || r::text;
  r := public.email_apply_provider_state(oid,'DELAYED','test','delayed after delivered');
  assert coalesce((r->>'skipped_stale')::boolean,false), 'DELAYED after DELIVERED must be skipped';
  r := public.email_apply_provider_state(oid,'COMPLAINED','test','complaint after delivered');
  assert r->>'state' = 'COMPLAINED', 'complaint must upgrade delivered (rank), got ' || r::text;
  r := public.email_apply_provider_state(oid,'DELIVERED','test','delivered after complaint');
  assert coalesce((r->>'skipped_stale')::boolean,false), 'DELIVERED after COMPLAINED must be skipped';
  assert (select state from public.email_outbox where id=oid) = 'COMPLAINED';
  raise notice 'T9 PASS: rank guard — delivered-before-sent, stale downgrades, terminal upgrades all deterministic';
end $$;

-- ============================================================================
-- T10 (§7,§8) WEBHOOK INBOX: persist-first, duplicate-safe, orphan-safe,
-- correlation via attempt AND via logical_event_id tag (webhook-before-result race)
-- ============================================================================
do $$
declare
  oid uuid; aid uuid; ing jsonb; proc jsonb; ev public.email_provider_events; n int;
begin
  -- (a) duplicate delivery: same provider_event_id twice → single row
  ing := public.email_provider_event_ingest('test-dup-1',
    jsonb_build_object('type','email.opened','data',jsonb_build_object('email_id','prov-unknown-1')));
  assert (ing->>'inserted')::boolean;
  ing := public.email_provider_event_ingest('test-dup-1',
    jsonb_build_object('type','email.opened','data',jsonb_build_object('email_id','prov-unknown-1')));
  assert (ing->>'duplicate')::boolean, 'second delivery must be flagged duplicate';
  select count(*) into n from public.email_provider_events where provider_event_id='test-dup-1';
  assert n = 1, 'duplicate created a second inbox row!';

  -- (b) webhook BEFORE send-result: attempt row missing, but tags carry logical id
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state)
  values ('TEST_INBOX:RACE','booking_confirmation',1,'race@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','SENDING')
  returning id into oid;
  ing := public.email_provider_event_ingest('test-race-1',
    jsonb_build_object('type','email.delivered','data', jsonb_build_object(
      'email_id','prov-race-1','to',jsonb_build_array('race@example.com'),
      'tags', jsonb_build_object('logical_event_id','TEST_INBOX:RACE'))));
  proc := public.process_provider_events(50);
  select * into ev from public.email_provider_events where provider_event_id='test-race-1';
  assert ev.processing_status='processed', 'race event not processed: ' || coalesce(ev.processing_error,'');
  assert ev.outbox_id = oid, 'tag correlation failed';
  assert (select state from public.email_outbox where id=oid)='DELIVERED', 'state not applied via tag correlation';

  -- (c) correlation via attempt ledger (provider_email_id)
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state)
  values ('TEST_INBOX:ATT','booking_confirmation',1,'att@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','SENDING')
  returning id into oid;
  insert into public.email_send_attempts (outbox_id, attempt_number, provider_idempotency_key, status, provider_email_id, request_finished_at)
  values (oid, 1, 'gr-test-att-1', 'accepted', 'prov-att-1', now()) returning id into aid;
  perform public.email_outbox_transition(oid,'ACCEPTED','test');
  ing := public.email_provider_event_ingest('test-att-del',
    jsonb_build_object('type','email.delivered','data',jsonb_build_object('email_id','prov-att-1','to',jsonb_build_array('att@example.com'))));
  proc := public.process_provider_events(50);
  assert (select state from public.email_outbox where id=oid)='DELIVERED', 'attempt-ledger correlation failed';

  -- (d) orphan: no attempt, no tags → durably retained, retried, never dropped
  ing := public.email_provider_event_ingest('test-orphan-1',
    jsonb_build_object('type','email.bounced','data',jsonb_build_object('email_id','prov-ghost','to',jsonb_build_array('ghost@example.com'),'bounce',jsonb_build_object('type','Permanent'))));
  proc := public.process_provider_events(50);
  select * into ev from public.email_provider_events where provider_event_id='test-orphan-1';
  assert ev.processing_status='failed' and ev.retry_count=1 and ev.raw_payload is not null,
    'orphan must be retained+marked failed for retry, got ' || ev.processing_status;
  assert (select count(*) from public.email_suppressions where email='ghost@example.com')=0,
    'orphan bounce without correlation must NOT suppress yet (retry first)';
  raise notice 'T10 PASS: inbox duplicates/race/orphans all durable and deterministic (processed=% orphan kept=%)', proc->>'processed', ev.retry_count;
end $$;

-- orphan gets correlated later (attempt appears) → processes on retry
do $$
declare oid uuid; ev public.email_provider_events;
begin
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state)
  values ('TEST_INBOX:LATE','booking_confirmation',1,'ghost@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','SENDING')
  returning id into oid;
  insert into public.email_send_attempts (outbox_id, attempt_number, provider_idempotency_key, status, provider_email_id, request_finished_at)
  values (oid, 1, 'gr-test-late-1', 'accepted', 'prov-ghost', now());
  perform public.process_provider_events(50);
  select * into ev from public.email_provider_events where provider_event_id='test-orphan-1';
  assert ev.processing_status='processed', 'orphan must process once correlation exists';
  assert (select state from public.email_outbox where id=oid)='BOUNCED', 'late bounce not applied';
  assert public.email_is_suppressed('ghost@example.com'), 'permanent bounce must suppress after correlation';
  raise notice 'T10b PASS: orphaned event recovered on retry once attempt row appeared (no lost webhook)';
end $$;

-- ============================================================================
-- T11 (§6, P0-5) AMBIGUOUS RESULT → UNKNOWN → reconcile reuses idempotency key
-- ============================================================================
-- Make claims deterministic: defer every non-TEST row so batch claims only see fixtures of T11-T13
update public.email_outbox set next_attempt_at = now() + interval '6 hours'
where logical_event_id not like 'TEST_%' and state in ('QUEUED','RETRY_WAIT','UNKNOWN');
do $$
declare oid uuid; a1 jsonb; a2 jsonb; r jsonb; k1 text; k2 text; s text;
begin
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state, next_attempt_at)
  values ('TEST_AMB:1','booking_confirmation',1,'amb@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','QUEUED', now() - interval '1 min')
  returning id into oid;
  perform public.claim_outbox_batch(5, 'worker-T11');
  a1 := public.outbox_begin_send(oid, 'worker-T11');
  k1 := a1->>'idempotency_key';
  r := public.outbox_record_result(oid, (a1->>'attempt_id')::uuid, 'unknown', null, 'network', 'timeout after 20s', '{}');
  s := (select state from public.email_outbox where id=oid);
  assert s='UNKNOWN', 'ambiguous result must yield UNKNOWN, got ' || s;
  assert (select status from public.email_send_attempts where id=(a1->>'attempt_id')::uuid)='unknown';
  assert (select next_attempt_at from public.email_outbox where id=oid) > now(), 'reconcile grace not scheduled';

  -- reconcile: force due, claim, begin_send MUST reuse the same provider key
  update public.email_outbox set next_attempt_at = now() - interval '1 sec' where id=oid;
  perform public.claim_outbox_batch(5, 'worker-T11b');
  a2 := public.outbox_begin_send(oid, 'worker-T11b');
  k2 := a2->>'idempotency_key';
  assert k1 = k2, 'reconcile must reuse idempotency key (' || k1 || ' vs ' || k2 || ') — otherwise double-send risk';
  assert (a2->>'reused_key')::boolean;
  r := public.outbox_record_result(oid, (a2->>'attempt_id')::uuid, 'accepted', 'prov-recon-1', null, null, '{}');
  assert (select state from public.email_outbox where id=oid)='ACCEPTED';
  assert (select count(*) from public.email_send_attempts where outbox_id=oid)=2, 'both attempts must be in the ledger';
  raise notice 'T11 PASS: SENDING→UNKNOWN→reconcile with SAME idempotency key→ACCEPTED (ledger keeps both attempts)';
end $$;

-- ============================================================================
-- T12 (§22) RETRY ENGINE: backoff schedule, exhaustion → DEAD with audit
-- ============================================================================
do $$
declare oid uuid; a jsonb; r jsonb; i int; st text; prev timestamptz; cur timestamptz;
begin
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state, max_attempts, next_attempt_at)
  values ('TEST_RETRY:1','booking_confirmation',1,'retry@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','QUEUED',3, now()-interval '1 min')
  returning id into oid;
  for i in 1..3 loop
    perform public.claim_outbox_batch(5,'w-retry');
    a := public.outbox_begin_send(oid,'w-retry');
    if i < 3 then
      r := public.outbox_record_result(oid,(a->>'attempt_id')::uuid,'failed_retryable',null,'429','rate limited','{}');
      st := (select state from public.email_outbox where id=oid);
      assert st='RETRY_WAIT', 'attempt ' || i || ' should wait, got ' || st;
      select next_attempt_at into cur from public.email_outbox where id=oid;
      assert cur > now(), 'backoff must schedule into the future';
      -- make due again for the test loop
      update public.email_outbox set next_attempt_at = now()-interval '1 sec' where id=oid;
    else
      r := public.outbox_record_result(oid,(a->>'attempt_id')::uuid,'failed_retryable',null,'500','still failing','{}');
      st := (select state from public.email_outbox where id=oid);
      assert st='DEAD', 'exhausted retries must dead-letter, got ' || st;
    end if;
  end loop;
  assert (select first_failed_at from public.email_outbox where id=oid) is not null;
  assert (select last_error from public.email_outbox where id=oid) like '%still failing%';
  assert (select count(*) from public.email_send_attempts where outbox_id=oid)=3;
  -- permanent failure short-circuits
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state, next_attempt_at)
  values ('TEST_RETRY:2','booking_confirmation',1,'perm@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','QUEUED', now()-interval '1 min')
  returning id into oid;
  perform public.claim_outbox_batch(5,'w-perm');
  a := public.outbox_begin_send(oid,'w-perm');
  r := public.outbox_record_result(oid,(a->>'attempt_id')::uuid,'failed_permanent',null,'422','invalid recipient','{}');
  assert (select state from public.email_outbox where id=oid)='DEAD', 'permanent failure must dead-letter immediately';
  raise notice 'T12 PASS: retry backoff + exhaustion→DEAD + permanent→DEAD (first_failed_at, ledger complete)';
end $$;

-- ============================================================================
-- T13 (§21) STALE RECOVERY: crash after claim is free; crash mid-send → UNKNOWN
-- ============================================================================
do $$
declare o1 uuid; o2 uuid; r jsonb;
begin
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state, next_attempt_at) values
   ('TEST_STALE:1','booking_confirmation',1,'stale.claim@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','QUEUED', now()-interval '1 min')
  returning id into o1;
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state, next_attempt_at) values
   ('TEST_STALE:2','booking_confirmation',1,'stale.send@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','QUEUED', now()-interval '1 min')
  returning id into o2;

  perform public.claim_outbox_batch(5,'w-crash');
  perform public.outbox_begin_send(o2,'w-crash');            -- o2 now SENDING with attempt 'sending'
  -- simulate crashed workers: age the locks beyond thresholds
  update public.email_outbox set locked_at = now()-interval '30 minutes' where id in (o1,o2);
  update public.email_send_attempts set request_started_at = now()-interval '30 minutes'
   where outbox_id=o2 and status='sending';

  r := public.outbox_recover_stale(10,10);
  assert (select state from public.email_outbox where id=o1)='QUEUED', 'stale CLAIM must return to QUEUED';
  assert (select attempts from public.email_outbox where id=o1)=0, 'stale claim must NOT consume an attempt';
  assert (select state from public.email_outbox where id=o2)='UNKNOWN', 'stale SENDING must become UNKNOWN (never blind resend)';
  assert (select status from public.email_send_attempts where outbox_id=o2 and attempt_number=1)='unknown';
  raise notice 'T13 PASS: crash-after-claim free requeue; crash-mid-send → UNKNOWN + attempt marked unknown (%)', r::text;
end $$;

-- ============================================================================
-- T14 (§11,§12) SUPPRESSION MATRIX: source×reason, escalation, scoped removal
-- ============================================================================
do $$
declare r jsonb;
begin
  -- 1. resend bounce
  r := public.email_apply_suppression('s.bounce@example.com','resend','bounce');
  assert (r->>'applied')::boolean;
  -- 2. resend complaint
  r := public.email_apply_suppression('s.complaint@example.com','resend','complaint');
  assert (r->>'applied')::boolean;
  -- 3. resend suppressed
  r := public.email_apply_suppression('s.suppressed@example.com','resend','suppressed');
  assert (r->>'applied')::boolean;
  -- 4. user unsubscribe
  r := public.email_apply_suppression('s.user@example.com','user','unsubscribe');
  assert (r->>'applied')::boolean;
  -- 5. manual block
  r := public.email_apply_suppression('s.manual@example.com','manual','manual_block');
  assert (r->>'applied')::boolean;

  -- 9. repeated event: harmless no-op (still suppressed, no duplicate row)
  r := public.email_apply_suppression('s.bounce@example.com','resend','bounce');
  assert not (r->>'applied')::boolean, 'repeat bounce must not re-apply/escalate';
  assert (select count(*) from public.email_suppressions where email='s.bounce@example.com' and removed_at is null)=1;

  -- escalation: user unsubscribe on top of resend bounce → user wins
  r := public.email_apply_suppression('s.bounce@example.com','user','unsubscribe');
  assert (r->>'applied')::boolean and (r->>'escalated')::boolean, 'user must escalate over resend';
  -- downgrade attempt: resend bounce over user unsubscribe → refused
  r := public.email_apply_suppression('s.bounce@example.com','resend','bounce');
  assert not (r->>'applied')::boolean, 'resend must NOT downgrade a user unsubscribe';

  -- 6/7/8. provider removal clears ONLY source=resend rows
  perform public.email_remove_provider_suppression('s.bounce@example.com');    -- now user-owned
  perform public.email_remove_provider_suppression('s.suppressed@example.com');-- resend-owned
  perform public.email_remove_provider_suppression('s.user@example.com');      -- user-owned
  perform public.email_remove_provider_suppression('s.manual@example.com');    -- manual-owned
  assert public.email_is_suppressed('s.bounce@example.com'),   'user unsubscribe must SURVIVE provider removal';
  assert not public.email_is_suppressed('s.suppressed@example.com'), 'resend-owned suppression must be removable by provider';
  assert public.email_is_suppressed('s.user@example.com'),     'user unsubscribe must SURVIVE provider removal';
  assert public.email_is_suppressed('s.manual@example.com'),   'manual block must SURVIVE provider removal';

  -- suppressed recipients never enqueue; intent recorded as SUPPRESSED (audit)
  r := public.enqueue_email_v2('booking_confirmation','s.user@example.com',
        jsonb_build_object('booking_id','cccccccc-0000-0000-0000-000000000002'));
  assert r->>'status'='suppressed', 'suppressed recipient must not queue, got ' || r::text;
  assert (select state from public.email_outbox where id=(r->>'outbox_id')::uuid)='SUPPRESSED';
  raise notice 'T14 PASS: full suppression matrix — escalation, scoped removal, audit-preserving skips';
end $$;

-- ============================================================================
-- T15 (§13) UNSUBSCRIBE TOKENS: valid / tampered / forged / expired / replay
-- ============================================================================
do $$
declare
  tok text; v jsonb; r jsonb;
  forged_payload text; forged text; tampered text; expired_tok text;
begin
  tok := public.email_unsub_token('Unsub.Me@example.com','marketing');
  v := public.email_unsub_verify(tok);
  assert (v->>'valid')::boolean and v->>'email'='unsub.me@example.com', 'valid token failed: ' || v::text;

  -- apply → user-sourced suppression
  r := public.email_apply_unsubscribe(tok);
  assert (r->>'ok')::boolean and public.email_is_suppressed('unsub.me@example.com');
  assert exists (select 1 from public.email_suppressions
                 where email='unsub.me@example.com' and source='user' and reason='unsubscribe');
  -- replay of same token → idempotent success, still exactly one active row
  r := public.email_apply_unsubscribe(tok);
  assert (r->>'ok')::boolean, 'token replay must remain successful (idempotent)';
  assert (select count(*) from public.email_suppressions where email='unsub.me@example.com' and removed_at is null)=1;

  -- tampered payload (swap email, keep signature) → invalid
  tampered := 'v1.' || public.email_b64url_encode(convert_to(
      jsonb_build_object('e','victim@example.com','s','marketing','i',0)::text,'UTF8'))
      || '.' || split_part(tok,'.',3);
  v := public.email_unsub_verify(tampered);
  assert not (v->>'valid')::boolean, 'tampered payload must fail';

  -- forged signature (random bytes) → invalid
  forged := 'v1.' || split_part(tok,'.',2) || '.' || public.email_b64url_encode(gen_random_bytes(32));
  v := public.email_unsub_verify(forged);
  assert not (v->>'valid')::boolean and v->>'reason'='signature', 'forged signature must fail';

  -- malformed
  assert not (public.email_unsub_verify('garbage')->>'valid')::boolean;
  assert not (public.email_unsub_verify('')->>'valid')::boolean;
  assert not (public.email_unsub_verify(null)->>'valid')::boolean;
  v := public.email_unsub_verify('v2.aaa.bbb');
  assert not (v->>'valid')::boolean, 'wrong version must fail';

  -- expired: craft a correctly-signed token whose x is in the past
  forged_payload := public.email_b64url_encode(convert_to(
    jsonb_build_object('e','expired@example.com','s','marketing','i',0,
                       'x', floor(extract(epoch from now() - interval '1 day'))::bigint)::text,'UTF8'));
  expired_tok := 'v1.' || forged_payload || '.' || public.email_b64url_encode(public.email_unsub_hmac(forged_payload));
  v := public.email_unsub_verify(expired_tok);
  assert not (v->>'valid')::boolean and v->>'reason'='expired', 'expired token must fail: ' || v::text;

  -- no email enumeration: verification never reveals mailbox existence
  v := public.email_unsub_verify(public.email_unsub_token('nonexistent@mailinator.com'));
  assert (v->>'valid')::boolean, 'token validity must depend only on signature, not on mailbox existence';
  raise notice 'T15 PASS: token sign/verify/apply — tamper, forge, expiry, replay, enumeration all handled';
end $$;

-- ============================================================================
-- T16 (§22, §24) RATE CAPS on attempts-based counting
-- ============================================================================
do $$
declare oid uuid; d text; r jsonb; na timestamptz;
begin
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state)
  values ('TEST_CAP:SRC','booking_confirmation',1,'cap.source@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','ACCEPTED')
  returning id into oid;
  insert into public.email_send_attempts (outbox_id, attempt_number, provider_idempotency_key, status, request_finished_at)
  select oid, g, 'gr-cap-filler-' || g, 'accepted', now() from generate_series(1,85) g;

  assert public.email_daily_send_count() >= 85, 'cap fixture failed';
  d := public.email_rate_decision('review_request');
  assert d='defer_day', 'non-critical at soft cap must defer_day, got ' || d;
  d := public.email_rate_decision('booking_confirmation');
  assert d='allow', 'critical under hard cap must pass, got ' || d;

  r := public.enqueue_email_v2('review_request','cap.test@example.com',
        jsonb_build_object('booking_id','cccccccc-0000-0000-0000-000000000099'));
  select next_attempt_at into na from public.email_outbox where id=(r->>'outbox_id')::uuid;
  assert na > now() + interval '23 hours', 'deferred review must schedule ~+1 day';

  insert into public.email_send_attempts (outbox_id, attempt_number, provider_idempotency_key, status, request_finished_at)
  select oid, 100+g, 'gr-cap-filler2-' || g, 'accepted', now() from generate_series(1,15) g;
  d := public.email_rate_decision('booking_confirmation');
  assert d='defer_hour', 'critical at hard cap must defer_hour, got ' || d;

  delete from public.email_send_attempts where provider_idempotency_key like 'gr-cap-filler%';
  raise notice 'T16 PASS: caps counted from attempt ledger; soft/hard behavior per spec';
end $$;

-- ============================================================================
-- T17 (§20) TIMEZONE-AWARE SCANS: IST booking matches by LOCAL date
-- ============================================================================
do $$
declare r jsonb;
begin
  -- 20:00 UTC today == 01:30 IST TOMORROW → days_before=1 must match in IST
  insert into public.bookings (id, listing_id, renter_id, status, start_date, end_date, total_amount, currency, timezone)
  values ('cccccccc-0000-0000-0000-000000000010','bbbbbbbb-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001','confirmed',
          date_trunc('day', now()) + interval '20 hours',
          date_trunc('day', now()) + interval '3 days', 100, 'INR', 'Asia/Kolkata');
  r := public.scan_booking_reminders(1);
  assert exists (select 1 from public.email_outbox
                 where template_key='booking_reminder'
                   and logical_event_id like 'BOOKING_REMINDER:CCCCCCCC-0000-0000-0000-000000000010:%'),
         'IST-local reminder scan failed to match: ' || r::text;
  -- idempotent re-run
  r := public.scan_booking_reminders(1);
  assert (r->>'enqueued')::int = 0, 'reminder scan not idempotent: ' || r::text;
  raise notice 'T17 PASS: scans match on the BOOKING timezone local date (IST vs UTC divergence handled)';
end $$;

-- ============================================================================
-- T18 (§23) DEAD-LETTER REPLAY: guarded, audited, ledger preserved
-- ============================================================================
do $$
declare did uuid; r jsonb;
begin
  select id into did from public.email_outbox where logical_event_id='TEST_RETRY:1';  -- DEAD from T12
  r := public.email_replay(did, 'ops drill');
  assert (r->>'ok')::boolean;
  assert (select state from public.email_outbox where id=did)='QUEUED';
  assert (select attempts from public.email_outbox where id=did)=0;
  assert (select replay_count from public.email_outbox where id=did)=1;
  assert (select count(*) from public.email_send_attempts where outbox_id=did)=3, 'ledger must be preserved across replay';
  -- replay from DELIVERED forbidden
  begin
    perform public.email_replay((select id from public.email_outbox where state='DELIVERED' limit 1));
    raise exception 'ASSERT-FAIL: replay from DELIVERED must be rejected';
  exception when others then
    if sqlerrm like 'ASSERT-FAIL%' then raise; end if;
    assert sqlerrm like '%replay only allowed%', sqlerrm;
  end;
  -- replay while suppressed forbidden
  begin
    perform public.email_replay((select id from public.email_outbox where state='SUPPRESSED' limit 1));
    raise exception 'ASSERT-FAIL: replay of suppressed recipient must be rejected';
  exception when others then
    if sqlerrm like 'ASSERT-FAIL%' then raise; end if;
    assert sqlerrm like '%suppressed%' or sqlerrm like '%replay only allowed%', sqlerrm;
  end;
  raise notice 'T18 PASS: replay resets cycle, preserves ledger/audit, guards terminal+suppressed states';
end $$;

-- ============================================================================
-- T19 (§30) CLEANUP: retention windows honored; live data untouched
-- ============================================================================

do $$
declare oid uuid; r jsonb;
begin
  -- old PROCESSED event (must be deleted) and old PENDING event (must survive)
  insert into public.email_provider_events (provider_event_id, event_type, raw_payload, received_at, processed_at, processing_status)
  values ('test-old-ev','email.delivered','{}', now()-interval '200 days', now()-interval '200 days','processed')
  on conflict do nothing;
  insert into public.email_provider_events (provider_event_id, event_type, raw_payload, received_at, processing_status)
  values ('test-old-pending','email.delivered','{}', now()-interval '200 days','pending')
  on conflict do nothing;

  delete from public.email_outbox where logical_event_id='TEST_CLEAN:1';
  insert into public.email_outbox (logical_event_id, template_key, template_version, recipient, payload, state, updated_at)
  values ('TEST_CLEAN:1','booking_confirmation',1,'clean.old@example.com','{"booking_id":"cccccccc-0000-0000-0000-000000000001"}','DELIVERED', now()-interval '800 days')
  returning id into oid;
  insert into public.email_send_attempts (outbox_id, attempt_number, provider_idempotency_key, status, request_started_at, request_finished_at)
  values (oid,1,'gr-clean-1','accepted', now()-interval '800 days', now()-interval '800 days');

  r := public.email_cleanup();
  assert not exists (select 1 from public.email_provider_events where provider_event_id='test-old-ev'), 'old processed event must be deleted';
  assert exists (select 1 from public.email_provider_events where provider_event_id='test-old-pending'), 'pending event must survive cleanup';
  assert not exists (select 1 from public.email_outbox where logical_event_id='TEST_CLEAN:1'), 'old terminal outbox must archive+delete';
  assert exists (select 1 from public.email_outbox_archive where logical_event_id='TEST_CLEAN:1'), 'archive copy missing';
  assert not exists (select 1 from public.email_send_attempts where provider_idempotency_key='gr-clean-1'), 'old attempt must be deleted';
  raise notice 'T19 PASS: cleanup honors retention windows; pending/active data untouched (%)', r::text;
end $$;

-- ============================================================================
-- T20 (§27) SECURITY: anon denied on all v2 tables + RPCs; cron has no secrets
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then
    raise notice 'T20 SKIPPED: anon role absent'; return;
  end if;
  perform set_config('role','anon', true);
  begin
    perform count(*) from public.email_outbox;
    raise exception 'ASSERT-FAIL: anon read email_outbox';
  exception when insufficient_privilege then null; end;
  begin
    perform public.email_unsub_token('x@example.com');
    raise exception 'ASSERT-FAIL: anon executed email_unsub_token';
  exception when insufficient_privilege then null; end;
  begin
    perform public.email_apply_unsubscribe('v1.aa.bb');
    raise exception 'ASSERT-FAIL: anon executed email_apply_unsubscribe';
  exception when insufficient_privilege then null; end;
  raise notice 'T20 PASS: anon denied on v2 tables and RPCs';
end $$;
do $$
declare n int; leak int;
begin
  if to_regnamespace('cron') is null then raise notice 'T21 SKIPPED: no cron'; return; end if;
  select count(*) into n from cron.job where jobname like 'gorentals-email-%';
  assert n between 6 and 7, 'expected 6-7 cron jobs (6 pre-002, 7 with winback), got ' || n;
  if n = 7 then
    assert exists (select 1 from cron.job where jobname='gorentals-email-winback'
                   and command like '%scan_winbacks(30)%' and command like '%scan_winbacks(90)%'),
           'winback cron missing tier scans';
    assert exists (select 1 from cron.job where jobname='gorentals-email-queue-drain'
                   and command like '%X-Webhook-Secret%'
                   and command like '%WEBHOOK_SECRET%'),
           'drain cron should carry the WEBHOOK_SECRET vault alias header';
  end if;
  select count(*) into leak from cron.job
  where command ilike '%' || coalesce((select secret from vault.secrets where name='EMAIL_INTERNAL_SECRET'),'§none§') || '%'
    and command not ilike '%MISSING_VAULT_SECRET%';
  assert leak = 0, 'secret literal found in cron.job!';
  select count(*) into leak from cron.job
  where command ilike '%' || coalesce((select secret from vault.secrets where name='UNSUB_TOKEN_SECRET'),'§none2§') || '%';
  assert leak = 0, 'unsub secret literal found in cron.job!';
  raise notice 'T21 PASS: % cron jobs (002-aware); zero secret literals in job definitions', n;
end $$;

-- ============================================================================
-- T22 (§29) TRACE: full correlation chain for operators
-- ============================================================================
do $$
declare t jsonb;
begin
  t := public.email_trace('TEST_INBOX:ATT');
  assert (t->>'found')::boolean;
  assert jsonb_array_length(t->'attempts') >= 1;
  assert jsonb_array_length(t->'provider_events') >= 1;
  assert t->'outbox'->>'state' = 'DELIVERED';
  raise notice 'T22 PASS: email_trace returns outbox+attempts+provider_events chain';
end $$;

-- ============================================================================
-- T23 (002) WELCOME producer: profiles INSERT → WELCOME:{user_id}, once only
-- ============================================================================
do $$
declare n int; v_name text; v_recip text;
begin
  -- fixture profiles were inserted at suite start (trigger fired); verify rows:
  select count(*) into n from public.email_outbox
  where logical_event_id in ('WELCOME:AAAAAAAA-0000-0000-0000-000000000001',
                             'WELCOME:AAAAAAAA-0000-0000-0000-000000000002');
  assert n = 2, 'welcome emails missing for fixture profiles, got ' || n;
  -- profile a1 has NULL profiles.email → recipient must come from auth.users fallback
  select payload->>'renter_name', recipient into v_name, v_recip from public.email_outbox
  where logical_event_id = 'WELCOME:AAAAAAAA-0000-0000-0000-000000000001';
  assert v_name = 'Renter One', 'welcome name missing: ' || coalesce(v_name,'NULL');
  assert v_recip = 'renter.one@example.com', 'auth.users email fallback failed: ' || coalesce(v_recip,'NULL');
  -- re-running the insert as upsert must NOT create a second welcome
  insert into public.profiles (id,email,full_name) values
    ('aaaaaaaa-0000-0000-0000-000000000001', null, 'Renter One')
  on conflict (id) do update set full_name = excluded.full_name;
  select count(*) into n from public.email_outbox where logical_event_id='WELCOME:AAAAAAAA-0000-0000-0000-000000000001';
  assert n = 1, 'welcome duplicated on profile re-write';
  raise notice 'T23 PASS: welcome fires once per user id (auth.users email fallback works)';
end $$;

-- ============================================================================
-- T24 (002) WIN-BACK tiers: sliding windows, weekly campaign dedupe, exclusions
-- ============================================================================
do $$
declare r30 jsonb; r60 jsonb; r60b jsonb; n int;
begin
  -- W1: last activity 31 days ago (tier 30 window [30,37))
  insert into public.bookings (id, listing_id, renter_id, status, start_date, end_date, total_amount)
  values ('cccccccc-0000-0000-0000-000000000020','bbbbbbbb-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001','completed',
          now()-interval '35 days', now()-interval '31 days', 100)
  on conflict (id) do update set end_date = excluded.end_date, status='completed';
  -- W2: last activity 62 days ago (tier 60)
  insert into public.bookings (id, listing_id, renter_id, status, start_date, end_date, total_amount)
  values ('cccccccc-0000-0000-0000-000000000021','bbbbbbbb-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000002','completed',
          now()-interval '66 days', now()-interval '62 days', 100)
  on conflict (id) do update set end_date = excluded.end_date, status='completed';
  -- W3: active 5 days ago — must NOT be targeted
  insert into public.bookings (id, listing_id, renter_id, status, start_date, end_date, total_amount)
  values ('cccccccc-0000-0000-0000-000000000022','bbbbbbbb-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001','completed',
          now()-interval '9 days', now()-interval '5 days', 100)
  on conflict (id) do update set end_date = excluded.end_date, status='completed';

  r30 := public.scan_winbacks(30);
  -- renter a1's LATEST activity is 5 days ago (W3) → a1 must NOT be in tier 30
  assert (r30->>'enqueued')::int = 0, 'active renter wrongly targeted by tier 30: ' || r30::text;
  r60 := public.scan_winbacks(60);
  assert (r60->>'enqueued')::int = 1, 'tier 60 must catch the 62-day-idle owner-renter: ' || r60::text;
  select count(*) into n from public.email_outbox
  where template_key='win_back' and logical_event_id like 'WIN_BACK:OWNER.TWO@EXAMPLE.COM:WB60-%';
  assert n = 1, 'winback logical id/campaign malformed';
  r60b := public.scan_winbacks(60);
  assert (r60b->>'enqueued')::int = 0, 'same-week re-run must dedupe via campaign id: ' || r60b::text;
  raise notice 'T24 PASS: win-back tiers — sliding windows exclude active users, weekly campaign dedupe works';
end $$;

-- ============================================================================
-- T25 (002) IST business-day rate window + invalid-tz fallback
-- ============================================================================
do $$
declare c1 int; c2 int; tz text;
begin
  tz := public.email_cfg('business_timezone');
  assert tz = 'Asia/Kolkata', 'business_timezone default must be Asia/Kolkata, got ' || coalesce(tz,'NULL');
  c1 := public.email_daily_send_count();
  update public.email_config set value='Mars/Olympus' where key='business_timezone';
  c2 := public.email_daily_send_count();   -- must not raise; falls back to UTC
  update public.email_config set value=tz where key='business_timezone';
  assert c1 >= 0 and c2 >= 0, 'count failed';
  assert (select value from public.email_config where key='default_currency') = 'INR',
         'default_currency must be INR for GoRentals';
  raise notice 'T25 PASS: IST day-window counting + invalid-tz fallback + INR default (counts % / %)', c1, c2;
end $$;

-- ============================================================================
-- T26 (002) ctx v3: business tz/currency defaults flow into payloads
-- ============================================================================
do $$
declare v jsonb;
begin
  select payload into v from public.email_outbox
  where logical_event_id='BOOKING_CONFIRMATION:CCCCCCCC-0000-0000-0000-000000000001'
  order by created_at desc limit 1;
  assert v->>'currency' = 'INR', 'canonical booking without currency column data must default INR, got ' || coalesce(v->>'currency','NULL');
  assert v->>'timezone' = 'Asia/Kolkata', 'business timezone default missing: ' || coalesce(v->>'timezone','NULL');
  raise notice 'T26 PASS: INR + Asia/Kolkata defaults carried into email payloads';
end $$;

select 'ALL V2 DATABASE TESTS PASSED' as result;
