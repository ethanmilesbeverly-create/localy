-- =============================================================================
-- 476_retry_health.sql — roadmap #476
-- Supabase SQL editor. Run ONE SECTION AT A TIME, in order.
-- Pairs with app-report-index.ts REPORT_VERSION "app-report-v25".
-- =============================================================================
--
-- WHAT THIS DOES
--   app-report can already see the #472 retry sweep's ROWS (ai_retry_count is a
--   column it reads with the service key). What it cannot see is whether the
--   sweep itself is running: `cron` and `net` are not exposed through PostgREST.
--   This adds ONE read-only function, public.review_retry_health(), that returns:
--     - the cron job review-retry-sweep: exists, active, schedule
--     - its last run and its last SUCCEEDED run (cron.job_run_details), and how
--       many runs / failures in the last 24 h
--     - the last reply review-submission sent the sweep (net._http_response),
--       picked by its body (a sweep reply always carries "looked_at"), and the
--       newest non-200 reply in the window, if any
--   SECURITY DEFINER so it can read the cron and net schemas; EXECUTE granted to
--   service_role ONLY (app-report's key) — no client can call it.
--   It writes nothing.
--
-- ORDER: SECTION 1 (create) → SECTION 2 (check) → DEPLOY app-report v25.
--   Deploying app-report first is safe: its retry_sweep.cron reads
--   {available:false} with an info alert until this has run.
--
-- pg_net keeps responses for ~6 hours, so `last_reply` can be null on a quiet
-- night even when the sweep is healthy — the cron run history is the primary
-- signal, the reply is a bonus.
--
-- (d) of the row — adding ai_retry_count to the pending_review view — is NOT
-- done here: a view is replaced by re-stating its whole definition, the repo's
-- copy (409_schema_baseline.sql) is known stale (#413), and app-report now
-- lists the rows anyway.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- SECTION 1 — THE HEALTH FUNCTION. Idempotent (create or replace).
-- -----------------------------------------------------------------------------
create or replace function public.review_retry_health()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  j          record;
  last_run   record;
  last_ok    record;
  runs_24h   int := 0;
  fails_24h  int := 0;
  rep        record;
  bad        record;
  rep_body   jsonb;
  have_run   boolean;
  have_ok    boolean;
  have_rep   boolean;
  have_bad   boolean;
  out        jsonb;
begin
  select jobid, jobname, schedule, active
    into j
  from cron.job
  where jobname = 'review-retry-sweep'
  limit 1;

  if not found then
    return jsonb_build_object('version', '476-retry-health-v1', 'job_found', false);
  end if;

  select status, return_message, start_time, end_time
    into last_run
  from cron.job_run_details
  where jobid = j.jobid
  order by start_time desc nulls last
  limit 1;
  have_run := found;

  select start_time, end_time
    into last_ok
  from cron.job_run_details
  where jobid = j.jobid and status = 'succeeded'
  order by start_time desc nulls last
  limit 1;
  have_ok := found;

  select count(*), count(*) filter (where status = 'failed')
    into runs_24h, fails_24h
  from cron.job_run_details
  where jobid = j.jobid and start_time > now() - interval '24 hours';

  -- The sweep's own reply: review-submission's retry_failed answer always carries
  -- "looked_at". (pg_net does not keep the request URL with the response.)
  select id, status_code, error_msg, created, left(content::text, 2000) as body
    into rep
  from net._http_response
  where content::text like '%"looked_at"%'
  order by created desc
  limit 1;
  have_rep := found;

  if have_rep then
    begin
      rep_body := rep.body::jsonb;
    exception when others then
      rep_body := null;   -- truncated or not JSON: report the status only
    end;
  end if;

  -- Newest non-200 reply in the retention window (any caller): a 401/403 here is
  -- the Vault key no longer matching the function's service key (#472 section 2).
  select id, status_code, error_msg, created, left(coalesce(content::text, ''), 300) as body
    into bad
  from net._http_response
  where status_code is distinct from 200
  order by created desc
  limit 1;
  have_bad := found;

  out := jsonb_build_object(
    'version',   '476-retry-health-v1',
    'job_found', true,
    'job', jsonb_build_object('jobid', j.jobid, 'schedule', j.schedule, 'active', j.active),
    'last_run', case when not have_run then null else jsonb_build_object(
        'status', last_run.status,
        'started_at', last_run.start_time,
        'ended_at', last_run.end_time,
        'message', left(coalesce(last_run.return_message, ''), 300)) end,
    'last_succeeded_at', case when have_ok then last_ok.start_time end,
    'runs_24h', runs_24h,
    'failed_runs_24h', fails_24h,
    'last_reply', case when not have_rep then null else jsonb_build_object(
        'status_code', rep.status_code,
        'error', rep.error_msg,
        'at', rep.created,
        'looked_at', rep_body -> 'looked_at',
        'due', rep_body -> 'due',
        'retried', rep_body -> 'retried',
        'stopped_early', rep_body -> 'stopped_early',
        'gate_version', rep_body -> 'gate_version') end,
    'last_non_200_reply', case when not have_bad then null else jsonb_build_object(
        'status_code', bad.status_code,
        'error', bad.error_msg,
        'at', bad.created,
        'body', bad.body) end
  );
  return out;
end
$fn$;

revoke all on function public.review_retry_health() from public, anon, authenticated;
grant execute on function public.review_retry_health() to service_role;

comment on function public.review_retry_health() is
  '#476: read-only health of the #472 review-retry-sweep (cron run history + last pg_net reply) for app-report. EXECUTE service_role only.';


-- -----------------------------------------------------------------------------
-- SECTION 2 — CHECK (read-only).
-- 2a: expect one row: security_definer true, and EXECUTE held by service_role
--     only (anon/authenticated false).
-- -----------------------------------------------------------------------------
select p.proname,
       p.prosecdef as security_definer,
       has_function_privilege('anon',          p.oid, 'execute') as anon_can,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can,
       has_function_privilege('service_role',  p.oid, 'execute') as service_role_can
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'review_retry_health';

-- 2b: call it. Expect job_found true, job.active true, job.schedule '7,37 * * * *',
--     last_run.status 'succeeded', runs_24h around 48 (two an hour).
select jsonb_pretty(public.review_retry_health());


-- -----------------------------------------------------------------------------
-- SECTION 3 — REVERT (only if needed). app-report v25 falls back to
-- {available:false} + an info alert without it.
-- -----------------------------------------------------------------------------
-- drop function if exists public.review_retry_health();
