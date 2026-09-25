-- 409_schema_baseline.sql — #409(b): the live Nahgoo database schema as of
-- 2026-09-24, exported from the live DB by 409_schema_export.sql (216 objects).
--
-- WHAT THIS IS. The single repo record of every table, constraint, index,
-- function, view, trigger, RLS switch, policy, grant and cron job in the live
-- database. It replaces the ~35 numbered migrations (006…394) and profiles.sql
-- (#169) that were never committed: for a live DB object, the live DB is the
-- source (handoff §3), so this was exported, not reconstructed. Includes #410's
-- fix (submission_cleanup_review: security_invoker, no anon/authenticated
-- grants), which ran before the export.
--
-- VERIFIED BYTE-EXACT by 409_baseline_check.sql: it re-exports the live DB and
-- compares a per-section md5 against this file's sections (13 rows, all true).
--
-- WHAT IT IS NOT.
--   * Not a migration to run on the live DB. Everything in it already exists
--     there; running it would error on the first create table.
--   * Not a guaranteed one-shot rebuild. It assumes a Supabase project: the
--     auth / storage / extensions / vault schemas, the anon / authenticated /
--     service_role roles, pg_cron, pg_net, and Postgres 17 (the MAINTAIN
--     privilege in the grants). Unqualified names (submissions, auth.users
--     references) assume search_path = public, extensions — set below.
--   * Not data. Rows, one-shot data migrations (405_graves_cleanup.sql is a
--     record of one) and Edge Functions (<function>-index.<ext>) live elsewhere.
--
-- HOW TO USE IT. Read it to see what the database holds; copy the exact
-- current definition from it before changing a function, policy or grant
-- (handoff §5: extend from the live object); regenerate it with
-- 409_schema_export.sql + a new check whenever the schema has moved enough
-- that this copy misleads. Sections run in dependency order: extensions,
-- tables, keys, foreign keys, indexes, functions, checks (some call
-- functions), views, triggers, RLS, policies, grants, cron.

set search_path = public, extensions;

-- [extension] pg_cron
create extension if not exists pg_cron;

-- [extension] pg_net
create extension if not exists pg_net with schema public;

-- [extension] pg_stat_statements
create extension if not exists pg_stat_statements with schema extensions;

-- [extension] pgcrypto
create extension if not exists pgcrypto with schema extensions;

-- [extension] supabase_vault
create extension if not exists supabase_vault with schema vault;

-- [extension] unaccent
create extension if not exists unaccent with schema extensions;

-- [extension] uuid-ossp
create extension if not exists "uuid-ossp" with schema extensions;

-- [table] submissions
create table public.submissions (
  id uuid default gen_random_uuid() not null,
  name text not null,
  description text,
  category text,
  lat double precision not null,
  lng double precision not null,
  city text,
  submitted_by uuid,
  source text default 'user'::text,
  status text default 'pending'::text,
  ai_decision text,
  ai_reason text,
  created_at timestamp with time zone default now(),
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  review_note text,
  ai_status text,
  ai_http_status integer,
  ai_model text,
  ai_confidence real,
  ai_reviewed_at timestamp with time zone,
  ai_model_source text,
  name_clean text,
  description_clean text,
  merged_into uuid,
  resolved_description text,
  resolved_source text
);

-- [table] hunts
create table public.hunts (
  id uuid default gen_random_uuid() not null,
  name text not null,
  share_code text,
  created_by uuid,
  created_at timestamp with time zone default now()
);

-- [table] hunt_points
create table public.hunt_points (
  id uuid default gen_random_uuid() not null,
  hunt_id uuid,
  name text not null,
  lat double precision not null,
  lng double precision not null,
  submission_id uuid,
  sort_order integer default 0
);

-- [table] progress
create table public.progress (
  id uuid default gen_random_uuid() not null,
  user_id uuid,
  hunt_key text not null,
  found_id text not null,
  mode text,
  captured_at timestamp with time zone default now()
);

-- [table] user_state
create table public.user_state (
  user_id uuid not null,
  key text not null,
  value text,
  updated_at timestamp with time zone default now()
);

-- [table] shared_kv
create table public.shared_kv (
  key text not null,
  value text,
  updated_at timestamp with time zone default now(),
  owner uuid default auth.uid()
);

-- [table] reports
create table public.reports (
  id uuid default gen_random_uuid() not null,
  target_id text not null,
  target_source text not null,
  reason text not null,
  note text,
  reported_by uuid not null,
  target_name text,
  lat double precision,
  lng double precision,
  status text default 'open'::text not null,
  created_at timestamp with time zone default now() not null,
  resolved_at timestamp with time zone,
  resolved_by uuid,
  resolution_note text,
  ai_verdict text,
  ai_rationale text,
  ai_model text,
  ai_at timestamp with time zone
);

-- [table] gem_seconds
create table public.gem_seconds (
  id uuid default gen_random_uuid() not null,
  submission_id uuid not null,
  user_id uuid not null,
  source_submission_id uuid,
  created_at timestamp with time zone default now() not null
);

-- [table] report_reason_meta
create table public.report_reason_meta (
  reason text not null,
  suppresses boolean not null,
  threshold integer
);

-- [table] profiles
create table public.profiles (
  user_id uuid not null,
  display_name text,
  status text default 'ok'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

-- [table] capture_log
create table public.capture_log (
  id bigint generated always as identity not null,
  user_id uuid not null,
  pin_id text not null,
  pin_type text not null,
  authoritative_lat double precision,
  authoritative_lng double precision,
  reported_lat double precision not null,
  reported_lng double precision not null,
  distance_m double precision,
  speed_mps double precision,
  status text not null,
  reason text,
  is_new_pin boolean default false not null,
  cap jsonb,
  created_at timestamp with time zone default now() not null
);

-- [table] leaderboard_scores
create table public.leaderboard_scores (
  user_id uuid not null,
  distinct_pins integer default 0 not null,
  last_lat double precision,
  last_lng double precision,
  last_at timestamp with time zone,
  updated_at timestamp with time zone default now() not null,
  opted_out boolean default false not null,
  verified_distance_m double precision default 0 not null
);

-- [table] guides
create table public.guides (
  id uuid default gen_random_uuid() not null,
  code text not null,
  name text default ''::text not null,
  editable boolean default false not null,
  withdrawn boolean default false not null,
  owner uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

-- [table] guide_stops
create table public.guide_stops (
  id uuid default gen_random_uuid() not null,
  guide_id uuid not null,
  stop_id text not null,
  name text default ''::text not null,
  lat double precision,
  lng double precision,
  descr text default ''::text not null,
  category text,
  added_by uuid,
  "position" integer default 0 not null,
  data jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);

-- [table] curated_descriptions
create table public.curated_descriptions (
  id uuid default gen_random_uuid() not null,
  name text not null,
  name_clean text generated always as (regexp_replace(lower(name), '[^a-z0-9]'::text, ''::text, 'g'::text)) stored,
  lat double precision not null,
  lng double precision not null,
  description text not null,
  source_url text,
  note text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

-- [constraint] submissions.submissions_pkey
alter table public.submissions add constraint submissions_pkey PRIMARY KEY (id);

-- [constraint] hunts.hunts_pkey
alter table public.hunts add constraint hunts_pkey PRIMARY KEY (id);

-- [constraint] hunts.hunts_share_code_key
alter table public.hunts add constraint hunts_share_code_key UNIQUE (share_code);

-- [constraint] hunt_points.hunt_points_pkey
alter table public.hunt_points add constraint hunt_points_pkey PRIMARY KEY (id);

-- [constraint] progress.progress_pkey
alter table public.progress add constraint progress_pkey PRIMARY KEY (id);

-- [constraint] progress.progress_user_id_hunt_key_found_id_key
alter table public.progress add constraint progress_user_id_hunt_key_found_id_key UNIQUE (user_id, hunt_key, found_id);

-- [constraint] user_state.user_state_pkey
alter table public.user_state add constraint user_state_pkey PRIMARY KEY (user_id, key);

-- [constraint] shared_kv.shared_kv_pkey
alter table public.shared_kv add constraint shared_kv_pkey PRIMARY KEY (key);

-- [constraint] reports.reports_pkey
alter table public.reports add constraint reports_pkey PRIMARY KEY (id);

-- [constraint] reports.reports_target_id_reported_by_key
alter table public.reports add constraint reports_target_id_reported_by_key UNIQUE (target_id, reported_by);

-- [constraint] gem_seconds.gem_seconds_pkey
alter table public.gem_seconds add constraint gem_seconds_pkey PRIMARY KEY (id);

-- [constraint] gem_seconds.gem_seconds_submission_id_user_id_key
alter table public.gem_seconds add constraint gem_seconds_submission_id_user_id_key UNIQUE (submission_id, user_id);

-- [constraint] report_reason_meta.report_reason_meta_pkey
alter table public.report_reason_meta add constraint report_reason_meta_pkey PRIMARY KEY (reason);

-- [constraint] profiles.profiles_pkey
alter table public.profiles add constraint profiles_pkey PRIMARY KEY (user_id);

-- [constraint] capture_log.capture_log_pkey
alter table public.capture_log add constraint capture_log_pkey PRIMARY KEY (id);

-- [constraint] leaderboard_scores.leaderboard_scores_pkey
alter table public.leaderboard_scores add constraint leaderboard_scores_pkey PRIMARY KEY (user_id);

-- [constraint] guides.guides_pkey
alter table public.guides add constraint guides_pkey PRIMARY KEY (id);

-- [constraint] guides.guides_code_key
alter table public.guides add constraint guides_code_key UNIQUE (code);

-- [constraint] guide_stops.guide_stops_pkey
alter table public.guide_stops add constraint guide_stops_pkey PRIMARY KEY (id);

-- [constraint] guide_stops.guide_stops_guide_id_stop_id_key
alter table public.guide_stops add constraint guide_stops_guide_id_stop_id_key UNIQUE (guide_id, stop_id);

-- [constraint] curated_descriptions.curated_descriptions_pkey
alter table public.curated_descriptions add constraint curated_descriptions_pkey PRIMARY KEY (id);

-- [constraint] submissions.submissions_submitted_by_fkey
alter table public.submissions add constraint submissions_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES auth.users(id);

-- [constraint] hunts.hunts_created_by_fkey
alter table public.hunts add constraint hunts_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);

-- [constraint] hunt_points.hunt_points_hunt_id_fkey
alter table public.hunt_points add constraint hunt_points_hunt_id_fkey FOREIGN KEY (hunt_id) REFERENCES hunts(id) ON DELETE CASCADE;

-- [constraint] hunt_points.hunt_points_submission_id_fkey
alter table public.hunt_points add constraint hunt_points_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id);

-- [constraint] progress.progress_user_id_fkey
alter table public.progress add constraint progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);

-- [constraint] user_state.user_state_user_id_fkey
alter table public.user_state add constraint user_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);

