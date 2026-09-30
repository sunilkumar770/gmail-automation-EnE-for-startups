-- ============================================================================
-- GoRentals — STEP 1 RECONCILIATION / SCHEMA INSPECTION SCRIPT
-- ----------------------------------------------------------------------------
-- PURPOSE
--   Run this FIRST against the live (or local) Supabase Postgres database,
--   BEFORE applying `supabase/migrations/000_email_system_init.sql`.
--   It is 100% read-only (no writes, no DDL). Paste the full output back to
--   the engineering channel / into the project wiki so the team can confirm
--   the canonical mapping used by the email system.
--
-- HOW TO RUN
--   Option A (SQL Editor): Supabase Dashboard -> SQL Editor -> paste -> Run.
--   Option B (psql):       psql "$SUPABASE_DB_URL" -f scripts/00_reconcile_schema.sql
--   Option C (CLI):        supabase db remote exec is NOT used; prefer A or B.
--
-- WHAT THE MIGRATION EXPECTS (canonical assumptions)
--   bookings(id uuid PK, renter_id -> auth.users, listing_id -> listings,
--            status text in ('pending','confirmed','cancelled', ...),
--            start_date / end_date, total_amount, created_at)
--   listings(id uuid PK, owner_id -> auth.users, title)
--   profiles(id uuid PK -> auth.users, email, full_name)
--   refunds(id uuid PK, booking_id, amount, status, created_at)
--
--   The migration auto-detects common naming variants (renter_id vs user_id,
--   owner_id vs host_id, start_date vs starts_at, ...) and builds the
--   canonical view `email.bookings_ctx` accordingly — but the report below
--   is still REQUIRED to confirm enum values and e-mail columns.
-- ============================================================================

\echo '==================== 1. TABLE EXISTENCE ===================='
select table_schema, table_name
from information_schema.tables
where table_schema in ('public','email')
  and table_name in ('bookings','profiles','listings','refunds','email_log','email_queue','suppression_list',
                     'email_outbox','email_send_attempts','email_provider_events','email_suppressions','email_templates')
order by table_schema, table_name;

\echo '==================== 2. COLUMN MAP: bookings ===================='
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'bookings'
order by ordinal_position;

\echo '==================== 3. COLUMN MAP: listings ===================='
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'listings'
order by ordinal_position;

\echo '==================== 4. COLUMN MAP: profiles ===================='
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;

\echo '==================== 5. COLUMN MAP: refunds ===================='
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'refunds'
order by ordinal_position;

\echo '==================== 6. COLUMN MAP: email_log / email_queue (if they already exist) ===================='
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name in ('email_log','email_queue','email_outbox','email_send_attempts','email_provider_events','email_suppressions','email_templates')
order by table_name, ordinal_position;

\echo '==================== 7. ENUM VALUES ACTUALLY IN USE (bookings.status) ===================='
-- DISCREPANCY CHECK: the migration triggers fire on
--   confirmed-likes: 'confirmed','approved','accepted'
--   cancelled-likes: 'cancelled','canceled'
-- Report anything else you see here so it can be mapped.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='bookings' and column_name='status') then
    raise notice 'bookings.status exists — distinct values follow in next query';
  else
    raise notice 'WARNING: bookings.status column NOT found — check section 2 for the real status column name';
  end if;
end $$;

-- Safe dynamic version (works even if column is named differently — edit if so):
select status, count(*) as n
from public.bookings
group by status
order by n desc;

\echo '==================== 8. EMAIL ADDRESS SOURCES ===================='
select 'profiles.email'  as source, count(*) filter (where email is not null) as with_email, count(*) as total from public.profiles
union all
select 'auth.users.email', count(*) filter (where email is not null), count(*) from auth.users;

\echo '==================== 9. EXISTING EXTENSIONS ===================='
select extname, extversion from pg_extension order by extname;
-- REQUIRED by the migration: pg_cron, pg_net, pgcrypto (gen_random_uuid)

\echo '==================== 10. EXISTING pg_cron JOBS (collision check) ===================='
select jobid, jobname, schedule, active, database, nodename
from cron.job
order by jobname;

\echo '==================== 11. VAULT SECRET NAMES ONLY (never select decrypted_secret in a report) ===================='
select name, description, created_at
from vault.secrets
order by name;
-- EXPECTED after setup: RESEND_API_KEY (optional, edge fn uses its own env),
-- EMAIL_INTERNAL_SECRET (required by pg_cron -> edge function calls)

\echo '==================== 12. RLS STATUS OF RELEVANT TABLES ===================='
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerls as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('bookings','profiles','listings','refunds','email_log','email_queue','suppression_list',
                    'email_outbox','email_send_attempts','email_provider_events','email_suppressions','email_templates');

\echo '==================== 13. EXISTING INDEXES / CONSTRAINTS ON email_log (idempotency collision check) ===================='
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename in ('email_log','email_queue')
order by tablename, indexname;

\echo '==================== 14. FOREIGN KEYS FROM bookings (who is the renter? who is the owner?) ===================='
select
  tc.constraint_name,
  kcu.column_name            as booking_column,
  ccu.table_schema || '.' || ccu.table_name as references_table,
  ccu.column_name            as references_column
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
where tc.constraint_type = 'FOREIGN KEY'
  and tc.table_schema = 'public'
  and tc.table_name = 'bookings';

\echo '==================== 15. TIMEZONE THE SERVER RUNNS IN (affects cron schedules + daily cap window) ===================='
show timezone;
select now() as server_now, now() at time zone 'UTC' as utc_now;

\echo '==================== RECONCILIATION COMPLETE — paste everything above into the project channel ===================='
