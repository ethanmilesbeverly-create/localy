-- =============================================================================
-- 402_tilecache_sweep_swr.sql — roadmap #402 (supersedes the JOB half of #126)
-- Supabase SQL editor. DB-only. No function deploy, no APP_VERSION, no CACHE_VERSION.
-- =============================================================================
--
-- WHAT CHANGES
--   #126's weekly `tilecache-sweep` deleted EVERY versioned tile row past 21 days,
--   current version included. That was right before SWR (#394). Now a stale tile
--   is still worth keeping — SWR serves it instantly and refreshes it in the
--   background — so deleting it at 21 days throws away the pre-warm (#292) and
--   makes the next visitor pay the 15–50 s cold wall.
--
--   The job is re-scheduled (same name, same Sunday 04:17 slot) with three arms:
--     (a) OLD-version rows  (v < current)  past 21 days  → delete   [unchanged #126 orphan cleanup]
--     (b) CURRENT-version rows (v = current) past 90 days → delete   [was 21 — size guard only]
--     (c) unversioned `places:<tile>` fossils             → delete   [unchanged #136]
--
-- HOW "CURRENT" IS FOUND — NO VERSION LITERAL
--   current = the highest `v<N>` present in `places:v<N>:` keys. Nothing here
--   needs editing on a CACHE_VERSION bump (the one-fact-two-places trap #126
--   rejected). On a bump, the first v<N+1> row makes v<N+1> current and every
--   v<N> row becomes an orphan that ages out on arm (a).
--   Edge cases, both harmless (a deleted tile rebuilds on its next visit):
--     • a ROLLBACK to a lower CACHE_VERSION: the rolled-back rows count as
--       "old" and age out at 21 days — exactly the pre-#402 behaviour.
--     • a tool writing a HIGHER version before the function is bumped: the
--       live version's rows age out at 21 days until the bump — same.
--
-- STANDING SWEEP-SAFETY RULE (#126 / handoff §6) — every arm keeps it:
--   prefix-scoped to `places:`, `places:blocklist` excluded (#104),
--   never touches `hunt-code:%` (#84), `resolve:` (#357), `gravebank:` (#356),
--   `wouldremove:` (#369) or `tilehits:` — none of them start with `places:`.
--
-- RUN ORDER: section 0 → 1 (read-only) → 2 (the change) → 3 (verify).
-- Each section is independent; run them one at a time.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- SECTION 0 — BEFORE: the job as it is now (copy the `command` somewhere; it is
-- the revert). Expect one row, schedule '17 4 * * 0', a 21-day predicate.
-- -----------------------------------------------------------------------------
select jobid, jobname, schedule, active, command
from cron.job
where jobname = 'tilecache-sweep';


-- -----------------------------------------------------------------------------
-- SECTION 1 — PREVIEW (read-only). What each arm would delete if the NEW job
-- ran right now, next to what the OLD job would delete. `current_version` should
-- read 34 (CACHE_VERSION "v34").
--   new_total   = rows the new job would delete today
--   old_total   = rows the old job would delete today
--   saved       = current-version rows 21–90 days old (what #402 keeps alive)
-- Today, with the 2026-09-23/24 pre-warm, most current rows are < 21 days, so
-- expect all three numbers small; `saved` is the one that grows over the next
-- weeks instead of being deleted.
-- -----------------------------------------------------------------------------
with cur as (
  select max((substring(key from '^places:v([0-9]+):'))::int) as v
  from public.shared_kv
  where key ~ '^places:v[0-9]+:'
),
t as (
  select
    s.key,
    s.updated_at,
    case when s.key ~ '^places:v[0-9]+:'
         then (substring(s.key from '^places:v([0-9]+):'))::int end as v
  from public.shared_kv s
  where s.key like 'places:%' and s.key <> 'places:blocklist'
)
select
  (select v from cur)                                                    as current_version,
  count(*) filter (where t.v = cur.v)                                    as current_rows,
  count(*) filter (where t.v < cur.v)                                    as old_version_rows,
  count(*) filter (where t.v is null)                                    as fossil_rows,
  -- new job, by arm
  count(*) filter (where t.v < cur.v
                     and (t.updated_at is null or t.updated_at < now() - interval '21 days')) as new_arm_a_old,
  count(*) filter (where t.v >= cur.v
                     and (t.updated_at is null or t.updated_at < now() - interval '90 days')) as new_arm_b_current,
  count(*) filter (where t.v is null)                                    as new_arm_c_fossil,
  count(*) filter (where
      (t.v < cur.v  and (t.updated_at is null or t.updated_at < now() - interval '21 days'))
   or (t.v >= cur.v and (t.updated_at is null or t.updated_at < now() - interval '90 days'))
   or  t.v is null)                                                      as new_total,
  -- old job (#126), for comparison
  count(*) filter (where
      (t.v is not null and (t.updated_at is null or t.updated_at < now() - interval '21 days'))
   or  t.v is null)                                                      as old_total,
  count(*) filter (where t.v = cur.v
                     and t.updated_at <  now() - interval '21 days'
                     and t.updated_at >= now() - interval '90 days')      as saved
from t cross join cur
group by cur.v;


-- -----------------------------------------------------------------------------
-- SECTION 2 — THE CHANGE. cron.schedule with an EXISTING job name updates that
-- job in place (same jobid), so this is idempotent — safe to re-run.
-- To change the size guard later, edit the one '90 days' literal below.
-- -----------------------------------------------------------------------------
select cron.schedule(
  'tilecache-sweep',
  '17 4 * * 0',
  $job$
  with cur as (
    select max((substring(key from '^places:v([0-9]+):'))::int) as v
    from public.shared_kv
    where key ~ '^places:v[0-9]+:'
  )
  delete from public.shared_kv s
  using cur
  where s.key like 'places:%'
    and s.key <> 'places:blocklist'
    and (
      -- (a) #402: OLD versions — orphan cleanup at the tile TTL (unchanged from #126)
      (     s.key ~ '^places:v[0-9]+:'
        and (substring(s.key from '^places:v([0-9]+):'))::int < cur.v
        and (s.updated_at is null or s.updated_at < now() - interval '21 days'))
      or
      -- (b) #402: CURRENT version — size guard only; SWR keeps these useful past TTL
      (     s.key ~ '^places:v[0-9]+:'
        and (substring(s.key from '^places:v([0-9]+):'))::int >= cur.v
        and (s.updated_at is null or s.updated_at < now() - interval '90 days'))
      or
      -- (c) #136: unversioned places:<tile> fossils, by shape
      (s.key !~ '^places:v[0-9]+:')
    );
  $job$
);


-- -----------------------------------------------------------------------------
-- SECTION 3 — AFTER: confirm the job changed. Expect the SAME jobid as section 0,
-- schedule '17 4 * * 0', active = true, and a command containing '90 days' and
-- '< cur.v'.
-- -----------------------------------------------------------------------------
select jobid, jobname, schedule, active,
       command like '%90 days%'  as has_90_day_guard,
       command like '%< cur.v%'  as has_old_version_arm,
       command like '%places:blocklist%' as blocklist_excluded
from cron.job
where jobname = 'tilecache-sweep';


-- -----------------------------------------------------------------------------
-- WEEKLY CHECK (optional, any time after the next Sunday 04:17 UTC run):
-- the last run succeeded, and current-version rows did NOT drop.
-- -----------------------------------------------------------------------------
-- select status, return_message, start_time
-- from cron.job_run_details
-- where jobid = (select jobid from cron.job where jobname = 'tilecache-sweep')
-- order by start_time desc limit 3;
--
-- select count(*) as v34_rows from public.shared_kv where key like 'places:v34:%';


-- -----------------------------------------------------------------------------
-- REVERT: re-run cron.schedule('tilecache-sweep', '17 4 * * 0', $job$ <the
-- command you copied in section 0> $job$);
-- =============================================================================
