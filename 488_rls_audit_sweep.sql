-- 488_rls_audit_sweep.sql — #488: the RLS audit sweep, rewritten.
-- SWEEP_VERSION: 488-sweep-v4
--   v4 (2026-10-06, #517b): the relational guide copies (`guides`,
--   `guide_stops`) are no longer public by design — #277's backfill put every
--   guide there and their `using (true)` reads listed them all. Reads are now
--   owner-only (517b_guides_relational_read.sql); both tables leave the
--   public_read list (so a `using (true)` read there is a HOLE again), and W13 /
--   W14 check that a signed-out reader lists none. #277 Pass 2 reads BY CODE
--   through a definer function (the get_guide pattern), never a public SELECT.
--   v3 (2026-10-06, #517): guides are opened by their exact code and never
--   listed. shared_kv's public read now hides `hunt-code:%` rows, and the browser
--   reaches a guide only through two SECURITY DEFINER functions — get_guide
--   (anon + signed-in) and save_guide (signed-in) — added to grant (5)'s list
--   (six → eight). P10 now saves through save_guide (a direct upsert is refused
--   once the row is hidden — that is the point); P14 opens a guide by code; W11
--   (signed out lists guides), W12 (signed out calls save_guide) and W43 (a
--   stranger saves over an owned guide through save_guide) are the new must-nots.
--   v2 (2026-10-05, #513): the TRUNCATE KNOWN row became a real check — every
--   browser write grant on every table and sequence against the #513 keep-list
--   (grant (6)), plus self-test T6 that proves it can see a stray grant.
--
-- WHAT IT IS. The read-only, roll-everything-back re-check of the database's
-- security: who can read what, who can write what, and whether the guard
-- triggers are still there. #137 wrote the first one (2026-08-12); it was never
-- committed and is lost (#478). This one was written FROM the live schema
-- record (409_schema_baseline.sql, refreshed 2026-10-05 by #413), not from
-- memory, and folds in #477's insert probe and #512's eight `profiles` cases.
--
-- WHEN TO RUN IT. After any RLS, policy, grant or trigger change, and on a
-- restore (after 409_baseline_check.sql). Safe on the live DB, any number of
-- times: Supabase dashboard → SQL Editor → paste this whole file → Run.
--
-- SAFE BECAUSE. Every test runs in a sub-transaction that is undone by a
-- deliberate raise before the file moves on (the #137/#477 method), so nothing
-- is written — not the test gem, not a name save, not a ping. The only objects
-- it creates are TEMP (gone with the session). NO PII IN THE OUTPUT: counts and
-- error text only; any id in an error message prints as <id>.
-- The SELF-TEST section briefly drops a guard trigger, switches RLS off on one
-- table, adds one open policy and three grants — each inside its own
-- sub-transaction, undone before the next — to prove the checks above would
-- catch it. Each holds a lock on that one table for milliseconds.
--
-- READING IT. One grid. `summary` is the first row:
--   CLOSED      every check and probe passed, and every self-test fired
--   DRIFT       nothing open, but something differs from the 2026-10-05
--               baseline (a policy added or missing, a stamp changed) — read
--               the DRIFT rows, then refresh the baseline if it is intended
--   BROKEN      an app path the browser really uses is refused
--   HOLE        the browser can read or write something it must not
--   BLIND       a self-test did not fire: a check above cannot see what it
--               claims to — do not trust this run's OK rows
--   INCOMPLETE  fewer probes reported than were planned — read the error
-- Sections, in order: rls · policy · grant · trigger (the live state, read
-- from the catalog) · read · profiles · app · write (the probes, run AS the
-- browser roles with the same JWT settings PostgREST uses, so RLS, grants and
-- triggers all apply) · self-test.
-- KNOWN rows are deliberate, open findings with a row that owns them — they
-- do not change the summary.
--
-- EXPECTATIONS COME FROM THE 2026-10-05 BASELINE. When a pass adds a policy,
-- a browser-callable function, a guard trigger or a client-read column, add it
-- to the matching list below in the same pass, or this sweep reports DRIFT /
-- HOLE for the new thing — which is the point.

drop table if exists sweep_488;
create temp table sweep_488 (ord int, section text, item text, detail text, verdict text);
drop table if exists sweep_488_plan;
create temp table sweep_488_plan (planned int not null default 0);
insert into sweep_488_plan values (0);

-- =====================================================================
-- THE CHECKS (catalog reads). Written as functions so the self-tests can
-- run exactly the same check against a deliberately broken schema.
-- =====================================================================

-- RLS must be on for every public table (and storage.objects, which holds the
-- capture photos). A table with RLS off is readable/writable by its grants alone.
create or replace function pg_temp.c488_rls()
returns table (item text, detail text, verdict text) language sql as $$
  select n.nspname || '.' || c.relname,
         case when c.relrowsecurity then 'RLS on' else 'RLS OFF' end
           || case when c.relforcerowsecurity then ' (forced)' else '' end,
         case when c.relrowsecurity then 'OK' else 'HOLE' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and (n.nspname = 'public' or (n.nspname = 'storage' and c.relname = 'objects'))
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
  order by 1
$$;

-- Every policy, with the #133 tautology detector:
--   * a WRITE policy (insert/update/delete/all) whose condition does not depend
--     on who is asking (no auth.uid()/auth.role(), or a bare `true`) is a HOLE —
--     RLS policies OR together, so one such policy opens the table to everyone;
--   * an `owner IS NULL` arm lets anyone edit an unowned row — a HOLE unless it
--     is the one known grandfather arm (#135, retired by #277's cutover);
--   * a SELECT `using (true)` is a HOLE outside the deliberately public tables.
-- A policy missing from, or added since, the 2026-10-05 baseline is DRIFT.
create or replace function pg_temp.c488_policies()
returns table (item text, detail text, verdict text) language sql as $$
  with expected(k) as (values
    ('public.activity_pings.activity_pings_insert'),
    ('public.gem_seconds.read own vouches and vouches on my pins'),
    ('public.guide_stops.guide_stops_delete'),
    ('public.guide_stops.guide_stops_insert'),
    ('public.guide_stops.guide_stops_select'),
    ('public.guide_stops.guide_stops_update'),
    ('public.guides.guides_insert'),
    ('public.guides.guides_select'),
    ('public.guides.guides_update'),
    ('public.hunt_points.owner writes hunt points'),
    ('public.hunt_points.read all hunt points'),
    ('public.hunts.delete own hunts'),
    ('public.hunts.insert own hunts'),
    ('public.hunts.read all hunts'),
    ('public.hunts.update own hunts'),
    ('public.profiles.profiles insert'),
    ('public.profiles.profiles read'),
    ('public.profiles.profiles update'),
    ('public.progress.manage own progress'),
    ('public.shared_kv.shared_kv_guide_insert'),
    ('public.shared_kv.shared_kv_guide_update'),
    ('public.shared_kv.shared_kv_public_read'),
    ('public.submissions.insert own submissions'),
    ('public.submissions.read approved submissions'),
    ('public.submissions.read own submissions'),
    ('public.user_state.own state delete'),
    ('public.user_state.own state insert'),
    ('public.user_state.own state select'),
    ('public.user_state.own state update'),
    ('storage.objects.capture-photos owner delete'),
    ('storage.objects.capture-photos owner insert'),
    ('storage.objects.capture-photos owner read'),
    ('storage.objects.capture-photos owner update')
  ),
  -- tables whose rows are public by design (shared_kv holds the public tile
  -- cache — its guide rows are hidden since #517; hunts/hunt_points are empty
  -- and unused). guides/guide_stops left this list in v4 (#517b): a guide is
  -- opened by its exact code through a definer function, never listed.
  public_read(t) as (values ('shared_kv'), ('hunts'), ('hunt_points')),
  live as (
    select p.schemaname || '.' || p.tablename || '.' || p.policyname as k,
           p.tablename, p.policyname, p.cmd, p.permissive,
           array_to_string(p.roles, ',') as roles,
           coalesce(p.qual, '') as q, coalesce(p.with_check, '') as c
    from pg_policies p
    where p.schemaname = 'public'
       or (p.schemaname = 'storage' and p.tablename = 'objects')
  ),
  judged as (
    select l.*,
           (l.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')) as is_write,
           (l.q = 'true' or l.c = 'true'
            or (l.q !~ 'auth\.(uid|role)\(\)' and l.c !~ 'auth\.(uid|role)\(\)')) as ignores_caller,
           ((l.q || ' ' || l.c) ~* 'owner IS NULL') as null_owner_arm
    from live l
  )
  select 'policy: ' || j.k,
         j.cmd || ' to ' || j.roles || case when j.permissive = 'RESTRICTIVE' then ' (restrictive)' else '' end,
         case
           when j.is_write and j.ignores_caller and j.k = 'public.activity_pings.activity_pings_insert'
             then 'KNOWN (#10: insert-only telemetry — column grants limit it to device_id, event)'
           when j.is_write and j.ignores_caller
             then 'HOLE (#133: a write policy that does not depend on who is asking)'
           when j.null_owner_arm and j.k = 'public.shared_kv.shared_kv_guide_update'
             then 'KNOWN (#135 grandfather arm on legacy hunt-code blobs — #277''s cutover retires it)'
           when j.null_owner_arm
             then 'HOLE (an owner IS NULL arm: anyone can edit an unowned row)'
           when j.cmd = 'SELECT' and j.q = 'true' and j.tablename not in (select t from public_read)
             then 'HOLE (#133: everyone can read every row of a table that is not public by design)'
           when j.k not in (select k from expected)
             then 'DRIFT (not in the 2026-10-05 baseline — review it, then refresh the baseline)'
           else 'OK' end
  from judged j
  union all
  select 'policy: ' || e.k, 'MISSING from the live DB', 'DRIFT (in the 2026-10-05 baseline, gone now — the feature it served fails closed)'
  from expected e where e.k not in (select k from live)
  order by 1
$$;

-- Grants. RLS is row-level; these are the column- and table-level locks that
-- RLS cannot express.
create or replace function pg_temp.c488_grants()
returns table (item text, detail text, verdict text) language plpgsql as $$
declare
  r record; v_role text; v_extra text; v_missing text; v_bad text; v_n int;
begin
  -- (1) Column allowlists: the browser may SELECT only these columns (#276/#344
  --     on submissions; #512 on profiles). Table-level SELECT would expose all.
  for r in select * from (values
      ('submissions', array['category','created_at','description','description_clean','id','lat','lng',
                            'merged_into','name','name_clean','resolved_description','resolved_source',
                            'status','submitted_by']),
      ('profiles',    array['display_name','status','user_id'])) v(t, cols)
  loop
    foreach v_role in array array['anon', 'authenticated'] loop
      select string_agg(a.attname, ', ' order by a.attname) into v_extra
      from pg_attribute a
      where a.attrelid = ('public.' || r.t)::regclass and a.attnum > 0 and not a.attisdropped
        and not (a.attname = any (r.cols))
        and has_column_privilege(v_role, ('public.' || r.t)::regclass, a.attname, 'SELECT');
      select string_agg(c, ', ' order by c) into v_missing
      from unnest(r.cols) c
      where not has_column_privilege(v_role, ('public.' || r.t)::regclass, c, 'SELECT');
      item := 'select columns: ' || r.t || ' → ' || v_role;
      if has_table_privilege(v_role, ('public.' || r.t)::regclass, 'SELECT') then
        detail := 'TABLE-LEVEL SELECT (every column, current and future)'; verdict := 'HOLE';
      elsif v_extra is not null then
        detail := 'beyond the allowlist: ' || v_extra; verdict := 'HOLE';
      elsif v_missing is not null then
        detail := 'allowlisted but not granted: ' || v_missing; verdict := 'BROKEN';
      else
        detail := cardinality(r.cols) || ' allowlisted columns, nothing more'; verdict := 'OK';
      end if;
      return next;
    end loop;
  end loop;

  -- (2) Server-only tables and views: the browser holds no read or write on them.
  for r in select unnest(array['capture_log','leaderboard_scores','pin_interest','report_reason_meta',
                               'pending_review','submission_cleanup_review','report_target_state',
                               'reports_open']) as t
  loop
    if to_regclass('public.' || r.t) is null then
      item := 'no browser access: ' || r.t; detail := 'object missing'; verdict := 'DRIFT (not in the live DB)';
      return next; continue;
    end if;
    select string_agg(g, ', ') into v_bad
    from (select ro || ' ' || pr as g
          from unnest(array['anon','authenticated']) ro,
               unnest(array['SELECT','INSERT','UPDATE','DELETE']) pr
          where has_table_privilege(ro, ('public.' || r.t)::regclass, pr)
             or (pr in ('SELECT','INSERT','UPDATE')
                 and has_any_column_privilege(ro, ('public.' || r.t)::regclass, pr))) s;
    item := 'no browser access: ' || r.t;
    detail := coalesce('granted: ' || v_bad, 'none granted');
    verdict := case when v_bad is null then 'OK' else 'HOLE' end;
    return next;
  end loop;

  -- (3) activity_pings: INSERT on exactly (device_id, event) — the day, the
  --     signed-in flag and the time are server-derived (#10). Nothing else.
  select string_agg(ro || ' ' || pr || coalesce(' (' || a.attname || ')', ''), ', ') into v_bad
  from unnest(array['anon','authenticated']) ro
  cross join unnest(array['SELECT','UPDATE','DELETE','INSERT']) pr
  left join pg_attribute a on a.attrelid = 'public.activity_pings'::regclass and a.attnum > 0
                          and not a.attisdropped and pr <> 'DELETE'
  where (pr = 'DELETE' and has_table_privilege(ro, 'public.activity_pings', 'DELETE'))
     or (pr in ('SELECT','UPDATE') and a.attname is not null
         and has_column_privilege(ro, 'public.activity_pings', a.attname, pr))
     or (pr = 'INSERT' and a.attname is not null and a.attname not in ('device_id','event')
         and has_column_privilege(ro, 'public.activity_pings', a.attname, 'INSERT'));
  select count(*) into v_n
  from unnest(array['anon','authenticated']) ro, unnest(array['device_id','event']) col
  where not has_column_privilege(ro, 'public.activity_pings', col, 'INSERT');
  item := 'activity_pings: insert-only, two columns';
  detail := coalesce('beyond device_id/event insert: ' || v_bad,
                     case when v_n > 0 then v_n || ' of the 4 expected insert grants missing'
                          else 'insert (device_id, event) only' end);
  verdict := case when v_bad is not null then 'HOLE' when v_n > 0 then 'BROKEN' else 'OK' end;
  return next;

  -- (4) A view runs as its owner unless security_invoker is set, so it skips
  --     the caller's RLS. Any view the browser can read must be an invoker view.
  for r in
    select c.relname, coalesce(c.reloptions::text, '') ilike '%security_invoker=true%'
                      or coalesce(c.reloptions::text, '') ilike '%security_invoker=on%' as invoker,
           (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT')) as readable
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')
    order by 1
  loop
    item := 'view: ' || r.relname;
    detail := case when r.readable then 'browser-readable' else 'not browser-readable' end
              || ', ' || case when r.invoker then 'security_invoker' else 'runs as owner' end;
    verdict := case when r.readable and not r.invoker then 'HOLE (an owner-rights view the browser can read bypasses RLS)'
                    else 'OK' end;
    return next;
  end loop;

  -- (5) SECURITY DEFINER functions run with the owner's rights. Only these eight
  --     are meant to be callable from the browser; every other one must not be.
  --     (#517 added get_guide / save_guide: a guide is opened by exact code only.)
  for r in
    with allow(f, roles) as (values
      ('gem_seconds_counts',         array['anon','authenticated']),
      ('search_pin_names',           array['anon','authenticated']),
      ('pin_interest_add',           array['anon','authenticated']),
      ('leaderboard_top',            array['authenticated']),
      ('leaderboard_me',             array['authenticated']),
      ('set_leaderboard_visibility', array['authenticated']),
      ('get_guide',                  array['anon','authenticated']),
      ('save_guide',                 array['authenticated']))
    select p.oid, p.proname,
           format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) as sig,
           a.roles,
           array_remove(array[
             case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'anon' end,
             case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'authenticated' end], null) as can
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    left join allow a on a.f = p.proname
    where n.nspname = 'public' and p.prosecdef
      and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    order by p.proname
  loop
    item := 'definer function: ' || r.sig;
    detail := 'browser can execute: ' || coalesce(nullif(array_to_string(r.can, ', '), ''), 'nobody')
              || case when r.roles is not null then ' | meant for: ' || array_to_string(r.roles, ', ') else ' | server-only' end;
    verdict := case
      when r.roles is null and cardinality(r.can) > 0 then 'HOLE (a server-only definer function the browser can call)'
      when r.roles is not null and not (r.roles <@ r.can) then 'BROKEN (an app call would be refused)'
      when r.roles is not null and not (r.can <@ r.roles) then 'HOLE (callable by a role it is not meant for)'
      else 'OK' end;
    return next;
  end loop;

  -- (6) Browser WRITE grants must be exactly what the app writes (#513). RLS
  --     denies every other write today; the grant is the second lock, so one
  --     mistaken policy or one table with RLS off is not enough. Supabase hands
  --     every NEW table the full default set, so a new table shows up here until
  --     its grants are trimmed (or its writes added to this list on purpose).
  --     activity_pings' two-column INSERT is checked in (3); SELECT is the
  --     policies' and the allowlists' job, not this check's.
  for r in
    with keep(t, ro, pr) as (values
      ('shared_kv','authenticated','INSERT'), ('shared_kv','authenticated','UPDATE'),
      ('user_state','authenticated','INSERT'), ('user_state','authenticated','UPDATE'),
      ('profiles','authenticated','INSERT'), ('profiles','authenticated','UPDATE'),
      ('submissions','authenticated','INSERT'),
      ('guides','authenticated','INSERT'), ('guides','authenticated','UPDATE'), ('guides','authenticated','DELETE'),
      ('guide_stops','authenticated','INSERT'), ('guide_stops','authenticated','UPDATE'), ('guide_stops','authenticated','DELETE')),
    privs(pr) as (select unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
                  || case when current_setting('server_version_num')::int >= 170000
                          then array['MAINTAIN'] else array[]::text[] end)),
    rels as (
      select c.oid, c.relname, c.relkind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'S')
        and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')),
    held as (
      select x.relname, ro.ro, pr.pr
      from rels x cross join (values ('anon'), ('authenticated')) ro(ro) cross join privs pr
      where x.relkind <> 'S' and has_table_privilege(ro.ro, x.oid, pr.pr)
      union all
      select x.relname, ro.ro, sp.pr
      from rels x cross join (values ('anon'), ('authenticated')) ro(ro)
      cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) sp(pr)
      where x.relkind = 'S' and has_sequence_privilege(ro.ro, x.oid, sp.pr))
    select x.relname,
           (select string_agg(h.ro || ' ' || h.pr, ', ' order by h.ro, h.pr) from held h
             where h.relname = x.relname and (h.relname, h.ro, h.pr) not in (select * from keep)) as extra,
           (select string_agg(k.ro || ' ' || k.pr, ', ' order by k.ro, k.pr) from keep k
             where k.t = x.relname and (k.t, k.ro, k.pr) not in (select relname, ro, pr from held)) as missing,
           (select string_agg(h.ro || ' ' || h.pr, ', ' order by h.ro, h.pr) from held h
             where h.relname = x.relname and (h.relname, h.ro, h.pr) in (select * from keep)) as kept
    from rels x
    order by x.relname
  loop
    item := 'write grants: ' || r.relname;
    detail := case
      when r.extra is not null then 'beyond the #513 keep-list: ' || r.extra
      when r.missing is not null then 'keep-list grant missing: ' || r.missing
      else coalesce(r.kept, 'none') end;
    verdict := case
      when r.extra is not null then 'DRIFT (a browser write the app never makes — revoke it, or add it to the keep-list on purpose)'
      when r.missing is not null then 'BROKEN (an app write would be refused)'
      else 'OK' end;
    return next;
  end loop;
end $$;

-- Guard triggers: the column rules RLS cannot express (handoff §5). Each must
-- exist, be enabled, run BEFORE, and call its own function.
create or replace function pg_temp.c488_triggers()
returns table (item text, detail text, verdict text) language plpgsql as $$
declare
  r record; t record; v_first text; v_stamp text;
begin
  for r in select * from (values
      ('public.profiles',    'profiles_guard_trg',         'profiles_guard',              'name only moves through the intended path; status/created_at frozen (#23)'),
      ('public.shared_kv',   'shared_kv_lock_owner',       'shared_kv_lock_owner',        'owner immutable after insert (#135)'),
      ('public.guides',      'guides_guard_trg',           'guides_guard',                'owner and code frozen (#277/#411)'),
      ('public.guide_stops', 'guide_stops_guard_trg',      'guide_stops_guard',           'added_by and guide_id frozen (#277/#411)'),
      ('public.submissions', 'lock_resolved_desc_columns', 'lock_resolved_desc_columns',  'browser cannot set the resolved story (#344)'),
      ('public.submissions', 'guard_submission_insert',    'guard_submission_insert',     'a browser insert lands pending with server columns cleared (#477)'),
      ('auth.users',         'on_auth_user_created',       'handle_new_user',             'signup creates the profile row (#23) — not a guard; missing = BROKEN')
    ) v(tbl, trg, fn, why)
  loop
    select tg.tgenabled, pg_get_triggerdef(tg.oid) as def, tg.tgfoid::regproc::text as f
      into t
    from pg_trigger tg
    where tg.tgrelid = to_regclass(r.tbl) and tg.tgname = r.trg and not tg.tgisinternal;
    item := 'trigger: ' || r.tbl || '.' || r.trg;
    if not found then
      detail := 'MISSING — ' || r.why;
      verdict := case when r.trg = 'on_auth_user_created' then 'BROKEN' else 'HOLE (guard trigger missing)' end;
    elsif t.tgenabled = 'D' then
      detail := 'DISABLED — ' || r.why;
      verdict := case when r.trg = 'on_auth_user_created' then 'BROKEN' else 'HOLE (guard trigger disabled)' end;
    elsif r.trg <> 'on_auth_user_created' and t.def !~ ' BEFORE ' then
      detail := 'not a BEFORE trigger: ' || t.def; verdict := 'HOLE (a guard must run before the write)';
    elsif t.f !~ ('(^|\.)' || r.fn || '$') then
      detail := 'calls ' || t.f || ', expected ' || r.fn; verdict := 'HOLE (guard calls the wrong function)';
    else
      detail := r.why; verdict := 'OK';
    end if;
    return next;
  end loop;

  -- #477 rule (2): triggers of one timing fire in NAME order, so the insert
  -- clamp must be the first BEFORE INSERT trigger on submissions.
  select tg.tgname into v_first
  from pg_trigger tg
  where tg.tgrelid = 'public.submissions'::regclass and not tg.tgisinternal and tg.tgenabled <> 'D'
    and pg_get_triggerdef(tg.oid) ~ ' BEFORE INSERT'
  order by tg.tgname limit 1;
  item := 'trigger order: submissions BEFORE INSERT';
  detail := 'fires first: ' || coalesce(v_first, '(none)');
  verdict := case when v_first = 'guard_submission_insert' then 'OK'
                  else 'HOLE (#477: the clamp must fire before any trigger that reads its columns)' end;
  return next;

  -- Version stamps the probes and the handoff point at.
  v_stamp := obj_description(to_regprocedure('public.guard_submission_insert()'), 'pg_proc');
  item := 'stamp: guard_submission_insert';
  detail := coalesce(v_stamp, '(none)');
  verdict := case when v_stamp = '477-insert-guard-v1' then 'OK' else 'DRIFT (expected 477-insert-guard-v1)' end;
  return next;

  select obj_description(p.oid, 'pg_policy') into v_stamp
  from pg_policy p where p.polrelid = 'public.profiles'::regclass and p.polname = 'profiles read';
  item := 'stamp: profiles read policy';
  detail := coalesce(v_stamp, '(none)');
  verdict := case when v_stamp = '512-profiles-read-v1' then 'OK' else 'DRIFT (expected 512-profiles-read-v1)' end;
  return next;
end $$;

insert into sweep_488 select 100, 'rls',     item, detail, verdict from pg_temp.c488_rls();
insert into sweep_488 select 200, 'policy',  item, detail, verdict from pg_temp.c488_policies();
insert into sweep_488 select 300, 'grant',   item, detail, verdict from pg_temp.c488_grants();
insert into sweep_488 select 400, 'trigger', item, detail, verdict from pg_temp.c488_triggers();

-- =====================================================================
-- THE PROBE. Runs one statement AS a browser role, then undoes it.
--   p_mode   'count' (the statement returns one number), 'dml' (rows affected),
--            or 'run' (just execute)
--   p_expect 'refused'  must error (permission / RLS)
--            'none'     0 rows, or refused — nothing visible / nothing changed
--            'runs'     must not error
--            '=N'       must return exactly N
--            'clamped'  refused, or ran and p_check (run as the owner, before
--                       the undo) returns true
--   p_miss   the verdict when the expectation fails: HOLE or BROKEN
--   p_check  for 'clamped' and optionally 'runs': a boolean query that must
--            be true after the statement, read back before the undo
-- =====================================================================
create or replace function pg_temp.p488(
  p_ord int, p_section text, p_item text, p_role text, p_uid uuid,
  p_sql text, p_mode text, p_expect text, p_miss text, p_check text default null
) returns void language plpgsql as $$
declare
  v_n   bigint;
  v_ok  boolean;
  v_chk boolean;
  v_err text;
  v_det text;
begin
  update sweep_488_plan set planned = planned + 1;
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', p_role)::text, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    perform set_config('request.jwt.claim.role', p_role, true);
    execute format('set local role %I', p_role);

    if p_mode = 'count' then
      execute p_sql into v_n;
    elsif p_mode = 'dml' then
      execute p_sql;
      get diagnostics v_n = row_count;
    else
      execute p_sql;
    end if;

    execute 'reset role';
    if p_check is not null then
      execute p_check into v_chk;
    end if;
    raise exception using errcode = 'P0488', message = 'sweep rollback';
  exception
    when sqlstate 'P0488' then v_err := null;                -- ran, now undone
    when others then v_err := sqlerrm; v_n := null; v_chk := null;  -- refused
  end;

  v_ok := case
    when p_expect = 'refused' then v_err is not null
    when p_expect = 'none'    then v_err is not null or v_n = 0
    when p_expect = 'runs'    then v_err is null and coalesce(v_chk, true)
    when p_expect = 'clamped' then v_err is not null or coalesce(v_chk, false)
    when p_expect like '=%'   then v_err is null and v_n = substr(p_expect, 2)::bigint
    else false end;

  v_det := case
    when v_err is not null then 'refused: ' || left(v_err, 160)
    when p_expect = 'clamped' then 'ran — server columns ' || case when v_chk then 'clamped' else 'KEPT' end
    when p_check is not null then 'ran — check ' || case when v_chk then 'passed' else 'FAILED' end
    when v_n is not null then
      case when p_mode = 'dml' then v_n || ' row(s) affected' else 'returned ' || v_n end
      || case when p_expect like '=%' then ', expected ' || substr(p_expect, 2) else '' end
    else 'ran' end;
  -- no ids in the output
  v_det := regexp_replace(v_det, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', 'gi');

  insert into sweep_488 values (p_ord, p_section, p_item, v_det, case when v_ok then 'OK' else p_miss end);
end $$;

-- A case that cannot run (no target row to aim at) is reported, not hidden.
create or replace function pg_temp.s488(p_ord int, p_section text, p_item text, p_why text)
returns void language sql as $$
  update sweep_488_plan set planned = planned + 1;
  insert into sweep_488 values (p_ord, p_section, p_item, 'not run: ' || p_why, 'SKIPPED');
$$;

do $$
declare
  v_victim   uuid;   -- owns a user_state row: the account a stranger attacks
  v_stranger uuid;   -- any other account
  v_me       uuid;   -- #512's E–H account: a nameless one when one exists
  v_me_name  text;
  v_me_stat  text;
  v_me_made  timestamptz;
  v_public   bigint;
  v_ids      uuid[];
  v_h        bigint;
  v_kv_key   text; v_kv_owner uuid;     -- an owned, non-editable hunt-code blob
  v_any_code text;                      -- any guide code, for P14 (#517)
  v_guide    uuid; v_guide_owner uuid;  -- an owned relational guide
  v_frozen   uuid;                      -- an unowned (frozen, #411) guide
  v_reason   text;
  v_gem      uuid := gen_random_uuid();
  v_gem_c    uuid := gen_random_uuid();
  GEM_SELECT constant text := 'id,name,description,category,lat,lng,name_clean,description_clean,submitted_by,resolved_description,resolved_source';
begin
  select user_id into v_victim from public.user_state group by user_id order by count(*) desc, user_id limit 1;
  if v_victim is null then
    select id into v_victim from auth.users order by created_at limit 1;
  end if;
  select id into v_stranger from auth.users where id is distinct from v_victim order by created_at limit 1;

  select count(*) into v_public from public.profiles where status = 'ok' and display_name is not null;
  select coalesce(array_agg(user_id), '{}') into v_ids
  from (select user_id from public.profiles where status = 'ok' and display_name is not null
        order by created_at limit 5) s;
  select user_id, display_name, status, created_at into v_me, v_me_name, v_me_stat, v_me_made
  from public.profiles order by (display_name is null) desc, created_at limit 1;
  v_h := v_public + case when exists (select 1 from public.profiles where user_id = v_me
                                      and status = 'ok' and display_name is not null) then 0 else 1 end;

  select key, owner into v_kv_key, v_kv_owner
  from public.shared_kv
  where key ~ '^hunt-code:' and owner is not null and owner is distinct from v_stranger
    and value like '{%' and coalesce((value::jsonb ->> 'editable')::boolean, false) = false
  order by key limit 1;
  select substr(key, 11) into v_any_code
  from public.shared_kv where key ~ '^hunt-code:[A-HJ-NP-Z2-9]{6}$' order by key limit 1;
  select id, owner into v_guide, v_guide_owner
  from public.guides where owner is not null and owner is distinct from v_stranger order by code limit 1;
  select id into v_frozen from public.guides where owner is null and not editable order by code limit 1;
  select reason into v_reason from public.report_reason_meta order by reason limit 1;

  -- ---------------- READ: signed out sees nothing private ----------------
  perform pg_temp.p488(501, 'read', 'R01 signed out: user_state rows',            'anon', null, 'select count(*) from public.user_state', 'count', 'none', 'HOLE');
  perform pg_temp.p488(502, 'read', 'R02 signed out: progress rows',              'anon', null, 'select count(*) from public.progress', 'count', 'none', 'HOLE');
  perform pg_temp.p488(503, 'read', 'R03 signed out: unapproved gems',            'anon', null, 'select count(*) from public.submissions where status <> ''approved''', 'count', 'none', 'HOLE');
  perform pg_temp.p488(504, 'read', 'R04 signed out: review_note',                'anon', null, 'select count(review_note) from public.submissions', 'count', 'refused', 'HOLE');
  perform pg_temp.p488(505, 'read', 'R05 signed out: ai_reason',                  'anon', null, 'select count(ai_reason) from public.submissions', 'count', 'refused', 'HOLE');
  perform pg_temp.p488(506, 'read', 'R06 signed out: reviewed_by',                'anon', null, 'select count(reviewed_by) from public.submissions', 'count', 'refused', 'HOLE');
  perform pg_temp.p488(507, 'read', 'R07 signed out: reports',                    'anon', null, 'select count(*) from public.reports', 'count', 'none', 'HOLE');
  perform pg_temp.p488(508, 'read', 'R08 signed out: gem_seconds',                'anon', null, 'select count(*) from public.gem_seconds', 'count', 'none', 'HOLE');
  perform pg_temp.p488(509, 'read', 'R09 signed out: capture_log',                'anon', null, 'select count(*) from public.capture_log', 'count', 'none', 'HOLE');
  perform pg_temp.p488(510, 'read', 'R10 signed out: leaderboard_scores',         'anon', null, 'select count(*) from public.leaderboard_scores', 'count', 'none', 'HOLE');
  perform pg_temp.p488(511, 'read', 'R11 signed out: activity_pings',             'anon', null, 'select count(*) from public.activity_pings', 'count', 'none', 'HOLE');
  perform pg_temp.p488(512, 'read', 'R12 signed out: pin_interest',               'anon', null, 'select count(*) from public.pin_interest', 'count', 'none', 'HOLE');
  perform pg_temp.p488(513, 'read', 'R13 signed out: curated_descriptions',       'anon', null, 'select count(*) from public.curated_descriptions', 'count', 'none', 'HOLE');
  perform pg_temp.p488(514, 'read', 'R14 signed out: report_reason_meta',         'anon', null, 'select count(*) from public.report_reason_meta', 'count', 'none', 'HOLE');
  perform pg_temp.p488(515, 'read', 'R15 signed out: pending_review',             'anon', null, 'select count(*) from public.pending_review', 'count', 'none', 'HOLE');
  perform pg_temp.p488(516, 'read', 'R16 signed out: reports_open',               'anon', null, 'select count(*) from public.reports_open', 'count', 'none', 'HOLE');
  perform pg_temp.p488(517, 'read', 'R17 signed out: submission_cleanup_review',  'anon', null, 'select count(*) from public.submission_cleanup_review', 'count', 'none', 'HOLE');
  perform pg_temp.p488(518, 'read', 'R18 signed out: report_target_state',        'anon', null, 'select count(*) from public.report_target_state', 'count', 'none', 'HOLE');
  perform pg_temp.p488(519, 'read', 'R19 signed out: capture photos',             'anon', null, 'select count(*) from storage.objects where bucket_id = ''capture-photos''', 'count', 'none', 'HOLE');

  -- ---------------- READ: a signed-in stranger sees only their own --------
  if v_stranger is null then
    perform pg_temp.s488(520, 'read', 'R20–R27 signed-in stranger', 'fewer than two accounts exist');
  else
    perform pg_temp.p488(520, 'read', 'R20 stranger: others'' user_state', 'authenticated', v_stranger,
      format('select count(*) from public.user_state where user_id <> %L', v_stranger), 'count', 'none', 'HOLE');
    perform pg_temp.p488(521, 'read', 'R21 stranger: others'' progress', 'authenticated', v_stranger,
      format('select count(*) from public.progress where user_id is distinct from %L', v_stranger), 'count', 'none', 'HOLE');
    perform pg_temp.p488(522, 'read', 'R22 stranger: others'' unapproved gems', 'authenticated', v_stranger,
      format('select count(*) from public.submissions where status <> ''approved'' and submitted_by is distinct from %L', v_stranger), 'count', 'none', 'HOLE');
    perform pg_temp.p488(523, 'read', 'R23 stranger: vouches not theirs, not on their gems', 'authenticated', v_stranger,
      format('select count(*) from public.gem_seconds g where g.user_id <> %1$L and not exists
              (select 1 from public.submissions s where s.id = g.submission_id and s.submitted_by = %1$L)', v_stranger), 'count', 'none', 'HOLE');
    perform pg_temp.p488(524, 'read', 'R24 stranger: photos outside own folder', 'authenticated', v_stranger,
      format('select count(*) from storage.objects where bucket_id = ''capture-photos''
              and (storage.foldername(name))[1] is distinct from %L', v_stranger::text), 'count', 'none', 'HOLE');
    perform pg_temp.p488(525, 'read', 'R25 stranger: capture_log', 'authenticated', v_stranger, 'select count(*) from public.capture_log', 'count', 'none', 'HOLE');
    perform pg_temp.p488(526, 'read', 'R26 stranger: leaderboard_scores', 'authenticated', v_stranger, 'select count(*) from public.leaderboard_scores', 'count', 'none', 'HOLE');
    perform pg_temp.p488(527, 'read', 'R27 stranger: reports', 'authenticated', v_stranger, 'select count(*) from public.reports', 'count', 'none', 'HOLE');
  end if;

  -- ---------------- PROFILES: #512's eight cases ---------------------------
  perform pg_temp.p488(601, 'profiles', 'A signed out: rows listed (= public rows)', 'anon', null,
    'select count(*) from public.profiles', 'count', '=' || v_public, 'HOLE');
  perform pg_temp.p488(602, 'profiles', 'B signed out: read created_at', 'anon', null,
    'select count(created_at) from public.profiles', 'count', 'refused', 'HOLE');
  perform pg_temp.p488(603, 'profiles', 'C signed out: non-ok rows seen', 'anon', null,
    'select count(*) from public.profiles where status <> ''ok''', 'count', 'none', 'HOLE');
  perform pg_temp.p488(604, 'profiles', 'D signed out: fetchGemCredits (' || cardinality(v_ids) || ' names)', 'anon', null,
    format('select count(*) from (select user_id, display_name from public.profiles
            where user_id = any(%L::uuid[]) and status = ''ok'' and display_name is not null) q', v_ids),
    'count', '=' || cardinality(v_ids), 'BROKEN');
  if v_me is null then
    perform pg_temp.s488(605, 'profiles', 'E–H signed in', 'profiles is empty');
  else
    perform pg_temp.p488(605, 'profiles', 'E signed in: loadMyProfile', 'authenticated', v_me,
      format('select count(*) from (select display_name, status from public.profiles where user_id = %L) q', v_me),
      'count', '=1', 'BROKEN');
    perform pg_temp.p488(606, 'profiles', 'F signed in: saveDisplayName upsert', 'authenticated', v_me,
      format('insert into public.profiles (user_id, display_name) values (%L, %L)
              on conflict (user_id) do update set user_id = excluded.user_id, display_name = excluded.display_name',
             v_me, v_me_name), 'run', 'runs', 'BROKEN');
    perform pg_temp.p488(607, 'profiles', 'G signed in: read own created_at', 'authenticated', v_me,
      format('select count(created_at) from public.profiles where user_id = %L', v_me), 'count', 'refused', 'HOLE');
    perform pg_temp.p488(608, 'profiles', 'H signed in: rows listed', 'authenticated', v_me,
      'select count(*) from public.profiles', 'count', '=' || v_h, 'HOLE');
  end if;

  -- ---------------- APP: what the browser really does must still work -------
  perform pg_temp.p488(701, 'app', 'P01 signed out: loadApprovedGems', 'anon', null,
    format('select count(*) from (select %s from public.submissions where status = ''approved'' and merged_into is null limit 50) q', GEM_SELECT),
    'count', 'runs', 'BROKEN');
  perform pg_temp.p488(702, 'app', 'P02 signed out: shared_kv get (tile cache, blocklist)', 'anon', null,
    'select count(*) from (select value from public.shared_kv where key = ''places:blocklist'') q', 'count', 'runs', 'BROKEN');
  perform pg_temp.p488(703, 'app', 'P03 signed out: guides + stops query runs (reads none since #517b)', 'anon', null,
    'select count(*) from public.guides g left join public.guide_stops s on s.guide_id = g.id', 'count', 'runs', 'BROKEN');
  perform pg_temp.p488(704, 'app', 'P04 signed out: search_pin_names', 'anon', null,
    'select count(*) from public.search_pin_names(''park'', 41.88, -87.63, 5, false)', 'count', 'runs', 'BROKEN');
  perform pg_temp.p488(705, 'app', 'P05 signed out: gem_seconds_counts', 'anon', null,
    'select count(*) from public.gem_seconds_counts(array[]::uuid[])', 'count', 'runs', 'BROKEN');
  perform pg_temp.p488(706, 'app', 'P06 signed out: pin_interest_add', 'anon', null,
    'select public.pin_interest_add(41, -88)', 'run', 'runs', 'BROKEN');
  perform pg_temp.p488(707, 'app', 'P07 signed out: activity ping', 'anon', null,
    'insert into public.activity_pings (device_id, event) values (gen_random_uuid(), ''app_open'')', 'run', 'runs', 'BROKEN');
  if v_stranger is null then
    perform pg_temp.s488(708, 'app', 'P08–P13 signed in', 'no account exists');
  else
    perform pg_temp.p488(708, 'app', 'P08 signed in: My gems', 'authenticated', v_stranger,
      format('select count(*) from (select id,name,description,category,lat,lng,status,created_at,name_clean,description_clean
              from public.submissions where submitted_by = %L) q', v_stranger), 'count', 'runs', 'BROKEN');
    perform pg_temp.p488(709, 'app', 'P09 signed in: user_state upsert (own)', 'authenticated', v_stranger,
      format('insert into public.user_state (user_id, key, value, updated_at) values (%L, ''sweep:488'', ''x'', now())
              on conflict (user_id, key) do update set value = excluded.value, updated_at = excluded.updated_at', v_stranger),
      'run', 'runs', 'BROKEN');
    perform pg_temp.p488(710, 'app', 'P10 signed in: save a new guide (save_guide, #517)', 'authenticated', v_stranger,
      'select public.save_guide(''ZZQXW2'', ''{"name":"sweep"}'')',
      'run', 'runs', 'BROKEN');
    perform pg_temp.p488(711, 'app', 'P11 signed in: submit a gem (lands pending)', 'authenticated', v_stranger,
      format('insert into public.submissions (id, name, description, lat, lng, submitted_by, source, status)
              values (%L, ''sweep 488 P11'', ''sweep'', 41.88, -87.63, %L, ''user'', ''pending'')', v_gem_c, v_stranger),
      'run', 'runs', 'BROKEN',
      format('select status = ''pending'' from public.submissions where id = %L', v_gem_c));
    perform pg_temp.p488(712, 'app', 'P12 signed in: leaderboard_top + leaderboard_me', 'authenticated', v_stranger,
      'select (select count(*) from public.leaderboard_top()) + (select count(*) from public.leaderboard_me())', 'count', 'runs', 'BROKEN');
    perform pg_temp.p488(713, 'app', 'P13 signed in: set_leaderboard_visibility', 'authenticated', v_stranger,
      'select public.set_leaderboard_visibility(false)', 'run', 'runs', 'BROKEN');
  end if;
  if v_any_code is null then
    perform pg_temp.s488(714, 'app', 'P14 signed out: open a guide by its code (get_guide, #517)', 'no guide exists');
  else
    perform pg_temp.p488(714, 'app', 'P14 signed out: open a guide by its code (get_guide, #517)', 'anon', null,
      format('select count(*) from (select public.get_guide(%L) as v) q where v is not null', v_any_code),
      'count', '=1', 'BROKEN');
  end if;

  -- ---------------- WRITE: hostile writes must fail or change nothing ------
  perform pg_temp.p488(801, 'write', 'W01 signed out: insert a user_state row', 'anon', null,
    format('insert into public.user_state (user_id, key, value) values (%L, ''sweep:488'', ''x'')', coalesce(v_victim, gen_random_uuid())),
    'run', 'refused', 'HOLE');
  perform pg_temp.p488(802, 'write', 'W02 signed out: submit a gem', 'anon', null,
    format('insert into public.submissions (name, lat, lng, submitted_by, source, status)
            values (''sweep 488 W02'', 41.88, -87.63, %L, ''user'', ''approved'')', coalesce(v_victim, gen_random_uuid())),
    'run', 'refused', 'HOLE');
  perform pg_temp.p488(803, 'write', 'W03 signed out: write the tile cache', 'anon', null,
    'insert into public.shared_kv (key, value) values (''places:v99:sweep488'', ''{}'')', 'run', 'refused', 'HOLE');
  perform pg_temp.p488(804, 'write', 'W04 signed out: delete the tile cache', 'anon', null,
    'delete from public.shared_kv where key like ''places:%''', 'dml', 'none', 'HOLE');
  perform pg_temp.p488(805, 'write', 'W05 signed out: rename a guide', 'anon', null,
    'update public.guides set name = ''sweep''', 'dml', 'none', 'HOLE');
  perform pg_temp.p488(806, 'write', 'W06 signed out: ping with server columns', 'anon', null,
    'insert into public.activity_pings (device_id, event, day, signed_in) values (gen_random_uuid(), ''app_open'', ''2020-01-01'', true)',
    'run', 'refused', 'HOLE');
  perform pg_temp.p488(807, 'write', 'W07 signed out: write pin_interest directly', 'anon', null,
    'insert into public.pin_interest (day, cell_lat, cell_lng, opens) values (current_date, 41, -88, 999999)', 'run', 'refused', 'HOLE');
  perform pg_temp.p488(808, 'write', 'W08 signed out: file a report directly', 'anon', null,
    format('insert into public.reports (target_id, target_source, reason, reported_by) values (''sweep'', ''osm'', %L, %L)',
           coalesce(v_reason, 'gone'), coalesce(v_victim, gen_random_uuid())), 'run', 'refused', 'HOLE');
  perform pg_temp.p488(809, 'write', 'W09 signed out: call review_retry_kick', 'anon', null,
    'select public.review_retry_kick()', 'run', 'refused', 'HOLE');
  perform pg_temp.p488(810, 'write', 'W10 signed out: upload a photo', 'anon', null,
    'insert into storage.objects (bucket_id, name) values (''capture-photos'', ''sweep/488.jpg'')', 'run', 'refused', 'HOLE');
  perform pg_temp.p488(811, 'write', 'W11 signed out: list every guide (#517)', 'anon', null,
    'select count(*) from public.shared_kv where key like ''hunt-code:%''', 'count', 'none', 'HOLE');
  perform pg_temp.p488(812, 'write', 'W12 signed out: call save_guide (#517)', 'anon', null,
    'select public.save_guide(''ZZQXW3'', ''{"name":"sweep"}'')', 'run', 'refused', 'HOLE');
  perform pg_temp.p488(813, 'write', 'W13 signed out: list the relational guides (#517b)', 'anon', null,
    'select count(*) from public.guides', 'count', 'none', 'HOLE');
  perform pg_temp.p488(814, 'write', 'W14 signed out: list the relational guide stops (#517b)', 'anon', null,
    'select count(*) from public.guide_stops', 'count', 'none', 'HOLE');

  if v_stranger is null or v_victim is null then
    perform pg_temp.s488(820, 'write', 'W20–W39 signed-in stranger', 'fewer than two accounts exist');
  else
    perform pg_temp.p488(820, 'write', 'W20 stranger: edit someone''s user_state', 'authenticated', v_stranger,
      format('update public.user_state set value = ''x'' where user_id = %L', v_victim), 'dml', 'none', 'HOLE');
    perform pg_temp.p488(821, 'write', 'W21 stranger: delete someone''s user_state', 'authenticated', v_stranger,
      format('delete from public.user_state where user_id = %L', v_victim), 'dml', 'none', 'HOLE');
    perform pg_temp.p488(822, 'write', 'W22 stranger: write a user_state row as someone', 'authenticated', v_stranger,
      format('insert into public.user_state (user_id, key, value) values (%L, ''sweep:488'', ''x'')', v_victim), 'run', 'refused', 'HOLE');
    perform pg_temp.p488(823, 'write', 'W23 stranger: rename someone''s profile', 'authenticated', v_stranger,
      format('update public.profiles set display_name = ''Sweep Probe'' where user_id = %L', v_victim), 'dml', 'none', 'HOLE');
    perform pg_temp.p488(824, 'write', 'W24 stranger: create a profile as someone', 'authenticated', v_stranger,
      format('insert into public.profiles (user_id, display_name) values (%L, ''Sweep Probe'')', v_victim), 'run', 'refused', 'HOLE');
    perform pg_temp.p488(825, 'write', 'W25 stranger: edit someone''s progress', 'authenticated', v_stranger,
      format('update public.progress set mode = ''x'' where user_id is distinct from %L', v_stranger), 'dml', 'none', 'HOLE');
    perform pg_temp.p488(826, 'write', 'W26 stranger: delete others'' hunts', 'authenticated', v_stranger,
      format('delete from public.hunts where created_by is distinct from %L', v_stranger), 'dml', 'none', 'HOLE');
    -- #477 case A: the hostile approved insert must land as an ordinary pending row
    perform pg_temp.p488(827, 'write', 'W27 signed in: approved insert with server columns (#477 A)', 'authenticated', v_stranger,
      format('insert into public.submissions (id, name, description, lat, lng, submitted_by, status, source, category, city,
                ai_decision, ai_status, ai_reason, ai_confidence, ai_reviewed_at, reviewed_by, reviewed_at, review_note,
                name_clean, description_clean, resolved_description, resolved_source, created_at, ai_retry_count)
              values (%1$L, ''sweep 488 W27'', ''sweep'', 41.88, -87.63, %2$L, ''approved'', ''seed:reddit'', ''history'', ''Chicago'',
                ''approve'', ''ok'', ''sweep'', 0.99, now(), %2$L, now(), ''sweep'',
                ''sweep'', ''sweep'', ''sweep'', ''wiki'', ''2020-01-01'', 6)', v_gem, v_stranger),
      'run', 'clamped', 'HOLE',
      format('select status = ''pending'' and source = ''user'' and category is null and city is null
                and ai_decision is null and ai_status is null and ai_reason is null and ai_reviewed_at is null
                and reviewed_by is null and reviewed_at is null and review_note is null
                and name_clean is null and description_clean is null
                and resolved_description is null and resolved_source is null
                and created_at > now() - interval ''1 minute'' and ai_retry_count = 0
              from public.submissions where id = %L', v_gem));
    perform pg_temp.p488(828, 'write', 'W28 signed in: approve own gem by update', 'authenticated', v_stranger,
      format('update public.submissions set status = ''approved'' where submitted_by = %L', v_stranger), 'dml', 'refused', 'HOLE');
    perform pg_temp.p488(829, 'write', 'W29 signed in: set a resolved story', 'authenticated', v_stranger,
      format('update public.submissions set resolved_description = ''x'' where submitted_by = %L', v_stranger), 'dml', 'refused', 'HOLE');
    perform pg_temp.p488(830, 'write', 'W30 signed in: write the tile cache', 'authenticated', v_stranger,
      'insert into public.shared_kv (key, value) values (''places:v99:sweep488'', ''{}'')', 'run', 'refused', 'HOLE');
    perform pg_temp.p488(831, 'write', 'W31 signed in: delete the tile cache', 'authenticated', v_stranger,
      'delete from public.shared_kv where key like ''places:%''', 'dml', 'none', 'HOLE');
    perform pg_temp.p488(832, 'write', 'W32 signed in: write own leaderboard score', 'authenticated', v_stranger,
      format('insert into public.leaderboard_scores (user_id, distinct_pins) values (%L, 99999)
              on conflict (user_id) do update set distinct_pins = 99999', v_stranger), 'run', 'refused', 'HOLE');
    perform pg_temp.p488(833, 'write', 'W33 signed in: write capture_log', 'authenticated', v_stranger,
      format('insert into public.capture_log (user_id, pin_id, pin_type, reported_lat, reported_lng, status)
              values (%L, ''sweep'', ''osm'', 41.88, -87.63, ''ok'')', v_stranger), 'run', 'refused', 'HOLE');
    perform pg_temp.p488(834, 'write', 'W34 signed in: add a vouch directly', 'authenticated', v_stranger,
      format('insert into public.gem_seconds (submission_id, user_id) values (%L, %L)', gen_random_uuid(), v_stranger),
      'run', 'refused', 'HOLE');
    perform pg_temp.p488(835, 'write', 'W35 signed in: file a report directly', 'authenticated', v_stranger,
      format('insert into public.reports (target_id, target_source, reason, reported_by) values (''sweep'', ''osm'', %L, %L)',
             coalesce(v_reason, 'gone'), v_stranger), 'run', 'refused', 'HOLE');
    perform pg_temp.p488(836, 'write', 'W36 signed in: call approve_submission', 'authenticated', v_stranger,
      format('select public.approve_submission(%L)', gen_random_uuid()), 'run', 'refused', 'HOLE');
    perform pg_temp.p488(837, 'write', 'W37 signed in: call curated_category_backfill', 'authenticated', v_stranger,
      'select count(*) from public.curated_category_backfill(false)', 'count', 'refused', 'HOLE');
    perform pg_temp.p488(838, 'write', 'W38 stranger: upload into someone''s photo folder', 'authenticated', v_stranger,
      format('insert into storage.objects (bucket_id, name) values (''capture-photos'', %L)', v_victim::text || '/sweep488.jpg'),
      'run', 'refused', 'HOLE');
    perform pg_temp.p488(839, 'write', 'W39 stranger: delete others'' guides', 'authenticated', v_stranger,
      'delete from public.guides', 'dml', 'none', 'HOLE');

    if v_kv_key is null then
      perform pg_temp.s488(840, 'write', 'W40 stranger: edit an owned guide blob', 'no owned, non-editable hunt-code blob');
    else
      perform pg_temp.p488(840, 'write', 'W40 stranger: edit an owned guide blob', 'authenticated', v_stranger,
        format('update public.shared_kv set value = ''{}'' where key = %L', v_kv_key), 'dml', 'none', 'HOLE');
    end if;
    if v_kv_key is null then
      perform pg_temp.s488(843, 'write', 'W43 stranger: save over an owned guide via save_guide (#517)', 'no owned, non-editable hunt-code blob');
    else
      perform pg_temp.p488(843, 'write', 'W43 stranger: save over an owned guide via save_guide (#517)', 'authenticated', v_stranger,
        format('select public.save_guide(%L, ''{"name":"sweep"}'')', substr(v_kv_key, 11)), 'run', 'refused', 'HOLE');
    end if;
    if v_guide is null then
      perform pg_temp.s488(841, 'write', 'W41 stranger: rename an owned guide', 'no owned relational guide');
    else
      perform pg_temp.p488(841, 'write', 'W41 stranger: rename an owned guide', 'authenticated', v_stranger,
        format('update public.guides set name = ''sweep'' where id = %L', v_guide), 'dml', 'none', 'HOLE');
    end if;
    if v_frozen is null then
      perform pg_temp.s488(842, 'write', 'W42 signed in: add a stop to a frozen guide (#411)', 'no unowned guide');
    else
      perform pg_temp.p488(842, 'write', 'W42 signed in: add a stop to a frozen guide (#411)', 'authenticated', v_stranger,
        format('insert into public.guide_stops (guide_id, stop_id, added_by) values (%L, ''sweep488'', %L)', v_frozen, v_stranger),
        'run', 'refused', 'HOLE');
    end if;
  end if;

  -- Guards that CLAMP: the write runs, but the protected column must not move.
  if v_me is null then
    perform pg_temp.s488(850, 'write', 'W50 own profile: change status / created_at', 'profiles is empty');
  else
    perform pg_temp.p488(850, 'write', 'W50 own profile: change status / created_at', 'authenticated', v_me,
      format('update public.profiles set status = %L, created_at = ''2020-01-01'' where user_id = %L',
             case when v_me_stat = 'ok' then 'blocked' else 'ok' end, v_me),
      'dml', 'clamped', 'HOLE',
      format('select status = %L and created_at = %L::timestamptz from public.profiles where user_id = %L',
             v_me_stat, v_me_made, v_me));
  end if;
  if v_kv_key is null then
    perform pg_temp.s488(851, 'write', 'W51 owner: hand a guide blob to someone (#135)', 'no owned hunt-code blob');
  else
    perform pg_temp.p488(851, 'write', 'W51 owner: hand a guide blob to someone (#135)', 'authenticated', v_kv_owner,
      format('update public.shared_kv set owner = %L where key = %L', gen_random_uuid(), v_kv_key),
      'dml', 'clamped', 'HOLE',
      format('select owner = %L from public.shared_kv where key = %L', v_kv_owner, v_kv_key));
  end if;
  if v_guide is null then
    perform pg_temp.s488(852, 'write', 'W52 owner: change a guide''s owner or code (#411)', 'no owned relational guide');
  else
    perform pg_temp.p488(852, 'write', 'W52 owner: change a guide''s owner or code (#411)', 'authenticated', v_guide_owner,
      format('update public.guides set owner = %L, code = ''SWEEP8'' where id = %L', gen_random_uuid(), v_guide),
      'dml', 'clamped', 'HOLE',
      format('select owner = %L and code <> ''SWEEP8'' from public.guides where id = %L', v_guide_owner, v_guide));
  end if;
end $$;

-- =====================================================================
-- SELF-TEST: break one thing at a time, inside a sub-transaction, and prove
-- the check above sees it. Undone by a deliberate raise each time. A self-test
-- that does not fire means that check is blind — the summary says BLIND.
-- =====================================================================
do $$
declare
  v_hit  boolean;
  v_err  text;
  v_case record;
begin
  for v_case in select * from (values
      (901, 'T1 drop guard trigger guides_guard_trg',
            'drop trigger guides_guard_trg on public.guides',
            'select exists (select 1 from pg_temp.c488_triggers() where item like ''%guides_guard_trg'' and verdict like ''HOLE%'')'),
      (902, 'T2 switch RLS off on report_reason_meta',
            'alter table public.report_reason_meta disable row level security',
            'select exists (select 1 from pg_temp.c488_rls() where item = ''public.report_reason_meta'' and verdict = ''HOLE'')'),
      (903, 'T3 add an open write policy (#133)',
            'create policy sweep_488_open on public.report_reason_meta for update to anon using (true)',
            'select exists (select 1 from pg_temp.c488_policies() where item like ''%sweep_488_open'' and verdict like ''HOLE%'')'),
      (904, 'T4 grant the browser a server-only table',
            'grant select on public.capture_log to anon',
            'select exists (select 1 from pg_temp.c488_grants() where item = ''no browser access: capture_log'' and verdict = ''HOLE'')'),
      (905, 'T5 widen the profiles column allowlist (#512)',
            'grant select (created_at) on public.profiles to anon',
            'select exists (select 1 from pg_temp.c488_grants() where item = ''select columns: profiles → anon'' and verdict = ''HOLE'')'),
      (906, 'T6 hand the browser an unused write (#513)',
            'grant truncate on public.reports to anon',
            'select exists (select 1 from pg_temp.c488_grants() where item = ''write grants: reports'' and verdict like ''DRIFT%'')')
    ) v(ord, name, break_sql, see_sql)
  loop
    v_hit := null; v_err := null;
    update sweep_488_plan set planned = planned + 1;
    begin
      execute v_case.break_sql;
      execute v_case.see_sql into v_hit;
      raise exception using errcode = 'P0488', message = 'self-test rollback';
    exception
      when sqlstate 'P0488' then null;
      when others then v_err := sqlerrm;
    end;
    insert into sweep_488 values (v_case.ord, 'self-test', v_case.name,
      case when v_err is not null then 'could not break it: ' || left(v_err, 160)
           when v_hit then 'detected, then undone'
           else 'NOT detected, then undone' end,
      case when v_err is null and v_hit then 'OK' else 'BLIND' end);
  end loop;
end $$;

-- =====================================================================
-- SUMMARY — fails closed: a run where fewer rows reported than were planned
-- is never a pass.
-- =====================================================================
insert into sweep_488
select 0, 'summary', '488-sweep-v4',
       (select count(*) from sweep_488 where section in ('rls','policy','grant','trigger')) || ' catalog checks · '
       || (select count(*) from sweep_488 where section in ('read','profiles','app','write','self-test')) || ' of '
       || (select planned from sweep_488_plan) || ' probes reported · '
       || (select count(*) from sweep_488 where verdict like 'HOLE%') || ' HOLE · '
       || (select count(*) from sweep_488 where verdict like 'BROKEN%') || ' BROKEN · '
       || (select count(*) from sweep_488 where verdict like 'DRIFT%') || ' DRIFT · '
       || (select count(*) from sweep_488 where verdict like 'KNOWN%') || ' KNOWN · '
       || (select count(*) from sweep_488 where verdict = 'SKIPPED') || ' SKIPPED',
       case
         when (select count(*) from sweep_488 where section in ('read','profiles','app','write','self-test'))
              <> (select planned from sweep_488_plan)                          then 'INCOMPLETE'
         when exists (select 1 from sweep_488 where verdict = 'BLIND')         then 'BLIND'
         when exists (select 1 from sweep_488 where verdict like 'HOLE%')      then 'HOLE'
         when exists (select 1 from sweep_488 where verdict like 'BROKEN%')    then 'BROKEN'
         when exists (select 1 from sweep_488 where verdict like 'DRIFT%')     then 'DRIFT'
         else 'CLOSED' end;

select section, item, detail, verdict
from sweep_488
order by ord, item;