-- [constraint] submissions.submissions_reviewed_by_fkey
alter table public.submissions add constraint submissions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);

-- [constraint] submissions.submissions_merged_into_fkey
alter table public.submissions add constraint submissions_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES submissions(id) ON DELETE SET NULL;

-- [constraint] gem_seconds.gem_seconds_submission_id_fkey
alter table public.gem_seconds add constraint gem_seconds_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;

-- [constraint] gem_seconds.gem_seconds_user_id_fkey
alter table public.gem_seconds add constraint gem_seconds_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- [constraint] gem_seconds.gem_seconds_source_submission_id_fkey
alter table public.gem_seconds add constraint gem_seconds_source_submission_id_fkey FOREIGN KEY (source_submission_id) REFERENCES submissions(id) ON DELETE SET NULL;

-- [constraint] profiles.profiles_user_id_fkey
alter table public.profiles add constraint profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- [constraint] capture_log.capture_log_user_id_fkey
alter table public.capture_log add constraint capture_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- [constraint] leaderboard_scores.leaderboard_scores_user_id_fkey
alter table public.leaderboard_scores add constraint leaderboard_scores_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- [constraint] guides.guides_owner_fkey
alter table public.guides add constraint guides_owner_fkey FOREIGN KEY (owner) REFERENCES auth.users(id) ON DELETE SET NULL;

-- [constraint] guide_stops.guide_stops_guide_id_fkey
alter table public.guide_stops add constraint guide_stops_guide_id_fkey FOREIGN KEY (guide_id) REFERENCES guides(id) ON DELETE CASCADE;

