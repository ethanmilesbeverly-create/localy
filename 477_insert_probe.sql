-- 477_insert_probe.sql — #477: can a signed-in user insert a submission that
-- skips the AI gate and moderation? Run in the Supabase SQL editor, whole file.
--
-- SAFE TO RUN ON THE LIVE DB, ANY NUMBER OF TIMES. Every test insert runs in
-- a sub-transaction that is rolled back by a deliberate raise before the file
-- ends (the #137 harness method), so nothing is written to `submissions` and
-- no user's credit is touched. The only object it creates is a TEMP table
-- (probe_477) that vanishes with the session.
--
-- RUN IT TWICE: once BEFORE 477_lock_submission_insert.sql (expect HOLE on
-- case A) and once AFTER (expect every row OK). The result is ONE grid:
--   section = live   → what the database holds right now (policy, triggers,
--                      grants, the guard's version stamp)
--   section = case   → the five insert tests
--   section = summary → one line: HOLE or CLOSED
--
-- The five cases (each impersonates a browser role through the same JWT
-- settings PostgREST uses, so RLS, grants and triggers all apply):
--   A  signed-in user inserts status='approved' with every server-owned
--      column pre-filled (category, source, ai_*, reviewed_*, review_note,
--      name_clean, city, resolved_*, created_at, ai_retry_count)
--   B  signed-in user inserts a row with merged_into = an approved seed pin
--      (would the merge-credit trigger hand them the seed's credit?)
--   C  the real client insert, exactly as index.html's submitGem() sends it
--      — must land as pending both before and after the fix
--   D  anon (signed out) inserts with a user's id — must be refused
--   E  signed-in user inserts with SOMEONE ELSE's id — must be refused

drop table if exists probe_477;
create temp table probe_477 (
  ord     int,
  section text,
  item    text,
  detail  text,
  verdict text
);

-- ---------------------------------------------------------------------
-- LIVE STATE
-- ---------------------------------------------------------------------
insert into probe_477
select 10, 'live', 'policy: ' || policyname,
       cmd || ' to ' || array_to_string(roles, ',') ||
       coalesce(' | using ' || qual, '') ||
       coalesce(' | with check ' || with_check, ''),
       case when cmd = 'INSERT' and with_check not ilike '%status%'
            then 'insert check does not look at status' else '' end
from pg_policies
where schemaname = 'public' and tablename = 'submissions';

insert into probe_477
select 20, 'live', 'trigger: ' || t.tgname,
       pg_get_triggerdef(t.oid),
       ''
from pg_trigger t
where t.tgrelid = 'public.submissions'::regclass and not t.tgisinternal;

insert into probe_477
select 30, 'live', 'table grant: ' || grantee,
       string_agg(privilege_type, ', ' order by privilege_type),
       ''
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'submissions'
  and grantee in ('anon', 'authenticated')
group by grantee;

insert into probe_477
select 40, 'live', 'guard version',
       coalesce(
         obj_description(to_regprocedure('public.guard_submission_insert()'), 'pg_proc'),
         '(no guard_submission_insert function — fix not applied)'),
       '';

-- ---------------------------------------------------------------------
-- THE PROBE
-- ---------------------------------------------------------------------
create or replace function pg_temp.p477(
  p_ord int, p_case text, p_expect text,  -- expect: clamped | lands | refused
  p_role text, p_uid uuid,
  p_row jsonb, p_keep uuid default null
) returns void language plpgsql as $$
declare
  v_id    uuid := gen_random_uuid();
  v_row   jsonb := p_row || jsonb_build_object('id', v_id);
  v_cols  text;
  r       public.submissions;
  v_err   text;
  v_kb    uuid;      -- keep row's submitted_by before
  v_ka    uuid;      -- keep row's submitted_by after (inside the test)
  v_bad   text[] := '{}';
  v_det   text;
  v_ver   text;
begin
  if p_keep is not null then
    select submitted_by into v_kb from public.submissions where id = p_keep;
  end if;

  select string_agg(quote_ident(k), ', ') into v_cols
  from jsonb_object_keys(v_row) k;

  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', p_role)::text, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    perform set_config('request.jwt.claim.role', p_role, true);
    execute format('set local role %I', p_role);

    execute format(
      'insert into public.submissions (%s) select %s from jsonb_populate_record(null::public.submissions, $1)',
      v_cols, v_cols) using v_row;

    execute 'reset role';
    select * into r from public.submissions where id = v_id;
    if p_keep is not null then
      select submitted_by into v_ka from public.submissions where id = p_keep;
    end if;
    raise exception using errcode = 'P0477', message = 'probe rollback';
  exception
    when sqlstate 'P0477' then v_err := null;          -- inserted, now undone
    when others then v_err := sqlerrm; r := null;      -- refused
  end;

  if v_err is not null then
    v_det := 'REFUSED: ' || v_err;
    v_ver := case when p_expect = 'refused' then 'OK'
                  when p_expect = 'clamped' then 'OK (refused, not clamped)'
                  else 'BROKEN — the normal submit must succeed' end;  -- 'lands'
  else
    if r.status        is distinct from 'pending' then v_bad := array_append(v_bad, (('status=' || r.status))::text); end if;
    if r.source        is distinct from 'user'    then v_bad := array_append(v_bad, (('source=' || coalesce(r.source,'null')))::text); end if;
    if r.category      is not null then v_bad := array_append(v_bad, (('category=' || r.category))::text); end if;
    if r.city          is not null then v_bad := array_append(v_bad, (('city=' || r.city))::text); end if;
    if r.ai_decision   is not null then v_bad := array_append(v_bad, (('ai_decision=' || r.ai_decision))::text); end if;
    if r.ai_status     is not null then v_bad := array_append(v_bad, (('ai_status=' || r.ai_status))::text); end if;
    if r.ai_reason     is not null then v_bad := array_append(v_bad, ('ai_reason set')::text); end if;
    if r.ai_reviewed_at is not null then v_bad := array_append(v_bad, ('ai_reviewed_at set')::text); end if;
    if r.reviewed_by   is not null then v_bad := array_append(v_bad, ('reviewed_by set')::text); end if;
    if r.reviewed_at   is not null then v_bad := array_append(v_bad, ('reviewed_at set')::text); end if;
    if r.review_note   is not null then v_bad := array_append(v_bad, ('review_note set')::text); end if;
    if r.name_clean    is not null then v_bad := array_append(v_bad, ('name_clean set')::text); end if;
    if r.description_clean is not null then v_bad := array_append(v_bad, ('description_clean set')::text); end if;
    if r.merged_into   is not null then v_bad := array_append(v_bad, ('merged_into set')::text); end if;
    if r.resolved_source is not null then v_bad := array_append(v_bad, ('resolved_source set')::text); end if;
    if r.created_at < now() - interval '1 minute' then v_bad := array_append(v_bad, (('created_at backdated to ' || r.created_at::date))::text); end if;
    if coalesce((to_jsonb(r) ->> 'ai_retry_count')::int, 0) <> 0 then
      v_bad := array_append(v_bad, ('ai_retry_count=' || (to_jsonb(r) ->> 'ai_retry_count'))::text);
    end if;
    if p_keep is not null and v_ka is distinct from v_kb then
      v_bad := array_append(v_bad, 'seed pin credit handed to the inserter'::text);
    end if;

    v_det := 'INSERTED as status=' || r.status ||
             case when cardinality(v_bad) > 0
                  then ' | kept: ' || array_to_string(v_bad, ', ') else '' end;
    v_ver := case
      when p_expect = 'refused' then 'HOLE — should have been refused'
      when r.status = 'approved' then 'HOLE — approved row skipped the gate'
      when cardinality(v_bad) > 0 then 'HOLE — server columns kept'
      else 'OK' end;
  end if;

  insert into probe_477 values (p_ord, 'case', p_case, v_det, v_ver);
end $$;

do $$
declare
  u1   uuid;
  u2   uuid;
  seed uuid;
begin
  select id into u1 from auth.users order by created_at limit 1;
  select id into u2 from auth.users where id <> u1 order by created_at limit 1;
  select id into seed from public.submissions
   where status = 'approved' and submitted_by is null and merged_into is null
   order by created_at limit 1;

  if u1 is null then
    insert into probe_477 values (50, 'case', 'all', 'no auth.users row to impersonate', 'CANNOT RUN');
    return;
  end if;

  perform pg_temp.p477(51, 'A  hostile approved insert', 'clamped', 'authenticated', u1,
    jsonb_build_object(
      'name', 'probe 477 A', 'description', 'probe', 'lat', 41.88, 'lng', -87.63,
      'submitted_by', u1, 'status', 'approved', 'source', 'seed:reddit',
      'category', 'history', 'city', 'Chicago',
      'ai_decision', 'approve', 'ai_status', 'ok', 'ai_reason', 'probe',
      'ai_confidence', 0.99, 'ai_reviewed_at', now(),
      'reviewed_by', u1, 'reviewed_at', now(), 'review_note', 'probe',
      'name_clean', 'probe', 'description_clean', 'probe',
      'resolved_description', 'probe', 'resolved_source', 'wiki',
      'created_at', '2020-01-01T00:00:00Z', 'ai_retry_count', 6));

  if seed is not null then
    perform pg_temp.p477(52, 'B  merged_into a seed pin', 'clamped', 'authenticated', u1,
      jsonb_build_object(
        'name', 'probe 477 B', 'description', 'probe', 'lat', 41.88, 'lng', -87.63,
        'submitted_by', u1, 'source', 'user', 'status', 'pending',
        'merged_into', seed), seed);
  else
    insert into probe_477 values (52, 'case', 'B  merged_into a seed pin', 'no uncredited approved seed found', 'SKIPPED');
  end if;

  perform pg_temp.p477(53, 'C  normal client submit', 'lands', 'authenticated', u1,
    jsonb_build_object(
      'name', 'probe 477 C', 'description', 'probe', 'lat', 41.88, 'lng', -87.63,
      'submitted_by', u1, 'source', 'user', 'status', 'pending'));

  perform pg_temp.p477(54, 'D  signed-out insert', 'refused', 'anon', null,
    jsonb_build_object(
      'name', 'probe 477 D', 'description', 'probe', 'lat', 41.88, 'lng', -87.63,
      'submitted_by', u1, 'source', 'user', 'status', 'approved'));

  if u2 is not null then
    perform pg_temp.p477(55, 'E  insert as someone else', 'refused', 'authenticated', u1,
      jsonb_build_object(
        'name', 'probe 477 E', 'description', 'probe', 'lat', 41.88, 'lng', -87.63,
        'submitted_by', u2, 'source', 'user', 'status', 'pending'));
  else
    insert into probe_477 values (55, 'case', 'E  insert as someone else', 'only one auth user exists', 'SKIPPED');
  end if;
end $$;

-- A run where the tests did not all report is NEVER a pass: A, C and D
-- always run, so fewer than three case rows means something errored.
insert into probe_477
select 90, 'summary', '#477',
       case when (select count(*) from probe_477 where section = 'case' and item ~ '^[ACD] ') < 3
            then 'the tests did not all run — read the error above; do not trust this run'
            when exists (select 1 from probe_477 where section = 'case' and verdict like 'HOLE%')
            then 'at least one case is a HOLE — run 477_lock_submission_insert.sql'
            when exists (select 1 from probe_477 where section = 'case' and verdict like 'BROKEN%')
            then 'the normal submit is refused — do NOT ship; roll back the guard'
            else 'every case OK' end,
       case when (select count(*) from probe_477 where section = 'case' and item ~ '^[ACD] ') < 3 then 'INCOMPLETE'
            when exists (select 1 from probe_477 where section = 'case' and verdict like 'HOLE%') then 'HOLE'
            when exists (select 1 from probe_477 where section = 'case' and verdict like 'BROKEN%') then 'BROKEN'
            else 'CLOSED' end;

select section, item, detail, verdict from probe_477 order by ord, item;
