-- 512_profiles_read_probe.sql — #512: what can the browser read from
-- `profiles`? Run in the Supabase SQL editor, whole file.
--
-- SAFE TO RUN ON THE LIVE DB, ANY NUMBER OF TIMES. Every test runs in a
-- sub-transaction rolled back by a deliberate raise (the #477 method), so the
-- one write test (F, the name save) changes nothing. The only object it
-- creates is a TEMP table (probe_512) that vanishes with the session.
-- NO PII IN THE OUTPUT: counts and error text only, never a name or an id.
--
-- RUN IT TWICE: once BEFORE 512_profiles_read_lockdown.sql (expect OPEN) and
-- once AFTER (expect every row OK, summary CLOSED). One grid:
--   section = live    → policy, column grants, the #512 stamp, row counts
--   section = case    → the eight tests
--   section = summary → one line: OPEN, CLOSED, or BROKEN
--
-- Each case impersonates a browser role through the same JWT settings
-- PostgREST uses, so RLS and grants both apply. "Public rows" below means
-- status='ok' with a name set — the rows a gem credit can use.
--   EXPOSURE (a miss reads OPEN):
--   A  signed out: how many rows can it list?          expect = public rows
--   B  signed out: can it read created_at?             expect refused
--   C  signed out: can it see a non-'ok' (blocked) row? expect 0
--   G  signed in:  can it read created_at on its OWN row? expect refused
--   H  signed in:  how many rows can it list?          expect public rows
--                                                      (+1 if its own row
--                                                       isn't public)
--   APP PATHS (a miss reads BROKEN — the app would lose something):
--   D  signed out: fetchGemCredits' exact query        expect every name back
--   E  signed in:  loadMyProfile's exact query         expect its own row
--   F  signed in:  saveDisplayName's upsert            expect it runs
-- E/F/G/H use an account with NO name when one exists (the case a narrowed
-- policy could break), else any account.

drop table if exists probe_512;
create temp table probe_512 (
  ord     int,
  section text,
  item    text,
  detail  text,
  verdict text
);

-- ---------------------------------------------------------------------
-- LIVE STATE
-- ---------------------------------------------------------------------
insert into probe_512
select 10, 'live', 'policy: ' || policyname,
       cmd || ' to ' || array_to_string(roles, ',') ||
       coalesce(' | using ' || qual, '') ||
       coalesce(' | with check ' || with_check, ''),
       ''
from pg_policies
where schemaname = 'public' and tablename = 'profiles';

insert into probe_512
select 20, 'live', 'select grant: ' || g.grantee,
       case when has_table_privilege(g.grantee, 'public.profiles', 'SELECT')
            then 'TABLE-LEVEL (every column)'
            else coalesce((select string_agg(column_name, ', ' order by column_name)
                           from information_schema.column_privileges
                           where table_schema = 'public' and table_name = 'profiles'
                             and grantee = g.grantee and privilege_type = 'SELECT'),
                          '(none)') end,
       ''
from (values ('anon'), ('authenticated')) g(grantee);

insert into probe_512
select 30, 'live', 'policy stamp',
       coalesce(obj_description(
         (select oid from pg_policy
          where polrelid = 'public.profiles'::regclass
            and polname = 'profiles read'), 'pg_policy'),
         '(no stamp — #512 not applied)'),
       '';

insert into probe_512
select 40, 'live', 'rows',
       'total ' || count(*) ||
       ' | public (ok + named) ' || count(*) filter (where status = 'ok' and display_name is not null) ||
       ' | nameless ' || count(*) filter (where display_name is null) ||
       ' | not ok ' || count(*) filter (where status <> 'ok'),
       ''
from public.profiles;

-- ---------------------------------------------------------------------
-- THE PROBE
-- ---------------------------------------------------------------------
-- p_expect: a number (the count the query must return), 'refused', or 'runs'.
-- p_miss:   the verdict when the expectation fails — 'OPEN' or 'BROKEN'.
create or replace function pg_temp.p512(
  p_ord int, p_case text, p_role text, p_uid uuid,
  p_sql text, p_expect text, p_miss text
) returns void language plpgsql as $$
declare
  v_n   bigint;
  v_err text;
  v_det text;
  v_ok  boolean;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', p_role)::text, true);
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    perform set_config('request.jwt.claim.role', p_role, true);
    execute format('set local role %I', p_role);

    if p_expect = 'runs' then
      execute p_sql;
    else
      execute p_sql into v_n;
    end if;

    execute 'reset role';
    raise exception using errcode = 'P0512', message = 'probe rollback';
  exception
    when sqlstate 'P0512' then v_err := null;      -- ran, now undone
    when others then v_err := sqlerrm; v_n := null; -- refused
  end;

  if v_err is not null then
    v_det := 'REFUSED: ' || v_err;
    v_ok  := (p_expect = 'refused');
  elsif p_expect = 'runs' then
    v_det := 'ran (rolled back)';
    v_ok  := true;
  elsif p_expect = 'refused' then
    v_det := 'READ ' || v_n || ' value(s)';
    v_ok  := false;
  else
    v_det := 'got ' || v_n || ', expected ' || p_expect;
    v_ok  := (v_n = p_expect::bigint);
  end if;

  insert into probe_512 values (p_ord, 'case', p_case, v_det,
    case when v_ok then 'OK' else p_miss end);
end $$;

do $$
declare
  v_public bigint;
  v_ids    uuid[];
  v_me     uuid;
  v_name   text;
  v_mine_public boolean;
  v_h      bigint;
begin
  select count(*) into v_public
  from public.profiles where status = 'ok' and display_name is not null;

  select coalesce(array_agg(user_id), '{}') into v_ids
  from (select user_id from public.profiles
        where status = 'ok' and display_name is not null
        order by created_at limit 5) s;

  select user_id into v_me
  from public.profiles order by (display_name is null) desc, created_at limit 1;
  select display_name into v_name from public.profiles where user_id = v_me;
  v_mine_public := exists (select 1 from public.profiles
                           where user_id = v_me and status = 'ok' and display_name is not null);
  v_h := v_public + case when v_mine_public then 0 else 1 end;

  perform pg_temp.p512(110, 'A  signed out: rows listed', 'anon', null,
    'select count(*) from public.profiles', v_public::text, 'OPEN');

  perform pg_temp.p512(120, 'B  signed out: read created_at', 'anon', null,
    'select count(created_at) from public.profiles', 'refused', 'OPEN');

  perform pg_temp.p512(130, 'C  signed out: non-ok rows seen', 'anon', null,
    'select count(*) from public.profiles where status <> ''ok''', '0', 'OPEN');

  perform pg_temp.p512(140, 'D  signed out: fetchGemCredits (' || cardinality(v_ids) || ' names)', 'anon', null,
    format('select count(*) from (select user_id, display_name from public.profiles
            where user_id = any(%L::uuid[]) and status = ''ok''
              and display_name is not null) q', v_ids),
    cardinality(v_ids)::text, 'BROKEN');

  if v_me is null then
    insert into probe_512 values (150, 'case', 'E–H  signed in', 'skipped: profiles is empty', 'OK');
  else
    perform pg_temp.p512(150, 'E  signed in: loadMyProfile (own row'
        || case when v_name is null then ', nameless)' else ')' end, 'authenticated', v_me,
      format('select count(*) from (select display_name, status from public.profiles
              where user_id = %L) q', v_me),
      '1', 'BROKEN');

    perform pg_temp.p512(160, 'F  signed in: saveDisplayName upsert', 'authenticated', v_me,
      format('insert into public.profiles (user_id, display_name) values (%L, %L)
              on conflict (user_id) do update
              set user_id = excluded.user_id, display_name = excluded.display_name',
             v_me, v_name),
      'runs', 'BROKEN');

    perform pg_temp.p512(170, 'G  signed in: read own created_at', 'authenticated', v_me,
      format('select count(created_at) from public.profiles where user_id = %L', v_me),
      'refused', 'OPEN');

    perform pg_temp.p512(180, 'H  signed in: rows listed', 'authenticated', v_me,
      'select count(*) from public.profiles', v_h::text, 'OPEN');
  end if;
end $$;

insert into probe_512
select 900, 'summary',
       case when bool_or(verdict = 'BROKEN') then 'BROKEN'
            when bool_or(verdict = 'OPEN')   then 'OPEN'
            else 'CLOSED' end,
       case when bool_or(verdict = 'BROKEN') then 'an app read fails — back out #512 (header of the lockdown file)'
            when bool_or(verdict = 'OPEN')   then 'the browser can read more than the app needs'
            else 'browser reads only public names, plus its own row' end,
       ''
from probe_512 where section = 'case';

select section, item, detail, verdict from probe_512 order by ord;
