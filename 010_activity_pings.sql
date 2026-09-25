-- =============================================================================
-- 010_activity_pings.sql — roadmap #10 (lightweight telemetry, #400's prerequisite)
-- Supabase SQL editor. Run BEFORE the index.html that sends pings (2026.09.25a)
-- goes live; the app-report v22 read tolerates the table being absent (info only).
-- No function deploy. No CACHE_VERSION.
-- =============================================================================
--
-- WHAT THIS IS
--   One insert-only table, `activity_pings`, that the app writes a row into the
--   FIRST time each device does each of a fixed list of things on a given UTC day.
--   `app-report` (service role) is the only reader. It answers one question the
--   operator cannot answer today: is anyone using the app, guests included?
--   (`engagement.active_users_*` counts `user_state` writes, which only accounts
--   make — #400 is about to let people in without one.)
--
-- THE WRITER DECISION (#10 sub-decision (a), 2026-09-25): insert-only table, no
--   function. Validation lives here, in SQL:
--     • event      — CHECK against the fixed list below (the client carries the
--                    same list; a new event is a change to BOTH, in one pass).
--     • device_id  — uuid type; a malformed id is a type error, not a row.
--     • day        — server clock (UTC). NOT client-writable (no column grant).
--     • signed_in  — SERVER-DERIVED from the request's JWT (auth.uid() is not null).
--                    NOT client-writable, so a client cannot mislabel itself.
--     • created_at — server clock. NOT client-writable.
--   Daily dedupe = the primary key (device_id, day, event). The client does a
--   PLAIN insert and treats a duplicate-key reply (Postgres 23505 / HTTP 409) as
--   success. The client also remembers what it already sent today, so duplicates
--   only happen when two tabs race or browser storage fails.
--
--   GRAVESTONE — ON CONFLICT DO NOTHING (the row's original plan). Tested against
--   Postgres 16 before shipping: `insert ... on conflict (device_id, day, event)
--   do nothing` as `anon` fails with "permission denied" — naming a conflict
--   target needs SELECT privilege on those columns, and PostgREST always names one
--   (the PK when no on_conflict is given). Granting anon SELECT on device_id/day
--   to make it work would be a read grant on a write-only table. A bare
--   `on conflict do nothing` (no target) does work, but PostgREST cannot send it.
--   So: plain insert, PK as the dedupe, 409 = fine.
--
-- DELIBERATELY NOT HERE (#10 "deliberately out"):
--   no user_id, no email, no IP, no coordinates, no tile key, no place id.
--   Conversion is "the same device later sent `signed_in`" — never a join to an
--   account. That keeps the digest PII-free (item 5) and keeps location history
--   (the #5 sensitivity) out of a table that doesn't need it.
--
-- ACCEPTED TRADE-OFF OF (a): no rate limiting. Anyone holding the public key can
--   insert junk rows — but only valid events, one per (device, day, event), and
--   only into a table nobody but app-report reads. The worst case is inflated
--   counts, which the 90-day sweep ages out. If that ever happens, (b) — a small
--   writer function with rate limiting — is the recorded escape hatch.
--
-- RUN ORDER: 0 (read-only) → 1 → 2 → 3 (verify). Section 4 is the revert — do
-- not run it unless backing out. SAFE TO RUN THE WHOLE FILE AT ONCE: nothing in it
-- uses BEGIN/ROLLBACK any more (see the gravestone at Section 3).
--
-- GRAVESTONE — BEGIN … ROLLBACK IN THE VERIFY (the first cut of this file,
--   2026-09-25). The Supabase SQL editor sends the whole editor contents as ONE
--   request, which Postgres runs as ONE implicit transaction. A `rollback;` at the
--   end of the verify therefore rolled back EVERYTHING above it — the table, the
--   grants, the policy and the cron job — after the verify had already displayed a
--   perfect result from inside that doomed transaction. The dashboard then reported
--   the table missing. Lesson: a script meant for the SQL editor must never carry
--   its own transaction control; undo test data with an explicit DELETE instead.
-- AFTER RUNNING: the #409 baseline is stale (a new table, policy, grants and a
--   cron job). Refresh `409_schema_baseline.sql` on the next baseline pass.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- SECTION 0 — PREFLIGHT (read-only). Expect: table_exists = false,
-- pg_cron_installed = true, auth_uid_exists = true, existing_job = 0.
-- -----------------------------------------------------------------------------
select
  to_regclass('public.activity_pings') is not null                    as table_exists,
  exists (select 1 from pg_extension where extname = 'pg_cron')       as pg_cron_installed,
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'auth' and p.proname = 'uid')             as auth_uid_exists,
  (select count(*) from cron.job where jobname = 'activity-pings-sweep') as existing_job;


-- -----------------------------------------------------------------------------
-- SECTION 1 — THE TABLE, RLS, GRANTS. Idempotent (if not exists / drop policy
-- if exists / revoke-then-grant), safe to re-run.
-- -----------------------------------------------------------------------------
create table if not exists public.activity_pings (
  device_id  uuid        not null,
  day        date        not null default ((now() at time zone 'utc')::date),
  event      text        not null,
  signed_in  boolean     not null default (auth.uid() is not null),
  created_at timestamptz not null default now(),
  constraint activity_pings_pkey primary key (device_id, day, event),
  -- #10 — THE FIXED EVENT LIST. Mirrors ACTIVITY_EVENTS in index.html. Adding an
  -- event is a change to both files in the same pass (one-fact-two-files, called
  -- out on purpose). Order here matches the client.
  constraint activity_pings_event_check check (event in (
    'app_open',       -- the app finished deciding who you are (guest or signed in)
    'map_move',       -- a hand pan, a map search pick, or "Search this area"
    'pin_open',       -- a pin's detail sheet opened
    'guide_open',     -- a guide opened (My Guides, a redeemed code) or a shared-spot link landed
    'capture_tap',    -- the Capture button was pressed (attempt, not success)
    'signin_prompt',  -- the sign-in screen was shown to someone without a session
    'signed_in'       -- this device went from no session to a session (sign-in or new account)
  ))
);

comment on table public.activity_pings is
  '#10 — anonymous per-device daily activity pings. Insert-only for anon/authenticated '
  '(device_id + event only); day/signed_in/created_at are server-derived. No user_id, '
  'no location. Read only by app-report (service role). 90-day retention via the '
  'activity-pings-sweep cron job. Source: 010_activity_pings.sql.';

-- For the report's window scans (day >= today - 30) without walking the PK.
create index if not exists activity_pings_day_idx on public.activity_pings (day);

alter table public.activity_pings enable row level security;

-- Supabase grants ALL on new public tables to anon/authenticated by default.
-- Strip that first, then give back exactly two column-level INSERT privileges.
revoke all on table public.activity_pings from public, anon, authenticated;
grant insert (device_id, event) on table public.activity_pings to anon, authenticated;
-- The report reads; the sweep deletes (cron runs as postgres, which owns the table).
grant select, delete on table public.activity_pings to service_role;

-- One policy: INSERT, for both client roles. The row-level check is intentionally
-- permissive — every value the client controls is already constrained by type,
-- CHECK and column grants above, and the three it doesn't are server defaults.
-- No SELECT / UPDATE / DELETE policy exists, so with RLS on, those are denied to
-- anon/authenticated even if a grant ever drifted back.
drop policy if exists activity_pings_insert on public.activity_pings;
create policy activity_pings_insert on public.activity_pings
  as permissive for insert to anon, authenticated
  with check (true);

-- Make PostgREST see the new table immediately (it usually does on its own).
notify pgrst, 'reload schema';


-- -----------------------------------------------------------------------------
-- SECTION 2 — RETENTION. Daily at 04:23 UTC (clear of tilecache-sweep's Sunday
-- 04:17). cron.schedule with an existing name updates it in place — idempotent.
-- To change the window, edit the one '90' below AND privacy.html's "90 days".
-- -----------------------------------------------------------------------------
select cron.schedule(
  'activity-pings-sweep',
  '23 4 * * *',
  $job$
  delete from public.activity_pings
  where day < ((now() at time zone 'utc')::date - 90);
  $job$
);


-- -----------------------------------------------------------------------------
-- SECTION 3 — VERIFY. No BEGIN/ROLLBACK (see the gravestone in the header). The
-- test row is inserted as `anon` inside a DO block exactly the way the app does it
-- (plain insert, two columns), a second identical row is proven to be refused, and
-- the final statement DELETES the test row while reporting on it — so the table is
-- left clean whether this section runs alone or as part of the whole file.
-- Expected result (one row):
--   table_exists              = true
--   anon_can_insert_device_id = true    anon_can_insert_event     = true
--   anon_can_insert_day       = false   anon_can_insert_signed_in = false
--   anon_can_select           = false   anon_can_update           = false
--   anon_can_delete           = false   rls_on                    = true
--   rows_for_test_device      = 1       (the duplicate was refused; the 1 is now deleted)
--   test_row_signed_in        = false   (no JWT → guest)
--   test_row_day_is_utc_today = true
--   job_schedule              = '23 4 * * *'
-- If the DO block errors with "permission denied" or "violates row-level security",
-- STOP — the app's pings will fail the same way. Paste the error back rather than
-- loosening grants by hand. If it errors with "FAIL: a second app_open…", the PK
-- dedupe is missing.
-- -----------------------------------------------------------------------------
do $$
begin
  set local role anon;
  insert into public.activity_pings (device_id, event)
    values ('00000000-0000-4000-8000-00000000a010', 'app_open');
  begin
    insert into public.activity_pings (device_id, event)
      values ('00000000-0000-4000-8000-00000000a010', 'app_open');
    raise exception 'FAIL: a second app_open for the same device and day was accepted — the PK dedupe is missing';
  exception when unique_violation then
    null; -- expected: the daily dedupe refused it
  end;
  reset role;
end $$;

with test_row as (
  delete from public.activity_pings
  where device_id = '00000000-0000-4000-8000-00000000a010'
  returning signed_in, day
)
select
  to_regclass('public.activity_pings') is not null                             as table_exists,
  has_column_privilege('anon', 'public.activity_pings', 'device_id', 'INSERT') as anon_can_insert_device_id,
  has_column_privilege('anon', 'public.activity_pings', 'event',     'INSERT') as anon_can_insert_event,
  has_column_privilege('anon', 'public.activity_pings', 'day',       'INSERT') as anon_can_insert_day,
  has_column_privilege('anon', 'public.activity_pings', 'signed_in', 'INSERT') as anon_can_insert_signed_in,
  has_table_privilege ('anon', 'public.activity_pings', 'SELECT')              as anon_can_select,
  has_table_privilege ('anon', 'public.activity_pings', 'UPDATE')              as anon_can_update,
  has_table_privilege ('anon', 'public.activity_pings', 'DELETE')              as anon_can_delete,
  (select relrowsecurity from pg_class where oid = 'public.activity_pings'::regclass) as rls_on,
  (select count(*) from test_row)                                              as rows_for_test_device,
  (select bool_and(signed_in) from test_row)                                   as test_row_signed_in,
  (select bool_and(day = (now() at time zone 'utc')::date) from test_row)      as test_row_day_is_utc_today,
  (select schedule from cron.job where jobname = 'activity-pings-sweep')      as job_schedule;


-- -----------------------------------------------------------------------------
-- SECTION 3b — DID IT STICK? Run this ON ITS OWN, as a separate run, after the
-- file. Expect table_exists = true and sweep_jobs = 1. (This is the check the first
-- cut of the file was missing: a verify inside the same run can't see a rollback
-- that happens after it.)
-- -----------------------------------------------------------------------------
-- select to_regclass('public.activity_pings') is not null as table_exists,
--        (select count(*) from cron.job where jobname = 'activity-pings-sweep') as sweep_jobs;


-- -----------------------------------------------------------------------------
-- LIVE CHECK (any time after the new index.html is deployed and opened once).
-- Read-only. Shows today's pings by event and guest/signed-in split. No device
-- ids are printed.
-- -----------------------------------------------------------------------------
-- select event, signed_in, count(*) as devices
-- from public.activity_pings
-- where day = (now() at time zone 'utc')::date
-- group by 1, 2
-- order by 1, 2;


-- -----------------------------------------------------------------------------
-- SECTION 4 — REVERT (only if backing #10 out). The client fails silently
-- without the table (fire-and-forget), and app-report v22 shows activity as an
-- info alert instead of a section, so reverting the SQL alone is safe.
-- -----------------------------------------------------------------------------
-- select cron.unschedule('activity-pings-sweep');
-- drop table if exists public.activity_pings;
-- notify pgrst, 'reload schema';