-- [constraint] guide_stops.guide_stops_added_by_fkey
alter table public.guide_stops add constraint guide_stops_added_by_fkey FOREIGN KEY (added_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- [index] submissions_status_created_idx
CREATE INDEX submissions_status_created_idx ON public.submissions USING btree (status, created_at DESC);

-- [index] submissions_ai_status_idx
CREATE INDEX submissions_ai_status_idx ON public.submissions USING btree (ai_status) WHERE (status = 'pending'::text);

-- [index] reports_open_idx
CREATE INDEX reports_open_idx ON public.reports USING btree (status, target_id);

-- [index] submissions_merged_into_idx
CREATE INDEX submissions_merged_into_idx ON public.submissions USING btree (merged_into) WHERE (merged_into IS NOT NULL);

-- [index] submissions_dedup_geo_idx
CREATE INDEX submissions_dedup_geo_idx ON public.submissions USING btree (category, lat, lng) WHERE (status = ANY (ARRAY['approved'::text, 'pending'::text]));

-- [index] gem_seconds_submission_idx
CREATE INDEX gem_seconds_submission_idx ON public.gem_seconds USING btree (submission_id);

-- [index] gem_seconds_user_idx
CREATE INDEX gem_seconds_user_idx ON public.gem_seconds USING btree (user_id);

-- [index] capture_log_user_time_idx
CREATE INDEX capture_log_user_time_idx ON public.capture_log USING btree (user_id, created_at DESC);

-- [index] capture_log_user_pin_status_idx
CREATE INDEX capture_log_user_pin_status_idx ON public.capture_log USING btree (user_id, pin_id, status);

-- [index] guide_stops_guide_id_idx
CREATE INDEX guide_stops_guide_id_idx ON public.guide_stops USING btree (guide_id);

-- [index] guides_owner_idx
CREATE INDEX guides_owner_idx ON public.guides USING btree (owner);

-- [index] curated_descriptions_name_clean_idx
CREATE INDEX curated_descriptions_name_clean_idx ON public.curated_descriptions USING btree (name_clean);

-- [function] public.approve_submission(p_id uuid, p_note text)
CREATE OR REPLACE FUNCTION public.approve_submission(p_id uuid, p_note text DEFAULT NULL::text)
 RETURNS submissions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r     public.submissions;
  v_cat text;
begin
  -- Read the row's bucket and confirm it is pending. Not found => already
  -- decided or bad id, same as the live function's original guard.
  select category into v_cat
    from public.submissions
   where id = p_id
     and status = 'pending';

  if not found then
    raise exception 'No pending submission with id % (already decided, or bad id)', p_id;
  end if;

  -- #114 / #68 backstop: a NULL/blank/off-schema bucket cannot reach 'approved',
  -- or it renders as a neutral pin in NO category tab. review-submission fails
  -- OPEN (#3), so category-less rows are guaranteed once #gem-category is gone.
  if v_cat is null
     or v_cat not in ('park','shops','barsrest','history','art','lore') then
    raise exception
      'Submission % has no valid category (got %). Set it first, e.g.  update public.submissions set category=''history'' where id=%;  then approve.',
      p_id, coalesce(v_cat, 'null'), p_id
      using hint = 'Valid buckets: park, shops, barsrest, history, art';
  end if;

  update public.submissions
     set status      = 'approved',
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_note = p_note
   where id = p_id
     and status = 'pending'
  returning * into r;

  -- Preserved from the live function: guards a concurrent decide between the
  -- SELECT and the UPDATE.
  if r.id is null then
    raise exception 'No pending submission with id % (already decided, or bad id)', p_id;
  end if;
  return r;
end;
$function$
;

-- [function] public.reject_submission(p_id uuid, p_note text)
CREATE OR REPLACE FUNCTION public.reject_submission(p_id uuid, p_note text DEFAULT NULL::text)
 RETURNS submissions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.submissions;
begin
  update public.submissions
     set status      = 'rejected',
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_note = p_note
   where id = p_id
     and status = 'pending'
  returning * into r;

  if r.id is null then
    raise exception 'No pending submission with id % (already decided, or bad id)', p_id;
  end if;
  return r;
end;
$function$
;

-- [function] public.propagate_merged_status()
CREATE OR REPLACE FUNCTION public.propagate_merged_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.merged_into is null and new.status is distinct from old.status then
    update public.submissions
       set status = new.status
     where merged_into = new.id
       and status is distinct from new.status;
  end if;
  return null;
end $function$
;

-- [function] public.dismiss_report(p_report_id uuid, p_note text)
CREATE OR REPLACE FUNCTION public.dismiss_report(p_report_id uuid, p_note text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n integer;
begin
  update public.reports
     set status          = 'dismissed',
         resolved_at     = now(),
         resolved_by     = auth.uid(),
         resolution_note = p_note
   where id = p_report_id
     and status = 'open';

  get diagnostics n = row_count;
  if n = 0 then
    return 'no-op: no OPEN report with id ' || p_report_id || ' (already decided, or bad id)';
  end if;
  return 'dismissed ' || p_report_id || ' — pin returns within 5 minutes if this was the last open report holding it down';
end $function$
;

-- [function] public.resolve_report(p_report_id uuid, p_note text, p_force boolean)
CREATE OR REPLACE FUNCTION public.resolve_report(p_report_id uuid, p_note text DEFAULT NULL::text, p_force boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r          record;
  hidden     boolean;
  durable    boolean := false;
  bl         jsonb;
  n          integer;
begin
  select rp.*, m.suppresses
    into r
    from public.reports rp
    join public.report_reason_meta m on m.reason = rp.reason
   where rp.id = p_report_id
     and rp.status = 'open';

  if not found then
    return 'no-op: no OPEN report with id ' || p_report_id || ' (already decided, or bad id)';
  end if;

  select bool_or(reason_crossed) into hidden
    from public.report_target_state
   where target_id = r.target_id;
  hidden := coalesce(hidden, false);

  if r.suppresses and hidden and not p_force then
    if r.target_source = 'gem' then
      select (s.status is distinct from 'approved') into durable
        from public.submissions s where s.id::text = r.target_id;
      durable := coalesce(durable, false);
    else
      select (v.value)::jsonb into bl
        from public.shared_kv v where v.key = 'places:blocklist';
      durable := coalesce(bl -> 'ids', '[]'::jsonb) ? r.target_id;
    end if;

    if not durable then
      raise exception
        '#131 REFUSED: % is HIDDEN by open reports, and resolving this row would put it back on the map. Make the removal durable first — %  — then re-run, or pass p_force := true if you mean to un-hide it.',
        r.target_id,
        case when r.target_source = 'gem'
             then 'reject_submission(''' || r.target_id || ''', ''...'') for this gem'
             else 'add ''' || r.target_id || ''' to places:blocklist.ids in shared_kv'
        end;
    end if;
  end if;

  update public.reports
     set status          = 'resolved',
         resolved_at     = now(),
         resolved_by     = auth.uid(),
         resolution_note = p_note
   where id = p_report_id
     and status = 'open';

  get diagnostics n = row_count;
  if n = 0 then
    return 'no-op: report ' || p_report_id || ' changed status during this call';
  end if;

  return 'resolved ' || p_report_id
       || case when p_force and hidden
               then ' — FORCED past the durability guard; this pin will return within 5 minutes'
               else '' end;
end $function$
;

-- [function] public.profiles_guard()
CREATE OR REPLACE FUNCTION public.profiles_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is not null then
    new.status := coalesce(old.status, 'ok');
    new.user_id := coalesce(old.user_id, new.user_id);
    new.created_at := coalesce(old.created_at, now());
  end if;
  new.updated_at := now();
  if new.display_name is not null then
    new.display_name := nullif(btrim(new.display_name), '');
  end if;
  return new;
end $function$
;

-- [function] public.handle_new_user()
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare nm text;
begin
  nm := nullif(btrim(coalesce(
          new.raw_user_meta_data->>'display_name',
          new.raw_user_meta_data->>'name',
          nullif(btrim(coalesce(new.raw_user_meta_data->>'given_name','') || ' ' ||
                       left(coalesce(new.raw_user_meta_data->>'family_name',''), 1)), '')
        , '')), '');
  if nm is not null then nm := left(nm, 24); end if;

  -- Never let a bad metadata value abort the signup itself. A user who cannot
  -- create an account because their name failed a CHECK is a far worse failure
  -- than a user with no name, and the app treats a missing profile as normal.
  begin
    insert into public.profiles (user_id, display_name)
    values (new.id, nm)
    on conflict (user_id) do nothing;
  exception when others then
    insert into public.profiles (user_id, display_name)
    values (new.id, null)
    on conflict (user_id) do nothing;
  end;

  return new;
end $function$
;

-- [function] public.shared_kv_lock_owner()
CREATE OR REPLACE FUNCTION public.shared_kv_lock_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.owner := old.owner;   -- owner is set once, at INSERT, and never changes
  return new;
end
$function$
;

-- [function] public.merge_submissions(p_keep uuid, p_dup uuid, p_note text)
CREATE OR REPLACE FUNCTION public.merge_submissions(p_keep uuid, p_dup uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_keep public.submissions%rowtype;
  v_dup  public.submissions%rowtype;
begin
  if p_keep is null or p_dup is null then
    raise exception 'merge_submissions: keep and dup ids are both required';
  end if;
  if p_keep = p_dup then
    raise exception 'merge_submissions: keep and dup are the same id (%)', p_keep;
  end if;

  select * into v_keep from public.submissions where id = p_keep;
  if not found then
    raise exception 'merge_submissions: keep id % not found', p_keep;
  end if;

  select * into v_dup from public.submissions where id = p_dup;
  if not found then
    raise exception 'merge_submissions: dup id % not found', p_dup;
  end if;

  -- keep must be a canonical (never merge INTO a row that is itself merged).
  if v_keep.merged_into is not null then
    raise exception
      'merge_submissions: keep % is itself merged into % — merge into the canonical, not a merged row',
      p_keep, v_keep.merged_into;
  end if;

  -- dup must not already be merged somewhere else (idempotent if already into keep).
  if v_dup.merged_into is not null and v_dup.merged_into <> p_keep then
    raise exception
      'merge_submissions: dup % is already merged into % — unmerge it or pick that as keep',
      p_dup, v_dup.merged_into;
  end if;

  -- Re-home anything already folded INTO the dup, so no child pin is orphaned
  -- when the dup itself becomes a merged row.
  update public.submissions set merged_into = p_keep where merged_into = p_dup;

  -- Move the dup's own vouches onto keep. Drop any that would collide with an
  -- existing keep-vouch (gem_seconds is unique on submission_id,user_id).
  delete from public.gem_seconds gs
   where gs.submission_id = p_dup
     and exists (
       select 1 from public.gem_seconds k
        where k.submission_id = p_keep and k.user_id = gs.user_id
     );
  update public.gem_seconds set submission_id = p_keep where submission_id = p_dup;

  -- Record the dup's OWN submitter as a vouch on keep — the second-submission
  -- signal #31 gathers at submit time. Skip a self-second and a null submitter,
  -- exactly like review-submission's findDuplicate branch (a person submitting
  -- their own place twice is not a vouch).
  if v_dup.submitted_by is not null
     and v_dup.submitted_by is distinct from v_keep.submitted_by then
    insert into public.gem_seconds (submission_id, user_id, source_submission_id)
    values (p_keep, v_dup.submitted_by, p_dup)
    on conflict (submission_id, user_id) do nothing;
  end if;

  -- Fold the dup: it mirrors keep's status and carries merged_into as the sole
  -- marker (every map read filters merged_into IS NULL). Nothing is deleted, so
  -- the audit trail is intact and the merge is reversible (set merged_into=null).
  update public.submissions
     set merged_into = p_keep,
         status      = v_keep.status
   where id = p_dup;

  raise notice 'merge_submissions: folded % ("%") into % ("%"). note: %',
    p_dup, coalesce(v_dup.name, '?'), p_keep, coalesce(v_keep.name, '?'),
    coalesce(p_note, '(none)');
end;
$function$
;

-- [function] public.gem_seconds_counts(p_ids uuid[])
CREATE OR REPLACE FUNCTION public.gem_seconds_counts(p_ids uuid[])
 RETURNS TABLE(submission_id uuid, n integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select gs.submission_id, count(*)::int as n
    from public.gem_seconds gs
   where gs.submission_id = any (p_ids)
   group by gs.submission_id;
$function$
;

-- [function] public.set_leaderboard_visibility(p_opt_out boolean)
CREATE OR REPLACE FUNCTION public.set_leaderboard_visibility(p_opt_out boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.leaderboard_scores (user_id, opted_out, updated_at)
  values (auth.uid(), p_opt_out, now())
  on conflict (user_id) do update
    set opted_out = excluded.opted_out, updated_at = now();
end;
$function$
;

-- [function] public.leaderboard_top(p_scope text, p_lat double precision, p_lng double precision, p_radius_m double precision, p_limit integer, p_metric text)
CREATE OR REPLACE FUNCTION public.leaderboard_top(p_scope text DEFAULT 'global'::text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_radius_m double precision DEFAULT 50000, p_limit integer DEFAULT 100, p_metric text DEFAULT 'stamps'::text)
 RETURNS TABLE(rank bigint, display_name text, value numeric, is_me boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with gems as (
    select submitted_by as user_id, count(*)::numeric as n
    from public.submissions
    where status = 'approved' and submitted_by is not null
    group by submitted_by
  ),
  elig as (
    select
      p.user_id,
      p.display_name,
      case p_metric
        when 'distance' then coalesce(s.verified_distance_m, 0)::numeric
        when 'gems'     then coalesce(g.n, 0)
        else                 coalesce(s.distinct_pins, 0)::numeric
      end as value,
      /* #389 coarse location: a 0.2° grid cell, never the raw point */ round(s.last_lat / 0.2) * 0.2 as last_lat, round(s.last_lng / 0.2) * 0.2 as last_lng
    from public.profiles p
    left join public.leaderboard_scores s on s.user_id = p.user_id
    left join gems g on g.user_id = p.user_id
    where coalesce(p.status, 'ok') = 'ok'
      and coalesce(p.display_name, '') <> ''
      and coalesce(s.opted_out, false) = false
  )
  select
    row_number() over (order by e.value desc, e.user_id) as rank,
    e.display_name,
    e.value,
    (e.user_id = auth.uid()) as is_me
  from elig e
  where e.value > 0
    and (
      p_scope <> 'local'
      or (
        e.last_lat is not null and e.last_lng is not null
        and p_lat is not null and p_lng is not null
        and 6371000 * 2 * asin( least(1, sqrt(
              power(sin(radians(e.last_lat - p_lat) / 2), 2)
              + cos(radians(p_lat)) * cos(radians(e.last_lat))
                * power(sin(radians(e.last_lng - p_lng) / 2), 2)
            )) ) <= p_radius_m
      )
    )
  order by e.value desc, e.user_id
  limit greatest(1, least(p_limit, 500));
$function$
;

-- [function] public.leaderboard_me()
CREATE OR REPLACE FUNCTION public.leaderboard_me()
 RETURNS TABLE(stamps integer, distance_m double precision, gems integer, rank_stamps bigint, rank_distance bigint, rank_gems bigint, opted_out boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with gemcounts as (
    select submitted_by as user_id, count(*)::int as n
    from public.submissions
    where status = 'approved' and submitted_by is not null
    group by submitted_by
  ),
  elig as (
    select
      p.user_id,
      coalesce(s.distinct_pins, 0)        as pins,
      coalesce(s.verified_distance_m, 0)  as dist,
      coalesce(gc.n, 0)                   as gm
    from public.profiles p
    left join public.leaderboard_scores s on s.user_id = p.user_id
    left join gemcounts gc on gc.user_id = p.user_id
    where coalesce(p.status, 'ok') = 'ok'
      and coalesce(p.display_name, '') <> ''
      and coalesce(s.opted_out, false) = false
  ),
  ranked as (
    select
      user_id, pins, dist, gm,
      case when pins > 0 then row_number() over (order by pins desc, user_id) end as rk_pins,
      case when dist > 0 then row_number() over (order by dist desc, user_id) end as rk_dist,
      case when gm   > 0 then row_number() over (order by gm   desc, user_id) end as rk_gm
    from elig
  ),
  mescore as (
    select opted_out from public.leaderboard_scores where user_id = auth.uid()
  )
  select
    coalesce((select pins from ranked where user_id = auth.uid()), 0)::int,
    coalesce((select dist from ranked where user_id = auth.uid()), 0)::double precision,
    coalesce((select gm   from ranked where user_id = auth.uid()), 0)::int,
    (select rk_pins from ranked where user_id = auth.uid()),
    (select rk_dist from ranked where user_id = auth.uid()),
    (select rk_gm   from ranked where user_id = auth.uid()),
    coalesce((select opted_out from mescore), false);
$function$
;

-- [function] public.guides_guard()
CREATE OR REPLACE FUNCTION public.guides_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.owner is distinct from old.owner then
    new.owner := old.owner;            -- freeze ownership
  end if;
  if new.code is distinct from old.code then
    new.code := old.code;              -- freeze the redeem code (a persisted key)
  end if;
  new.updated_at := now();
  return new;
end;
$function$
;

-- [function] public.guide_stops_guard()
CREATE OR REPLACE FUNCTION public.guide_stops_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.added_by is distinct from old.added_by then
    new.added_by := old.added_by;      -- freeze authorship of a stop
  end if;
  if new.guide_id is distinct from old.guide_id then
    new.guide_id := old.guide_id;      -- a stop cannot be moved between guides
  end if;
  return new;
end;
$function$
;

-- [function] public.lock_resolved_desc_columns()
CREATE OR REPLACE FUNCTION public.lock_resolved_desc_columns()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- auth.role() reads the JWT role claim (like auth.uid() in the #135
  -- trigger). It is 'service_role' for the resolver, 'anon'/'authenticated'
  -- for the browser, and NULL for a direct SQL-editor connection — so this
  -- blocks ONLY the two browser roles and lets the server + operator through.
  if auth.role() in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.resolved_description := null;
      new.resolved_source := null;
    else
      new.resolved_description := old.resolved_description;
      new.resolved_source := old.resolved_source;
    end if;
  end if;
  return new;
end;
$function$
;

-- [function] public.display_name_is_reserved(n text)
CREATE OR REPLACE FUNCTION public.display_name_is_reserved(n text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  select n is not null and exists (
    select 1
    from unnest(array[
      regexp_replace(lower(n), '[^a-z]', '', 'g'),
      regexp_replace(translate(lower(n), '01345789', 'oieastbg'), '[^a-z]', '', 'g'),
      regexp_replace(translate(lower(n), '01345789', 'oleastbg'), '[^a-z]', '', 'g')
    ]) as f(form)
    where f.form = any (array[
      'roaminator','roaminatorapp','roaminatorteam','roaminatorofficial','roaminatorstaff',
      'nahgoo','nahgooapp','nahgooteam','nahgooofficial','nahgoofficial','nahgoostaff',
      'stowmark','stowmarkapp','stowmarkteam','stowmarkofficial','stowmarkstaff',
      'localy','localyapp','localyteam','localyofficial','localystaff',
      'admin','administrator','moderator','mod','staff','support','helpdesk',
      'official','verified','verifiedlocal','team','system','root','owner'
    ])
  );
$function$
;

-- [function] public.display_name_fold(n text)
CREATE OR REPLACE FUNCTION public.display_name_fold(n text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO ''
AS $function$
  select normalize(extensions.unaccent('extensions.unaccent'::regdictionary, n), NFKD)
$function$
;

-- [function] public.display_name_is_reserved_folded(n text)
CREATE OR REPLACE FUNCTION public.display_name_is_reserved_folded(n text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO ''
AS $function$
  select public.display_name_is_reserved(n)
      or public.display_name_is_reserved(public.display_name_fold(n))
$function$
;

-- [function] public.merge_carry_credit()
CREATE OR REPLACE FUNCTION public.merge_carry_credit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  -- #390: only act when merged_into actually changed
  if tg_op = 'UPDATE' and old.merged_into is not distinct from new.merged_into then
    return null;
  end if;
  if new.merged_into is null
     or new.submitted_by is null
     or new.merged_into = new.id
     or new.status::text = 'rejected' then
    return null;
  end if;

  update public.submissions k
     set submitted_by = new.submitted_by
   where k.id = new.merged_into
     and k.submitted_by is null;

  return null;
end;
$function$
;

-- [function] public.promote_seed_description()
CREATE OR REPLACE FUNCTION public.promote_seed_description()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  -- #392: loaders only (service role / editor); client inserts are untouched
  if current_user in ('anon', 'authenticated') then
    return new;
  end if;
  if new.resolved_source is null
     and coalesce(new.source, '') like 'seed:%'
     and coalesce(btrim(new.description), '') <> '' then
    new.resolved_description := new.description;
    new.resolved_source      := 'wiki';
  end if;
  return new;
end;
$function$
;

-- [constraint] submissions.submissions_ai_status_check
alter table public.submissions add constraint submissions_ai_status_check CHECK (((ai_status IS NULL) OR (ai_status = ANY (ARRAY['ok'::text, 'http_error'::text, 'parse_error'::text, 'bad_decision'::text, 'network_error'::text]))));

-- [constraint] report_reason_meta.report_reason_meta_threshold_ck
alter table public.report_reason_meta add constraint report_reason_meta_threshold_ck CHECK (((suppresses AND (threshold IS NOT NULL) AND (threshold >= 1)) OR ((NOT suppresses) AND (threshold IS NULL))));

-- [constraint] profiles.profiles_display_name_len
alter table public.profiles add constraint profiles_display_name_len CHECK (((display_name IS NULL) OR ((char_length(display_name) >= 2) AND (char_length(display_name) <= 24))));

-- [constraint] profiles.profiles_display_name_chars
alter table public.profiles add constraint profiles_display_name_chars CHECK (((display_name IS NULL) OR (display_name ~ '^[[:alnum:] ''.\-]+$'::text)));

-- [constraint] profiles.profiles_status_vals
alter table public.profiles add constraint profiles_status_vals CHECK ((status = ANY (ARRAY['ok'::text, 'blocked'::text])));

-- [constraint] profiles.profiles_display_name_reserved
alter table public.profiles add constraint profiles_display_name_reserved CHECK (((display_name IS NULL) OR (NOT display_name_is_reserved(display_name))));

-- [constraint] profiles.profiles_display_name_reserved_folded
alter table public.profiles add constraint profiles_display_name_reserved_folded CHECK (((display_name IS NULL) OR (NOT display_name_is_reserved_folded(display_name))));

-- [view] pending_review
create or replace view public.pending_review as
 SELECT id,
    created_at,
    name,
    description,
    category,
    lat,
    lng,
    ai_decision,
    ai_reason,
        CASE
            WHEN ai_status IS NULL THEN
            CASE
                WHEN ai_decision IS NULL THEN 'AI never ran (pre-telemetry row)'::text
                WHEN ai_decision = 'review'::text THEN 'AI unsure - wants a human (pre-telemetry)'::text
                WHEN ai_decision = 'approve'::text THEN 'AI approved but row still pending'::text
                WHEN ai_decision = 'reject'::text THEN 'AI flagged - rejected'::text
                ELSE 'AI: '::text || ai_decision
            END
            WHEN ai_status = 'ok'::text THEN
            CASE
                WHEN ai_decision = 'review'::text THEN 'AI unsure - wants a human'::text
                WHEN ai_decision = 'approve'::text THEN 'AI approved but row still pending'::text
                WHEN ai_decision = 'reject'::text THEN 'AI flagged - rejected'::text
                ELSE 'AI: '::text || COALESCE(ai_decision, '?'::text)
            END
            WHEN ai_status = 'http_error'::text THEN ((('AI FAILED - Gemini HTTP '::text || COALESCE(ai_http_status::text, '?'::text)) || ' (model '::text) || COALESCE(ai_model, '?'::text)) || ')'::text
            WHEN ai_status = 'parse_error'::text THEN 'AI FAILED - unparseable model output'::text
            WHEN ai_status = 'bad_decision'::text THEN 'AI FAILED - off-schema decision'::text
            WHEN ai_status = 'network_error'::text THEN 'AI FAILED - never reached Gemini'::text
            ELSE 'AI status: '::text || ai_status
        END ||
        CASE
            WHEN ai_model_source = 'fallback'::text THEN '  [MODEL FROM FALLBACK - GEMINI_MODEL secret is unset]'::text
            ELSE ''::text
        END AS why_here,
    (('https://www.google.com/maps?q='::text || lat) || ','::text) || lng AS map_link,
    submitted_by,
    ai_status,
    ai_http_status,
    ai_model,
    ai_model_source,
    ai_confidence,
    ai_reviewed_at
   FROM submissions s
  WHERE status = 'pending'::text
  ORDER BY (
        CASE
            WHEN ai_decision = 'reject'::text THEN 0
            WHEN ai_decision IS NULL THEN 1
            ELSE 2
        END), created_at;

-- [view] submission_cleanup_review
create or replace view public.submission_cleanup_review with (security_invoker=true) as
 SELECT id,
    status,
    category,
    name AS name_raw,
    name_clean,
    name_clean IS NOT NULL AS name_changed,
    description AS description_raw,
    description_clean,
    description_clean IS NOT NULL AS description_changed,
    ai_status,
    created_at
   FROM submissions s
  ORDER BY (name_clean IS NOT NULL OR description_clean IS NOT NULL) DESC, created_at DESC;

-- [view] report_target_state
create or replace view public.report_target_state as
 SELECT r.target_id,
    r.reason,
    count(DISTINCT r.reported_by) AS distinct_reporters,
    m.suppresses,
    m.threshold,
    m.suppresses AND count(DISTINCT r.reported_by) >= m.threshold AS reason_crossed
   FROM reports r
     JOIN report_reason_meta m ON m.reason = r.reason
  WHERE r.status = 'open'::text
  GROUP BY r.target_id, r.reason, m.suppresses, m.threshold;

-- [view] reports_open
create or replace view public.reports_open as
 SELECT r.id AS report_id,
    r.created_at,
    round(EXTRACT(epoch FROM now() - r.created_at) / 3600.0, 1) AS age_hours,
    r.reason,
    r.target_source,
    r.target_id,
    r.target_name,
    r.note,
    COALESCE(ts.distinct_reporters, 1::bigint) AS reporters_this_reason,
    ts.threshold,
    COALESCE(hid.is_hidden, false) AS currently_suppressed,
        CASE
            WHEN COALESCE(hid.is_hidden, false) THEN 'HIDDEN NOW — dismiss_report() puts it back; resolve_report() also puts it back unless the removal is made durable first'::text
            WHEN ts.suppresses AND ts.distinct_reporters >= (ts.threshold - 1) THEN 'one more report hides this pin'::text
            WHEN r.reason = 'unsafe'::text THEN 'unsafe — human only, never moves the map'::text
            WHEN ts.suppresses THEN 'suppressing reason, below threshold'::text
            ELSE 'informational — no automatic effect'::text
        END AS why_here,
        CASE
            WHEN r.lat IS NOT NULL AND r.lng IS NOT NULL THEN (('https://www.google.com/maps?q='::text || r.lat) || ','::text) || r.lng
            ELSE NULL::text
        END AS map_link,
    r.reported_by
   FROM reports r
     LEFT JOIN report_target_state ts ON ts.target_id = r.target_id AND ts.reason = r.reason
     LEFT JOIN ( SELECT report_target_state.target_id,
            bool_or(report_target_state.reason_crossed) AS is_hidden
           FROM report_target_state
          GROUP BY report_target_state.target_id) hid ON hid.target_id = r.target_id
  WHERE r.status = 'open'::text
  ORDER BY (
        CASE
            WHEN COALESCE(hid.is_hidden, false) THEN 1
            WHEN ts.suppresses AND ts.distinct_reporters >= (ts.threshold - 1) THEN 2
            WHEN r.reason = 'unsafe'::text THEN 3
            WHEN ts.suppresses THEN 4
            ELSE 5
        END), r.created_at;

-- [trigger] public.submissions.submissions_propagate_merged_status
CREATE TRIGGER submissions_propagate_merged_status AFTER UPDATE OF status ON submissions FOR EACH ROW EXECUTE FUNCTION propagate_merged_status();

-- [trigger] public.profiles.profiles_guard_trg
CREATE TRIGGER profiles_guard_trg BEFORE INSERT OR UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION profiles_guard();

-- [trigger] auth.users.on_auth_user_created
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- [trigger] public.shared_kv.shared_kv_lock_owner
CREATE TRIGGER shared_kv_lock_owner BEFORE UPDATE ON shared_kv FOR EACH ROW EXECUTE FUNCTION shared_kv_lock_owner();

-- [trigger] public.guides.guides_guard_trg
CREATE TRIGGER guides_guard_trg BEFORE UPDATE ON guides FOR EACH ROW EXECUTE FUNCTION guides_guard();

-- [trigger] public.guide_stops.guide_stops_guard_trg
CREATE TRIGGER guide_stops_guard_trg BEFORE UPDATE ON guide_stops FOR EACH ROW EXECUTE FUNCTION guide_stops_guard();

-- [trigger] public.submissions.lock_resolved_desc_columns
CREATE TRIGGER lock_resolved_desc_columns BEFORE INSERT OR UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION lock_resolved_desc_columns();

-- [trigger] public.submissions.submissions_merge_carry_credit
CREATE TRIGGER submissions_merge_carry_credit AFTER INSERT OR UPDATE OF merged_into ON submissions FOR EACH ROW EXECUTE FUNCTION merge_carry_credit();

-- [trigger] public.submissions.submissions_promote_seed_description
CREATE TRIGGER submissions_promote_seed_description BEFORE INSERT ON submissions FOR EACH ROW EXECUTE FUNCTION promote_seed_description();

-- [rls] submissions
alter table public.submissions enable row level security;

-- [rls] hunts
alter table public.hunts enable row level security;

-- [rls] hunt_points
alter table public.hunt_points enable row level security;

-- [rls] progress
alter table public.progress enable row level security;

-- [rls] user_state
alter table public.user_state enable row level security;

-- [rls] shared_kv
alter table public.shared_kv enable row level security;

-- [rls] reports
alter table public.reports enable row level security;

-- [rls] gem_seconds
alter table public.gem_seconds enable row level security;

-- [rls] report_reason_meta
alter table public.report_reason_meta enable row level security;

-- [rls] profiles
alter table public.profiles enable row level security;

-- [rls] capture_log
alter table public.capture_log enable row level security;

-- [rls] leaderboard_scores
alter table public.leaderboard_scores enable row level security;

-- [rls] guides
alter table public.guides enable row level security;

-- [rls] guide_stops
alter table public.guide_stops enable row level security;

-- [rls] curated_descriptions
alter table public.curated_descriptions enable row level security;

-- [policy] public.gem_seconds.read own vouches and vouches on my pins
create policy "read own vouches and vouches on my pins" on public.gem_seconds as permissive for select to authenticated
  using (((user_id = auth.uid()) OR (submission_id IN ( SELECT s.id
   FROM submissions s
  WHERE (s.submitted_by = auth.uid())))));

-- [policy] public.guide_stops.guide_stops_delete
create policy guide_stops_delete on public.guide_stops as permissive for delete to public
  using ((EXISTS ( SELECT 1
   FROM guides g
  WHERE ((g.id = guide_stops.guide_id) AND ((g.owner = auth.uid()) OR (g.owner IS NULL) OR ((g.editable = true) AND (guide_stops.added_by = auth.uid())))))));

-- [policy] public.guide_stops.guide_stops_insert
create policy guide_stops_insert on public.guide_stops as permissive for insert to public
  with check ((EXISTS ( SELECT 1
   FROM guides g
  WHERE ((g.id = guide_stops.guide_id) AND ((g.owner = auth.uid()) OR (g.owner IS NULL) OR (g.editable = true))))));

-- [policy] public.guide_stops.guide_stops_select
create policy guide_stops_select on public.guide_stops as permissive for select to public
  using (true);

-- [policy] public.guide_stops.guide_stops_update
create policy guide_stops_update on public.guide_stops as permissive for update to public
  using ((EXISTS ( SELECT 1
   FROM guides g
  WHERE ((g.id = guide_stops.guide_id) AND ((g.owner = auth.uid()) OR (g.owner IS NULL) OR (g.editable = true))))));

-- [policy] public.guides.guides_insert
create policy guides_insert on public.guides as permissive for insert to public
  with check ((owner = auth.uid()));

-- [policy] public.guides.guides_select
create policy guides_select on public.guides as permissive for select to public
  using (true);

-- [policy] public.guides.guides_update
create policy guides_update on public.guides as permissive for update to public
  using (((owner = auth.uid()) OR (owner IS NULL) OR (editable = true)));

-- [policy] public.hunt_points.owner writes hunt points
create policy "owner writes hunt points" on public.hunt_points as permissive for all to public
  using ((EXISTS ( SELECT 1
   FROM hunts
  WHERE ((hunts.id = hunt_points.hunt_id) AND (hunts.created_by = auth.uid())))));

-- [policy] public.hunt_points.read all hunt points
create policy "read all hunt points" on public.hunt_points as permissive for select to public
  using (true);

-- [policy] public.hunts.delete own hunts
create policy "delete own hunts" on public.hunts as permissive for delete to public
  using ((auth.uid() = created_by));

-- [policy] public.hunts.insert own hunts
create policy "insert own hunts" on public.hunts as permissive for insert to public
  with check ((auth.uid() = created_by));

-- [policy] public.hunts.read all hunts
create policy "read all hunts" on public.hunts as permissive for select to public
  using (true);

-- [policy] public.hunts.update own hunts
create policy "update own hunts" on public.hunts as permissive for update to public
  using ((auth.uid() = created_by));

-- [policy] public.profiles.profiles insert
create policy "profiles insert" on public.profiles as permissive for insert to public
  with check ((user_id = auth.uid()));

-- [policy] public.profiles.profiles read
create policy "profiles read" on public.profiles as permissive for select to public
  using (true);

-- [policy] public.profiles.profiles update
create policy "profiles update" on public.profiles as permissive for update to public
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

-- [policy] public.progress.manage own progress
create policy "manage own progress" on public.progress as permissive for all to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- [policy] public.shared_kv.shared_kv_guide_insert
create policy shared_kv_guide_insert on public.shared_kv as permissive for insert to authenticated
  with check (((key ~ '^hunt-code:[A-HJ-NP-Z2-9]{6}$'::text) AND (owner = auth.uid())));

-- [policy] public.shared_kv.shared_kv_guide_update
create policy shared_kv_guide_update on public.shared_kv as permissive for update to authenticated
  using (((key ~ '^hunt-code:[A-HJ-NP-Z2-9]{6}$'::text) AND ((owner = auth.uid()) OR (owner IS NULL) OR ((((value)::jsonb ->> 'editable'::text))::boolean IS TRUE))))
  with check (((key ~ '^hunt-code:[A-HJ-NP-Z2-9]{6}$'::text) AND ((owner = auth.uid()) OR (owner IS NULL) OR ((((value)::jsonb ->> 'editable'::text))::boolean IS TRUE))));

-- [policy] public.shared_kv.shared_kv_public_read
create policy shared_kv_public_read on public.shared_kv as permissive for select to public
  using (true);

-- [policy] public.submissions.insert own submissions
create policy "insert own submissions" on public.submissions as permissive for insert to public
  with check ((auth.uid() = submitted_by));

-- [policy] public.submissions.read approved submissions
create policy "read approved submissions" on public.submissions as permissive for select to public
  using ((status = 'approved'::text));

-- [policy] public.submissions.read own submissions
create policy "read own submissions" on public.submissions as permissive for select to public
  using ((auth.uid() = submitted_by));

-- [policy] public.user_state.own state delete
create policy "own state delete" on public.user_state as permissive for delete to public
  using ((auth.uid() = user_id));

-- [policy] public.user_state.own state insert
create policy "own state insert" on public.user_state as permissive for insert to public
  with check ((auth.uid() = user_id));

-- [policy] public.user_state.own state select
create policy "own state select" on public.user_state as permissive for select to public
  using ((auth.uid() = user_id));

-- [policy] public.user_state.own state update
create policy "own state update" on public.user_state as permissive for update to public
  using ((auth.uid() = user_id));

-- [policy] storage.objects.capture-photos owner delete
create policy "capture-photos owner delete" on storage.objects as permissive for delete to authenticated
  using (((bucket_id = 'capture-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

-- [policy] storage.objects.capture-photos owner insert
create policy "capture-photos owner insert" on storage.objects as permissive for insert to authenticated
  with check (((bucket_id = 'capture-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

-- [policy] storage.objects.capture-photos owner read
create policy "capture-photos owner read" on storage.objects as permissive for select to authenticated
  using (((bucket_id = 'capture-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

-- [policy] storage.objects.capture-photos owner update
create policy "capture-photos owner update" on storage.objects as permissive for update to authenticated
  using (((bucket_id = 'capture-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)))
  with check (((bucket_id = 'capture-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

-- [grant] submissions
revoke all on table public.submissions from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, trigger, truncate on table public.submissions to anon;
grant delete, insert, maintain, references, trigger, truncate on table public.submissions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.submissions to service_role;

-- [grant] hunts
revoke all on table public.hunts from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hunts to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hunts to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hunts to service_role;

-- [grant] hunt_points
revoke all on table public.hunt_points from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hunt_points to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hunt_points to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hunt_points to service_role;

-- [grant] progress
revoke all on table public.progress from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.progress to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.progress to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.progress to service_role;

-- [grant] user_state
revoke all on table public.user_state from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.user_state to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.user_state to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.user_state to service_role;

-- [grant] shared_kv
revoke all on table public.shared_kv from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shared_kv to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shared_kv to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shared_kv to service_role;

-- [grant] pending_review
revoke all on table public.pending_review from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.pending_review to service_role;

-- [grant] submission_cleanup_review
revoke all on table public.submission_cleanup_review from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.submission_cleanup_review to service_role;

-- [grant] reports
revoke all on table public.reports from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.reports to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.reports to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.reports to service_role;

-- [grant] gem_seconds
revoke all on table public.gem_seconds from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.gem_seconds to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.gem_seconds to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.gem_seconds to service_role;

-- [grant] report_reason_meta
revoke all on table public.report_reason_meta from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.report_reason_meta to service_role;

-- [grant] report_target_state
revoke all on table public.report_target_state from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.report_target_state to service_role;

-- [grant] reports_open
revoke all on table public.reports_open from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.reports_open to service_role;

-- [grant] profiles
revoke all on table public.profiles from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.profiles to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.profiles to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.profiles to service_role;

-- [grant] capture_log_id_seq
revoke all on sequence public.capture_log_id_seq from public, anon, authenticated, service_role;
grant select, update, usage on sequence public.capture_log_id_seq to anon;
grant select, update, usage on sequence public.capture_log_id_seq to authenticated;
grant select, update, usage on sequence public.capture_log_id_seq to service_role;

-- [grant] capture_log
revoke all on table public.capture_log from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.capture_log to service_role;

-- [grant] leaderboard_scores
revoke all on table public.leaderboard_scores from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.leaderboard_scores to service_role;

-- [grant] guides
revoke all on table public.guides from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.guides to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.guides to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.guides to service_role;

-- [grant] guide_stops
revoke all on table public.guide_stops from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.guide_stops to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.guide_stops to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.guide_stops to service_role;

-- [grant] curated_descriptions
revoke all on table public.curated_descriptions from public, anon, authenticated, service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.curated_descriptions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.curated_descriptions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.curated_descriptions to service_role;

-- [column grant] submissions.category
grant select (category) on table public.submissions to anon;
grant select (category) on table public.submissions to authenticated;

-- [column grant] submissions.created_at
grant select (created_at) on table public.submissions to anon;
grant select (created_at) on table public.submissions to authenticated;

-- [column grant] submissions.description
grant select (description) on table public.submissions to anon;
grant select (description) on table public.submissions to authenticated;

-- [column grant] submissions.description_clean
grant select (description_clean) on table public.submissions to anon;
grant select (description_clean) on table public.submissions to authenticated;

-- [column grant] submissions.id
grant select (id) on table public.submissions to anon;
grant select (id) on table public.submissions to authenticated;

-- [column grant] submissions.lat
grant select (lat) on table public.submissions to anon;
grant select (lat) on table public.submissions to authenticated;

-- [column grant] submissions.lng
grant select (lng) on table public.submissions to anon;
grant select (lng) on table public.submissions to authenticated;

-- [column grant] submissions.merged_into
grant select (merged_into) on table public.submissions to anon;
grant select (merged_into) on table public.submissions to authenticated;

-- [column grant] submissions.name
grant select (name) on table public.submissions to anon;
grant select (name) on table public.submissions to authenticated;

-- [column grant] submissions.name_clean
grant select (name_clean) on table public.submissions to anon;
grant select (name_clean) on table public.submissions to authenticated;

-- [column grant] submissions.resolved_description
grant select (resolved_description) on table public.submissions to anon;
grant select (resolved_description) on table public.submissions to authenticated;

-- [column grant] submissions.resolved_source
grant select (resolved_source) on table public.submissions to anon;
grant select (resolved_source) on table public.submissions to authenticated;

-- [column grant] submissions.status
grant select (status) on table public.submissions to anon;
grant select (status) on table public.submissions to authenticated;

-- [column grant] submissions.submitted_by
grant select (submitted_by) on table public.submissions to anon;
grant select (submitted_by) on table public.submissions to authenticated;

-- [function grant] public.approve_submission(p_id uuid, p_note text)
revoke all on function public.approve_submission(p_id uuid, p_note text) from public, anon, authenticated, service_role;
grant execute on function public.approve_submission(p_id uuid, p_note text) to service_role;

-- [function grant] public.reject_submission(p_id uuid, p_note text)
revoke all on function public.reject_submission(p_id uuid, p_note text) from public, anon, authenticated, service_role;
grant execute on function public.reject_submission(p_id uuid, p_note text) to service_role;

-- [function grant] public.propagate_merged_status()
revoke all on function public.propagate_merged_status() from public, anon, authenticated, service_role;
grant execute on function public.propagate_merged_status() to service_role;

-- [function grant] public.dismiss_report(p_report_id uuid, p_note text)
revoke all on function public.dismiss_report(p_report_id uuid, p_note text) from public, anon, authenticated, service_role;
grant execute on function public.dismiss_report(p_report_id uuid, p_note text) to service_role;

-- [function grant] public.resolve_report(p_report_id uuid, p_note text, p_force boolean)
revoke all on function public.resolve_report(p_report_id uuid, p_note text, p_force boolean) from public, anon, authenticated, service_role;
grant execute on function public.resolve_report(p_report_id uuid, p_note text, p_force boolean) to service_role;

-- [function grant] public.profiles_guard()
revoke all on function public.profiles_guard() from public, anon, authenticated, service_role;
grant execute on function public.profiles_guard() to service_role;

-- [function grant] public.handle_new_user()
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
grant execute on function public.handle_new_user() to service_role;

-- [function grant] public.shared_kv_lock_owner()
revoke all on function public.shared_kv_lock_owner() from public, anon, authenticated, service_role;
grant execute on function public.shared_kv_lock_owner() to public;
grant execute on function public.shared_kv_lock_owner() to anon;
grant execute on function public.shared_kv_lock_owner() to authenticated;
grant execute on function public.shared_kv_lock_owner() to service_role;

-- [function grant] public.merge_submissions(p_keep uuid, p_dup uuid, p_note text)
revoke all on function public.merge_submissions(p_keep uuid, p_dup uuid, p_note text) from public, anon, authenticated, service_role;
grant execute on function public.merge_submissions(p_keep uuid, p_dup uuid, p_note text) to service_role;

-- [function grant] public.gem_seconds_counts(p_ids uuid[])
revoke all on function public.gem_seconds_counts(p_ids uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.gem_seconds_counts(p_ids uuid[]) to public;
grant execute on function public.gem_seconds_counts(p_ids uuid[]) to anon;
grant execute on function public.gem_seconds_counts(p_ids uuid[]) to authenticated;
grant execute on function public.gem_seconds_counts(p_ids uuid[]) to service_role;

-- [function grant] public.set_leaderboard_visibility(p_opt_out boolean)
revoke all on function public.set_leaderboard_visibility(p_opt_out boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_leaderboard_visibility(p_opt_out boolean) to authenticated;
grant execute on function public.set_leaderboard_visibility(p_opt_out boolean) to service_role;

-- [function grant] public.leaderboard_top(p_scope text, p_lat double precision, p_lng double precision, p_radius_m double precision, p_limit integer, p_metric text)
revoke all on function public.leaderboard_top(p_scope text, p_lat double precision, p_lng double precision, p_radius_m double precision, p_limit integer, p_metric text) from public, anon, authenticated, service_role;
grant execute on function public.leaderboard_top(p_scope text, p_lat double precision, p_lng double precision, p_radius_m double precision, p_limit integer, p_metric text) to authenticated;
grant execute on function public.leaderboard_top(p_scope text, p_lat double precision, p_lng double precision, p_radius_m double precision, p_limit integer, p_metric text) to service_role;

-- [function grant] public.leaderboard_me()
revoke all on function public.leaderboard_me() from public, anon, authenticated, service_role;
grant execute on function public.leaderboard_me() to authenticated;
grant execute on function public.leaderboard_me() to service_role;

-- [function grant] public.guides_guard()
revoke all on function public.guides_guard() from public, anon, authenticated, service_role;
grant execute on function public.guides_guard() to public;
grant execute on function public.guides_guard() to anon;
grant execute on function public.guides_guard() to authenticated;
grant execute on function public.guides_guard() to service_role;

-- [function grant] public.guide_stops_guard()
revoke all on function public.guide_stops_guard() from public, anon, authenticated, service_role;
grant execute on function public.guide_stops_guard() to public;
grant execute on function public.guide_stops_guard() to anon;
grant execute on function public.guide_stops_guard() to authenticated;
grant execute on function public.guide_stops_guard() to service_role;

-- [function grant] public.lock_resolved_desc_columns()
revoke all on function public.lock_resolved_desc_columns() from public, anon, authenticated, service_role;
grant execute on function public.lock_resolved_desc_columns() to public;
grant execute on function public.lock_resolved_desc_columns() to anon;
grant execute on function public.lock_resolved_desc_columns() to authenticated;
grant execute on function public.lock_resolved_desc_columns() to service_role;

-- [function grant] public.display_name_is_reserved(n text)
revoke all on function public.display_name_is_reserved(n text) from public, anon, authenticated, service_role;
grant execute on function public.display_name_is_reserved(n text) to anon;
grant execute on function public.display_name_is_reserved(n text) to authenticated;
grant execute on function public.display_name_is_reserved(n text) to service_role;

-- [function grant] public.display_name_fold(n text)
revoke all on function public.display_name_fold(n text) from public, anon, authenticated, service_role;
grant execute on function public.display_name_fold(n text) to public;
grant execute on function public.display_name_fold(n text) to anon;
grant execute on function public.display_name_fold(n text) to authenticated;
grant execute on function public.display_name_fold(n text) to service_role;

-- [function grant] public.display_name_is_reserved_folded(n text)
revoke all on function public.display_name_is_reserved_folded(n text) from public, anon, authenticated, service_role;
grant execute on function public.display_name_is_reserved_folded(n text) to public;
grant execute on function public.display_name_is_reserved_folded(n text) to anon;
grant execute on function public.display_name_is_reserved_folded(n text) to authenticated;
grant execute on function public.display_name_is_reserved_folded(n text) to service_role;

-- [function grant] public.merge_carry_credit()
revoke all on function public.merge_carry_credit() from public, anon, authenticated, service_role;
grant execute on function public.merge_carry_credit() to service_role;

-- [function grant] public.promote_seed_description()
revoke all on function public.promote_seed_description() from public, anon, authenticated, service_role;
grant execute on function public.promote_seed_description() to service_role;

-- [cron] tilecache-sweep
select cron.schedule('tilecache-sweep', '17 4 * * 0', '
  with cur as (
    select max((substring(key from ''^places:v([0-9]+):''))::int) as v
    from public.shared_kv
    where key ~ ''^places:v[0-9]+:''
  )
  delete from public.shared_kv s
  using cur
  where s.key like ''places:%''
    and s.key <> ''places:blocklist''
    and (
      -- (a) #402: OLD versions — orphan cleanup at the tile TTL (unchanged from #126)
      (     s.key ~ ''^places:v[0-9]+:''
        and (substring(s.key from ''^places:v([0-9]+):''))::int < cur.v
        and (s.updated_at is null or s.updated_at < now() - interval ''21 days''))
      or
      -- (b) #402: CURRENT version — size guard only; SWR keeps these useful past TTL
      (     s.key ~ ''^places:v[0-9]+:''
        and (substring(s.key from ''^places:v([0-9]+):''))::int >= cur.v
        and (s.updated_at is null or s.updated_at < now() - interval ''90 days''))
      or
      -- (c) #136: unversioned places:<tile> fossils, by shape
      (s.key !~ ''^places:v[0-9]+:'')
    );
  ');
