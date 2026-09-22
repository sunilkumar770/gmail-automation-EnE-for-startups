-- Test harness: emulates the Supabase environment on bare Postgres 15
-- so 000_email_system_init.sql can be smoke-tested locally.

-- Roles Supabase provides
do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator nologin; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin nologin superuser; end if;
end $$;

-- auth schema (Supabase GoTrue)
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz default now()
);

-- vault schema (Supabase Vault stub)
create schema if not exists vault;
create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  secret text not null,
  description text,
  created_at timestamptz default now()
);
create or replace view vault.decrypted_secrets as
  select id, name, secret as decrypted_secret, description, created_at from vault.secrets;

-- cron schema (pg_cron stub)
create schema if not exists cron;
create table if not exists cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  nodename text default 'localhost',
  nodeport int default 5432,
  database text default current_database(),
  username text default current_user,
  active boolean default true,
  jobname text unique
);
create table if not exists cron.job_run_details (
  runid bigserial primary key, jobid bigint, status text, return_message text,
  start_time timestamptz, end_time timestamptz
);
create or replace function cron.schedule_in_database(p_jobname text, p_schedule text, p_command text, p_database text)
returns bigint language plpgsql as $$
declare v_id bigint;
begin
  insert into cron.job (jobname, schedule, command, database)
  values (p_jobname, p_schedule, p_command, p_database)
  on conflict (jobname) do update
    set schedule=excluded.schedule, command=excluded.command, database=excluded.database, active=true
  returning jobid into v_id;
  return v_id;
end $$;
create or replace function cron.schedule(jobname text, schedule text, command text)
returns bigint language sql as $$ select cron.schedule_in_database($1, $2, $3, current_database()) $$;
create or replace function cron.unschedule(jobname text) returns boolean language sql as $$
  delete from cron.job where jobname = $1; select true;
$$;

-- net schema (pg_net stub — records calls instead of making them)
create schema if not exists net;
create table if not exists net._http_collect (
  id bigserial primary key, url text, headers jsonb, body jsonb,
  timeout_milliseconds int, created_at timestamptz default now()
);
-- Parameter names MUST match real pg_net: the migration calls http_post with
-- named notation (url := ..., headers := ..., body := ..., timeout_milliseconds := ...).
create or replace function net.http_post(url text, headers jsonb default '{}'::jsonb, body jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
returns bigint language plpgsql as $$
declare
  v_id      bigint;
  v_url     text  := url;      -- copy params to locals: avoids plpgsql name
  v_headers jsonb := headers;  -- ambiguity with the target table's columns
  v_body    jsonb := body;
  v_timeout integer := timeout_milliseconds;
begin
  insert into net._http_collect (url, headers, body, timeout_milliseconds)
  values (v_url, v_headers, v_body, v_timeout)
  returning id into v_id;
  raise notice 'net.http_post stub -> id=% url=% body=%', v_id, v_url, v_body;
  return v_id;
end $$;
