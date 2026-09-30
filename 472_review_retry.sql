-- =============================================================================
-- 472_review_retry.sql — roadmap #472 (+ a read for #474 (d))
-- Supabase SQL editor. Run ONE SECTION AT A TIME, in order.
-- Pairs with review-submission-index.ts GATE_VERSION "gate-471-472-v1".
-- =============================================================================
--
-- WHAT THIS DOES
--   A user gem that fails open at the AI gate (Gemini 429 / 5xx / network, #3)
--   used to sit in pending until someone noticed (Reebie, #470). This adds:
--     1. submissions.ai_retry_count   — how many times the sweep has retried a row
--     2. a Vault secret               — the service-role JWT the sweep calls with
--     3. public.review_retry_kick()   — POSTs {action:"retry_failed"} to
--                                       review-submission via pg_net
--     4. cron job review-retry-sweep  — runs the kick at :07 and :37 every hour
--   Which rows get retried, the backoff and the circuit breaker all live in the
--   function (one home) — see the #472 block in review-submission-index.ts.
--
-- ORDER (the function needs the column; the cron needs the function):
--   SECTION 0 (read) → SECTION 1 (column) → DEPLOY review-submission →
--   SECTION 2 (Vault secret) → SECTION 3 (kick function) → SECTION 4 (cron) →
--   SECTION 5 (verify). SECTION 6 is QA, SECTION 7 the #474 (d) read,
--   SECTION 8 the revert.
--
-- NOTHING SECRET IS IN THIS FILE. Section 2 has a placeholder; paste the key
-- into the SQL editor only, never into this file or the repo.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- SECTION 0 — PREFLIGHT (read-only). Expect three rows: pg_cron, pg_net,
-- supabase_vault. If one is missing, stop and say which.
-- -----------------------------------------------------------------------------
select extname, extversion
from pg_extension
where extname in ('pg_cron', 'pg_net', 'supabase_vault')
order by extname;


-- -----------------------------------------------------------------------------
-- SECTION 1 — THE COLUMN. Idempotent. Server-only: it is NOT added to the #276
-- anon/authenticated column-SELECT allowlist (nothing on the client reads it).
-- Run this BEFORE deploying the new review-submission.
-- -----------------------------------------------------------------------------
alter table public.submissions
  add column if not exists ai_retry_count integer not null default 0;

comment on column public.submissions.ai_retry_count is
  '#472: times the review-retry-sweep re-ran the AI gate on this row after it failed open. Written only by review-submission (action retry_failed). Cap 6.';

-- check: expect one row, integer, default 0, not null
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'submissions' and column_name = 'ai_retry_count';


-- -----------------------------------------------------------------------------
-- >>> NOW DEPLOY review-submission (dashboard → Edge Functions →
--     review-submission → Code → paste the new file → Deploy). <<<
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- SECTION 2 — THE VAULT SECRET. Run ONCE.
-- The value is the LEGACY service_role key — the long one that starts "eyJ"
-- (about 219 characters; Project Settings → API Keys → Legacy API keys →
-- service_role). It must be byte-identical to the SUPABASE_SERVICE_ROLE_KEY
-- the function sees, or the sweep answers 403. NOT the new "sb_secret_…" key.
--
-- Replace PASTE_KEY_HERE in the editor, run, then clear the editor. If the
-- secret already exists (re-run), use the update form underneath instead.
-- -----------------------------------------------------------------------------
select vault.create_secret(
  'PASTE_KEY_HERE',
  'review_retry_service_key',
  '#472: bearer for the review-retry-sweep cron → review-submission'
);

-- (re-run only) update an existing secret instead of creating a second one:
-- select vault.update_secret(
--   (select id from vault.secrets where name = 'review_retry_service_key'),
--   'PASTE_KEY_HERE'
-- );

-- check: expect one row, length ~219, starts with eyJ. Never select the value itself.
select name, length(decrypted_secret) as len, left(decrypted_secret, 3) as starts
from vault.decrypted_secrets
where name = 'review_retry_service_key';


-- -----------------------------------------------------------------------------
-- SECTION 3 — THE KICK FUNCTION. Idempotent (create or replace).
-- SECURITY DEFINER so it can read Vault when cron runs it; EXECUTE revoked from
-- every API role, so no client can call it through PostgREST.
-- Returns the pg_net request id (look it up in net._http_response).
-- -----------------------------------------------------------------------------
create or replace function public.review_retry_kick()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  k   text;
  rid bigint;
begin
  select decrypted_secret into k
  from vault.decrypted_secrets
  where name = 'review_retry_service_key';

  if k is null or k = '' then
    raise exception '#472: vault secret review_retry_service_key is missing — run 472 section 2';
  end if;

  select net.http_post(
    url                  := 'https://siacjgpqzaylsfefihyr.supabase.co/functions/v1/review-submission',
    body                 := jsonb_build_object('action', 'retry_failed'),
    headers              := jsonb_build_object(
                              'Content-Type',  'application/json',
                              'Authorization', 'Bearer ' || k),
    timeout_milliseconds := 120000   -- up to 5 gate calls per sweep
  ) into rid;

  return rid;
end
$fn$;

revoke all on function public.review_retry_kick() from public, anon, authenticated, service_role;

comment on function public.review_retry_kick() is
  '#472: cron review-retry-sweep calls this; it POSTs {action:"retry_failed"} to review-submission with the Vault service key.';


-- -----------------------------------------------------------------------------
-- SECTION 4 — THE CRON JOB. cron.schedule with an existing name updates it in
-- place, so this is idempotent. :07 and :37 keep it off the :17 Sunday sweeps.
-- -----------------------------------------------------------------------------
select cron.schedule(
  'review-retry-sweep',
  '7,37 * * * *',
  $job$select public.review_retry_kick();$job$
);


-- -----------------------------------------------------------------------------
-- SECTION 5 — VERIFY THE WIRING (read-only apart from one kick).
-- 5a: expect one row, schedule '7,37 * * * *', active true.
-- -----------------------------------------------------------------------------
select jobid, jobname, schedule, active
from cron.job
where jobname = 'review-retry-sweep';

-- 5b: kick once by hand. Returns a request id.
select public.review_retry_kick() as request_id;

-- 5c: wait ~10 seconds, then read the answer. Expect status_code 200 and a
--     body starting {"gate_version":"gate-471-472-v1","looked_at":…
--     403 = the Vault key is not the function's service_role key (section 2).
--     401 = the key is not a JWT (you stored the sb_secret_ key).
--     404 = review-submission not found at that URL.
select id, status_code, left(content::text, 700) as body, error_msg, created
from net._http_response
order by created desc
limit 3;


-- -----------------------------------------------------------------------------
-- SECTION 6 — QA: TWO TEST ROWS (the only rows this pass writes by hand).
-- 6a creates:
--   QA472 spam  — failed open on a 429 an hour ago → the sweep should re-run
--                 the gate, which should REJECT it (it is spam on purpose, so
--                 nothing lands on the map).
--   QA472 400   — failed on a 400 (a config error) → must be LEFT ALONE.
-- -----------------------------------------------------------------------------
insert into public.submissions
  (name, description, lat, lng, source, status,
   ai_status, ai_http_status, ai_reason, ai_reviewed_at)
values
  ('QA472 buy cheap followers now click here', 'limited offer visit my site', 41.8781, -87.6298,
   'user', 'pending', 'http_error', 429, 'QA472 test row (fake 429)', now() - interval '1 hour'),
  ('QA472 config error control', null, 41.8790, -87.6300,
   'user', 'pending', 'http_error', 400, 'QA472 test row (fake 400)', now() - interval '1 hour')
returning id, name;

-- 6b: kick, wait ~15 s, then run 6c.
select public.review_retry_kick() as request_id;

-- 6c: expect
--   QA472 buy cheap…      status rejected, ai_status ok,         ai_retry_count 1
--   QA472 config error…   status pending,  ai_status http_error, ai_retry_count 0
select name, status, ai_status, ai_http_status, ai_retry_count,
       left(ai_reason, 120) as reason, ai_reviewed_at
from public.submissions
where name like 'QA472%'
order by name;

-- 6d: Reebie (approved by hand after its 429) must be untouched:
--     expect status approved, ai_retry_count 0.
select name, status, ai_status, ai_retry_count, reviewed_at is not null as hand_reviewed
from public.submissions
where name ilike '%reebie%' and merged_into is null;

-- 6e: CLEAN UP the test rows.
delete from public.submissions where name like 'QA472%';


-- -----------------------------------------------------------------------------
-- SECTION 7 — #474 (d): HOW LONG WAS THE GATE DOWN? (read-only)
-- One line per day per gate outcome for user submissions since 1 Sep.
-- If http_error 429 rows go back to ~10 Sep, #464's "gate scored nothing since
-- 10 Sep" is explained. Paste the result back.
-- -----------------------------------------------------------------------------
select date_trunc('day', created_at)::date as day,
       coalesce(ai_status, '∅') as ai_status,
       ai_http_status,
       count(*) as n,
       count(*) filter (where status = 'pending' and merged_into is null) as still_pending
from public.submissions
where source = 'user' and created_at > '2026-09-01'
group by 1, 2, 3
order by 1, 2, 3;


-- -----------------------------------------------------------------------------
-- SECTION 8 — REVERT (only if needed). Stops the sweep; the column and the
-- secret are harmless to leave, but the lines to remove them are here.
-- -----------------------------------------------------------------------------
-- select cron.unschedule('review-retry-sweep');
-- drop function if exists public.review_retry_kick();
-- delete from vault.secrets where name = 'review_retry_service_key';
-- alter table public.submissions drop column if exists ai_retry_count;   -- only AFTER redeploying the previous review-submission
