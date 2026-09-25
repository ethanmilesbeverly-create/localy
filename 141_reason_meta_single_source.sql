-- 141_reason_meta_single_source.sql — #141: public.report_reason_meta becomes
-- the ONE server-side home of the report-reason vocabulary, its thresholds and
-- which reasons the AI may act on.
--
-- RUN: Supabase SQL editor, the whole file at once, BEFORE deploying the new
-- nearby-places and app-report (they select the new `ai_acts` column; deployed
-- first, their read fails — nearby-places then refuses reports with a retryable
-- 503 and serves unsuppressed, which is safe but noisy). One transaction: any
-- failed assertion at the end rolls the whole file back.
--
-- BEFORE THIS FILE the server rules lived in FOUR places: nearby-places'
-- REPORT_REASONS / AI_ACT_REASONS / REPORT_SUPPRESS_THRESHOLD read (the one that
-- actually hid pins), this table (read by report_target_state, reports_open and
-- resolve_report), and app-report's SUPPRESSES / AI_ACTS mirror + its own read of
-- the same secret. Only nearby-places and the client checked each other. AFTER:
-- this table is read by both functions and by the SQL, so the moderation queue,
-- the dashboard and the map cannot disagree about a threshold. The client's label
-- list stays a copy — it is checked against this table through nearby-places'
-- `reasonCodes` echo (#25).
--
-- WHAT THIS DOES:
--   1. Records the table's current rows (they are printed in the check row).
--   2. Adds `ai_acts` (boolean, default false) — the #347 AI fast path: a
--      confident AI 'remove' on ONE open report of this reason hides the pin.
--   3. Writes the canonical eight rows — exactly what nearby-places serves today
--      (REPORT_SUPPRESS_THRESHOLD is unset, so the crowd bar is 3):
--        gone            suppresses, threshold 3   doesn't exist / permanently closed
--        chain           suppresses, threshold 3   a franchise the #104 filter missed
--        bogus           suppresses, threshold 3, ai_acts   fake / obscene / spam
--        moved           never automated (#132)    relocated — find the new node
--        wrong_location  informational             pin is off — a fix, not a deletion
--        wrong_info      informational             wrong name/category — same
--        private         informational             can't get to it — still exists
--        unsafe          never automated (#25)     human queue only
--      If the table held bogus = 1 (the floor #347 retired), reports_open and
--      resolve_report were reading a stale bar; the check row shows it.
--   4. Puts the reasons' standing policy into CHECK constraints, so an edit that
--      breaks it is refused instead of being caught by a comment:
--        - no suppressing reason below 2 — no lone human tap hides a pin (#347);
--        - `unsafe` and `moved` can never suppress or be AI-acted (#25/#132);
--        - the AI may act only on a suppressing CONTENT reason — never on a
--          reason that needs real-world ground truth (gone, chain, moved, the
--          wrong_*, private, unsafe) (#347).
--   5. Adds a foreign key reports.reason → report_reason_meta.reason, so the
--      database itself refuses a reason code the table doesn't define.
--   6. Asserts the table holds exactly the eight codes, and aborts otherwise
--      (an extra row would silently become a live report reason).
--
-- TO CHANGE A THRESHOLD LATER: `update public.report_reason_meta set threshold
-- = N where reason = '…';` in the SQL editor. nearby-places picks it up within
-- 5 minutes per instance (its memo), app-report on its next run. No deploy.
-- TO ADD A REASON: insert the row here AND add its label to index.html's
-- REPORT_REASONS list; the client's #25 echo check logs any mismatch.
--
-- NOT CHANGED: the table's RLS (on, no policies) and grants (service_role only);
-- report_target_state, reports_open and resolve_report (they already read this
-- table — they now read correct values). The REPORT_SUPPRESS_THRESHOLD secret is
-- no longer read by anything after the two function deploys.
--
-- BACK-OUT: the constraints and foreign key can be dropped by name
-- (report_reason_meta_crowd_min_ck, report_reason_meta_never_automated_ck,
-- report_reason_meta_ai_acts_ck, reports_reason_fkey); the ai_acts column must
-- stay while the #141 builds of nearby-places / app-report are deployed.
--
-- Related: #25, #131, #132, #134, #347, #350, #409.

begin;

-- 1. RECORD THE CURRENT ROWS -------------------------------------------------
create temp table _rrm_before on commit drop as
  select reason, suppresses, threshold from public.report_reason_meta;

-- 2. THE AI-ACTS COLUMN ------------------------------------------------------
alter table public.report_reason_meta
  add column if not exists ai_acts boolean not null default false;

-- 3. THE CANONICAL ROWS ------------------------------------------------------
-- Constraints from step 4 are dropped first so a re-run can rewrite rows freely;
-- they are re-added (and checked against every row) straight after.
alter table public.report_reason_meta drop constraint if exists report_reason_meta_crowd_min_ck;
alter table public.report_reason_meta drop constraint if exists report_reason_meta_never_automated_ck;
alter table public.report_reason_meta drop constraint if exists report_reason_meta_ai_acts_ck;

insert into public.report_reason_meta (reason, suppresses, threshold, ai_acts) values
  ('gone',           true,  3,    false),
  ('chain',          true,  3,    false),
  ('bogus',          true,  3,    true),
  ('moved',          false, null, false),
  ('wrong_location', false, null, false),
  ('wrong_info',     false, null, false),
  ('private',        false, null, false),
  ('unsafe',         false, null, false)
on conflict (reason) do update
  set suppresses = excluded.suppresses,
      threshold  = excluded.threshold,
      ai_acts    = excluded.ai_acts;

-- 4. THE POLICY AS CONSTRAINTS -----------------------------------------------
alter table public.report_reason_meta add constraint report_reason_meta_crowd_min_ck
  check (not suppresses or threshold >= 2);

alter table public.report_reason_meta add constraint report_reason_meta_never_automated_ck
  check (reason not in ('unsafe', 'moved') or (not suppresses and not ai_acts));

alter table public.report_reason_meta add constraint report_reason_meta_ai_acts_ck
  check (not ai_acts or (suppresses and reason not in
    ('gone', 'chain', 'moved', 'wrong_location', 'wrong_info', 'private', 'unsafe')));

comment on table public.report_reason_meta is
  '#141: the ONE server-side home of the report-reason vocabulary. Read by nearby-places (validator, suppression, AI fast path), app-report, report_target_state, reports_open and resolve_report. Edit here; no deploy needed.';
comment on column public.report_reason_meta.ai_acts is
  '#347: a confident AI remove verdict on ONE open report of this reason hides the pin. Content reasons only (see report_reason_meta_ai_acts_ck).';

-- 5. THE FOREIGN KEY ---------------------------------------------------------
alter table public.reports drop constraint if exists reports_reason_fkey;
alter table public.reports add constraint reports_reason_fkey
  foreign key (reason) references public.report_reason_meta (reason);

-- 6. ASSERTIONS --------------------------------------------------------------
do $$
declare
  extra text;
  n int;
begin
  select string_agg(reason, ', ' order by reason) into extra
    from public.report_reason_meta
   where reason not in ('gone', 'chain', 'bogus', 'moved',
                        'wrong_location', 'wrong_info', 'private', 'unsafe');
  if extra is not null then
    raise exception '#141: report_reason_meta holds reason(s) outside the canonical eight: %. Decide each (delete it, or add it to the client and this file) and re-run.', extra;
  end if;

  select count(*) into n from public.report_reason_meta;
  if n <> 8 then raise exception '#141: expected 8 reasons, found %', n; end if;

  select count(*) into n from pg_constraint
   where conrelid = 'public.report_reason_meta'::regclass
     and conname in ('report_reason_meta_crowd_min_ck',
                     'report_reason_meta_never_automated_ck',
                     'report_reason_meta_ai_acts_ck');
  if n <> 3 then raise exception '#141: expected 3 policy constraints, found %', n; end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.reports'::regclass
                    and conname = 'reports_reason_fkey' and convalidated) then
    raise exception '#141: reports_reason_fkey missing or not validated';
  end if;
end $$;

-- 7. CHECK ROW (read this) ---------------------------------------------------
-- Expected: reasons 8 · suppressing gone,chain,bogus · thresholds all 3 ·
-- ai_acts bogus · policy_constraints 4 (the original threshold check + the
-- three added here) · reports_fk true · unmatched_reports 0.
-- `before` is what the table held; `changed` lists every reason this run moved.
select
  (select count(*) from public.report_reason_meta)                              as reasons,
  (select string_agg(reason, ',' order by reason) from public.report_reason_meta
    where suppresses)                                                           as suppressing,
  (select string_agg(reason || '=' || threshold, ',' order by reason)
     from public.report_reason_meta where suppresses)                           as thresholds,
  (select string_agg(reason, ',' order by reason) from public.report_reason_meta
    where ai_acts)                                                              as ai_acts,
  (select count(*) from pg_constraint
    where conrelid = 'public.report_reason_meta'::regclass
      and conname like 'report_reason_meta_%_ck')                               as policy_constraints,
  exists (select 1 from pg_constraint
           where conrelid = 'public.reports'::regclass
             and conname = 'reports_reason_fkey')                               as reports_fk,
  (select count(*) from public.reports r
    where not exists (select 1 from public.report_reason_meta m
                       where m.reason = r.reason))                              as unmatched_reports,
  (select string_agg(reason || ':' || case when suppresses then 's' || threshold else 'info' end,
                     ',' order by reason) from _rrm_before)                     as before,
  coalesce((select string_agg(m.reason, ',' order by m.reason)
     from public.report_reason_meta m
     left join _rrm_before b on b.reason = m.reason
    where b.reason is null
       or b.suppresses is distinct from m.suppresses
       or b.threshold  is distinct from m.threshold), '(none)')                 as changed;

commit;
