-- =============================================================================
-- 490_pin_interest.sql — roadmap #490 (where people open pins, by area)
-- Supabase SQL editor. Run FIRST, before the app-report and index.html builds
-- that read and write it. No function deploy. No CACHE_VERSION.
-- Stamp: 490-pin-interest-v1 (on the function's comment; Section 3 reads it).
-- =============================================================================
--
-- WHAT THIS IS
--   One table of daily TALLIES: (UTC day, 1° grid square) → how many times a pin
--   in that square was opened. The app adds 1 when someone opens a pin; the
--   square is the PIN's square, computed on the device from the pin's own
--   coordinate. `app-report` (service role) is the only reader; it rolls the
--   squares up to metros for the morning report's US map.
--
-- WHAT IT DELIBERATELY DOES NOT HOLD (the #490 directive: pin data, not user data)
--   no device id, no user id, no email, no IP, no exact coordinate, no pin id,
--   no timestamp finer than the UTC day. A row cannot be traced to a person or
--   a device, and two opens of the same square on the same day are the same
--   row. #10's rule for `activity_pings` (handoff §4) is untouched — this is a
--   separate table with no identifier at all, not a coordinate on a ping.
--
-- THE WRITER: a SECURITY DEFINER function, `pin_interest_add(cell_lat, cell_lng)`,
--   is the ONLY write path. anon/authenticated have EXECUTE on it and NO table
--   privileges at all. It rejects a square outside the US box (lat 18..71,
--   lng -180..-66 — the 50 states, Hawaii and Alaska included) with SQLSTATE
--   22023, and adds exactly 1 per call. Why a function and not #10's insert-only
--   table: a tally is an UPDATE of an existing row (opens + 1), and giving the
--   public key UPDATE on a table is a far wider door than EXECUTE on one
--   function that can only ever add 1.
--
-- ACCEPTED TRADE-OFF (same shape as #10's): no rate limiting. Anyone holding the
--   public key can inflate a square's count — only by 1 per call, only inside
--   the US box, only in a table nobody but app-report reads. A per-row ceiling
--   (1,000,000) stops a runaway loop from overflowing the column. If abuse ever
--   shows, the escape hatch is a per-day cap per square inside this function.
--
-- RETENTION: 400 days (enough for a year-on-year read), swept daily at 04:29
--   UTC by cron job `pin-interest-sweep`. Rows hold no personal data, so the
--   window is about table size, not privacy. To change it, edit the one '400'.
--
-- RUN ORDER: 0 (read-only) → 1 → 2 → 3 (verify) → 3b as a SEPARATE run.
--   Section 4 is the revert. SAFE TO RUN THE WHOLE FILE AT ONCE: no BEGIN /
--   ROLLBACK anywhere (the #10 gravestone: the SQL editor runs the whole editor
--   as one transaction, so a rollback in the verify undoes everything above it).
-- AFTER RUNNING: `409_schema_baseline.sql` is staler (#413) — a new table, a
--   function, grants and a cron job. This file is their definition until then.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- SECTION 0 — PREFLIGHT (read-only). Expect: table_exists = false,
-- function_exists = false, pg_cron_installed = true, existing_job = 0.
-- -----------------------------------------------------------------------------
select
  to_regclass('public.pin_interest') is not null                       as table_exists,
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'pin_interest_add') as function_exists,
  exists (select 1 from pg_extension where extname = 'pg_cron')        as pg_cron_installed,
  (select count(*) from cron.job where jobname = 'pin-interest-sweep')  as existing_job;


-- -----------------------------------------------------------------------------
-- SECTION 1 — THE TABLE, THE FUNCTION, RLS, GRANTS. Idempotent, safe to re-run.
-- -----------------------------------------------------------------------------
create table if not exists public.pin_interest (
  day      date     not null,
  cell_lat smallint not null,   -- floor(pin latitude)  — the square's south edge
  cell_lng smallint not null,   -- floor(pin longitude) — the square's west edge
  opens    integer  not null default 0,
  constraint pin_interest_pkey primary key (day, cell_lat, cell_lng),
  constraint pin_interest_us_box check (cell_lat between 18 and 71
                                        and cell_lng between -180 and -66),
  constraint pin_interest_opens_range check (opens between 0 and 1000000)
);

comment on table public.pin_interest is
  '#490 — anonymous daily pin-open tallies per 1-degree square (the PIN''s square). '
  'No device, user, IP, pin id or exact coordinate. Written only through '
  'pin_interest_add(); read only by app-report (service role). 400-day retention '
  'via the pin-interest-sweep cron job. Source: 490_pin_interest.sql.';

-- For the report's window scans (day >= today - 30) without walking the PK.
create index if not exists pin_interest_day_idx on public.pin_interest (day);

alter table public.pin_interest enable row level security;

-- Supabase grants ALL on new public tables to anon/authenticated by default.
-- Strip it: the public key gets NOTHING on the table, only EXECUTE on the
-- function below. No policies exist, so with RLS on, direct access is denied
-- to anon/authenticated even if a grant ever drifted back.
revoke all on table public.pin_interest from public, anon, authenticated;
grant select, delete on table public.pin_interest to service_role;

create or replace function public.pin_interest_add(cell_lat integer, cell_lng integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if cell_lat is null or cell_lng is null
     or cell_lat not between 18 and 71
     or cell_lng not between -180 and -66 then
    raise exception 'pin_interest_add: square (%, %) is outside the US box', cell_lat, cell_lng
      using errcode = '22023';
  end if;

  -- Parameters are qualified with the function name and the conflict target is
  -- named by constraint: the parameter names match the column names (they are
  -- the JSON keys the app sends to /rpc/pin_interest_add), and an unqualified
  -- reference is ambiguous in PL/pgSQL (caught in the local rehearsal).
  insert into public.pin_interest as p (day, cell_lat, cell_lng, opens)
  values ((now() at time zone 'utc')::date,
          pin_interest_add.cell_lat, pin_interest_add.cell_lng, 1)
  on conflict on constraint pin_interest_pkey
  do update set opens = least(p.opens + 1, 1000000);
end;
$fn$;

comment on function public.pin_interest_add(integer, integer) is
  '490-pin-interest-v1 — adds 1 to today''s (UTC) tally for one 1-degree square. '
  'The only write path to public.pin_interest. Source: 490_pin_interest.sql.';

revoke all on function public.pin_interest_add(integer, integer) from public;
grant execute on function public.pin_interest_add(integer, integer) to anon, authenticated, service_role;

-- Make PostgREST see the new table and RPC immediately.
notify pgrst, 'reload schema';


-- -----------------------------------------------------------------------------
-- SECTION 2 — RETENTION. Daily at 04:29 UTC (clear of activity-pings-sweep at
-- 04:23 and tilecache-sweep's Sunday 04:17). cron.schedule with an existing
-- name updates it in place — idempotent.
-- -----------------------------------------------------------------------------
select cron.schedule(
  'pin-interest-sweep',
  '29 4 * * *',
  $job$
  delete from public.pin_interest
  where day < ((now() at time zone 'utc')::date - 400);
  $job$
);


-- -----------------------------------------------------------------------------
-- SECTION 3 — VERIFY. No BEGIN/ROLLBACK. Calls the function as `anon` exactly
-- the way the app will, twice on one square, proves an out-of-box square is
-- refused and a direct table write is denied, then takes its own 2 opens back
-- off the tally (deleting the row if it was new) while reporting — so the
-- table is left as it was whether this section runs alone or with the file.
-- The test square is 41,-88 (Chicago's) on purpose: if real opens land there
-- in the same second, the take-back still only removes the 2 this test added.
-- Expected result (one row):
--   table_exists = true            rls_on = true
--   anon_can_select = false        anon_can_insert = false
--   anon_can_update = false        anon_can_delete = false
--   anon_can_execute = true        function_stamp = 490-pin-interest-v1
--   test_added = 2                 out_of_box_refused = true
--   direct_write_refused = true    job_schedule = '29 4 * * *'
-- If the DO block errors with "permission denied", STOP — the app's call will
-- fail the same way. Paste the error back rather than loosening grants by hand.
-- -----------------------------------------------------------------------------
create temporary table if not exists _pin490_check (k text primary key, v text);
truncate _pin490_check;
grant all on _pin490_check to anon;

do $$
declare
  before_opens integer;
  after_opens  integer;
begin
  select coalesce((select opens from public.pin_interest
                   where day = (now() at time zone 'utc')::date
                     and cell_lat = 41 and cell_lng = -88), 0)
    into before_opens;

  set local role anon;

  perform public.pin_interest_add(41, -88);
  perform public.pin_interest_add(41, -88);

  begin
    perform public.pin_interest_add(0, 0);
    insert into _pin490_check values ('out_of_box_refused', 'false');
  exception when sqlstate '22023' then
    insert into _pin490_check values ('out_of_box_refused', 'true');
  end;

  begin
    insert into public.pin_interest (day, cell_lat, cell_lng, opens)
      values ((now() at time zone 'utc')::date, 41, -88, 999);
    insert into _pin490_check values ('direct_write_refused', 'false');
  exception when insufficient_privilege then
    insert into _pin490_check values ('direct_write_refused', 'true');
  end;

  reset role;

  select opens into after_opens from public.pin_interest
  where day = (now() at time zone 'utc')::date and cell_lat = 41 and cell_lng = -88;
  insert into _pin490_check values ('test_added', (after_opens - before_opens)::text);

  -- take the test's 2 opens back off; drop the row if the test created it
  update public.pin_interest set opens = opens - 2
  where day = (now() at time zone 'utc')::date and cell_lat = 41 and cell_lng = -88;
  delete from public.pin_interest
  where day = (now() at time zone 'utc')::date and cell_lat = 41 and cell_lng = -88
    and opens = 0;
end $$;

select
  to_regclass('public.pin_interest') is not null                               as table_exists,
  (select relrowsecurity from pg_class where oid = 'public.pin_interest'::regclass) as rls_on,
  has_table_privilege('anon', 'public.pin_interest', 'SELECT')                 as anon_can_select,
  has_table_privilege('anon', 'public.pin_interest', 'INSERT')                 as anon_can_insert,
  has_table_privilege('anon', 'public.pin_interest', 'UPDATE')                 as anon_can_update,
  has_table_privilege('anon', 'public.pin_interest', 'DELETE')                 as anon_can_delete,
  has_function_privilege('anon', 'public.pin_interest_add(integer, integer)', 'EXECUTE') as anon_can_execute,
  split_part(obj_description('public.pin_interest_add(integer, integer)'::regprocedure, 'pg_proc'), ' ', 1)
                                                                               as function_stamp,
  (select v::int  from _pin490_check where k = 'test_added')                   as test_added,
  (select v::bool from _pin490_check where k = 'out_of_box_refused')           as out_of_box_refused,
  (select v::bool from _pin490_check where k = 'direct_write_refused')         as direct_write_refused,
  (select schedule from cron.job where jobname = 'pin-interest-sweep')        as job_schedule;


-- -----------------------------------------------------------------------------
-- SECTION 3b — DID IT STICK? Run this ON ITS OWN, as a separate run, after the
-- file. Expect table_exists = true, function_exists = true, sweep_jobs = 1,
-- test_rows_left = 0 (no leftover from the verify, unless real opens of the
-- Chicago square already arrived — then it is their count, not the test's).
-- -----------------------------------------------------------------------------
-- select to_regclass('public.pin_interest') is not null as table_exists,
--        exists (select 1 from pg_proc where proname = 'pin_interest_add') as function_exists,
--        (select count(*) from cron.job where jobname = 'pin-interest-sweep') as sweep_jobs,
--        (select coalesce(sum(opens), 0) from public.pin_interest
--          where day = (now() at time zone 'utc')::date
--            and cell_lat = 41 and cell_lng = -88) as test_rows_left;


-- -----------------------------------------------------------------------------
-- LIVE CHECK (any time after the index.html that sends opens is deployed).
-- Read-only. The busiest squares over the last 7 days; a square's south-west
-- corner is (cell_lat, cell_lng).
-- -----------------------------------------------------------------------------
-- select cell_lat, cell_lng, sum(opens) as opens_7d
-- from public.pin_interest
-- where day >= (now() at time zone 'utc')::date - 6
-- group by 1, 2
-- order by 3 desc
-- limit 20;


-- -----------------------------------------------------------------------------
-- SECTION 4 — REVERT (only if backing #490 out). The client call is
-- fire-and-forget and app-report treats a missing table as info, so reverting
-- the SQL alone is safe.
-- -----------------------------------------------------------------------------
-- select cron.unschedule('pin-interest-sweep');
-- drop function if exists public.pin_interest_add(integer, integer);
-- drop table if exists public.pin_interest;
-- notify pgrst, 'reload schema';
