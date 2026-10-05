-- 513_revoke_browser_grants.sql — #513: take back the write privileges the
-- browser roles (anon, authenticated) were handed by Supabase's defaults but
-- the app never uses. STAMP: 513-browser-grants-v1
--
-- RUN: Supabase dashboard → SQL Editor → paste this whole file → Run. ONE
-- request = ONE transaction (handoff §5): the self-check at the bottom raises
-- if the result is not exactly the keep-list below, and then NOTHING changes.
-- Safe to run twice (a revoke of a privilege not held is a no-op).
-- Afterwards run 488_rls_audit_sweep.sql (v2): expect CLOSED, 2 KNOWN.
--
-- WHY. Nothing here is reachable today — TRUNCATE is not a PostgREST verb and
-- every other unused write is denied by RLS (no policy for that command). This
-- is defence in depth: with the grant gone, one mistaken permissive policy or
-- one table with RLS switched off no longer makes it writable from a browser.
--
-- THE KEEP-LIST — every browser write the app makes (index.html @ c7b3fb0;
-- capture-verify uses the anon key only to call nearby-places, and every other
-- function writes with the service role):
--   authenticated  shared_kv     INSERT, UPDATE   supabaseStorage.set shared (guide blob upsert)
--   authenticated  user_state    INSERT, UPDATE   supabaseStorage.set private (upsert)
--   authenticated  profiles      INSERT, UPDATE   saveDisplayName (upsert)
--   authenticated  submissions   INSERT           submitGem
--   anon + auth    activity_pings INSERT (device_id, event) — column grants, #10
--   authenticated  guides, guide_stops  INSERT, UPDATE, DELETE — set by #411 for
--                  #277's cutover; NOT touched here
-- Reads are NOT touched: every SELECT grant (table- and column-level) stays as
-- it is, and the self-check proves it. That matters: in Postgres, revoking a
-- table-level privilege also revokes that privilege's column grants, so this
-- file never revokes SELECT anywhere, nor INSERT on activity_pings.
-- service_role is never touched (every function and tool keeps full access).
--
-- WHAT GOES (from both browser roles unless marked):
--   all 10 tables below          TRUNCATE, REFERENCES, TRIGGER, MAINTAIN (PG17)
--   hunts, hunt_points, progress, reports, gem_seconds, curated_descriptions
--                                + INSERT, UPDATE, DELETE (the browser writes none)
--   submissions                  + DELETE; INSERT from anon
--   user_state, shared_kv, profiles
--                                + DELETE; INSERT, UPDATE from anon
--   sequence capture_log_id_seq  USAGE, SELECT, UPDATE (capture_log is server-only)
--
-- UNDO (restores Supabase's defaults exactly as 409_schema_baseline.sql held
-- them on 2026-10-05 — run only if a browser path breaks):
--   grant delete, insert, maintain, references, trigger, truncate on table public.submissions to anon, authenticated;
--   grant delete, insert, maintain, references, select, trigger, truncate, update on table
--     public.hunts, public.hunt_points, public.progress, public.user_state, public.shared_kv,
--     public.reports, public.gem_seconds, public.curated_descriptions to anon, authenticated;
--   grant delete, insert, maintain, references, trigger, truncate, update on table public.profiles to anon, authenticated;
--   grant select, update, usage on sequence public.capture_log_id_seq to anon, authenticated;

-- Snapshot every browser SELECT before anything changes (the self-check
-- compares against it).
drop table if exists g513_select_before;
create temp table g513_select_before as
select c.relname, r.rolname, a.attname
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join (values ('anon'), ('authenticated')) r(rolname)
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  and has_column_privilege(r.rolname, c.oid, a.attname, 'SELECT');

-- ---------------------------------------------------------------------
-- THE REVOKES
-- ---------------------------------------------------------------------
-- Tables the browser never writes.
revoke insert, update, delete, truncate, references, trigger
  on table public.hunts, public.hunt_points, public.progress,
           public.reports, public.gem_seconds, public.curated_descriptions
  from anon, authenticated;

-- Tables the browser writes: keep exactly the writes it makes.
revoke delete, truncate, references, trigger
  on table public.submissions, public.user_state, public.shared_kv, public.profiles
  from anon, authenticated;
revoke insert on table public.submissions from anon;
revoke insert, update on table public.user_state, public.shared_kv, public.profiles from anon;

-- capture_log is written only by capture-verify (service role).
revoke all on sequence public.capture_log_id_seq from anon, authenticated;

-- MAINTAIN exists from Postgres 17 (the live DB); skipped on older servers.
do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on table public.submissions, public.user_state, public.shared_kv,
               public.profiles, public.hunts, public.hunt_points, public.progress,
               public.reports, public.gem_seconds, public.curated_descriptions
             from anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- SELF-CHECK — raises (and so undoes the whole file) unless the browser's
-- write privileges are now EXACTLY the keep-list, every SELECT is unchanged,
-- and the activity_pings column grants survived.
-- ---------------------------------------------------------------------
do $$
declare
  v_bad   text;
  v_privs text[] := array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
                    || case when current_setting('server_version_num')::int >= 170000
                            then array['MAINTAIN'] else array[]::text[] end;
begin
  with keep(t, r, p) as (values
      ('shared_kv','authenticated','INSERT'), ('shared_kv','authenticated','UPDATE'),
      ('user_state','authenticated','INSERT'), ('user_state','authenticated','UPDATE'),
      ('profiles','authenticated','INSERT'), ('profiles','authenticated','UPDATE'),
      ('submissions','authenticated','INSERT'),
      ('guides','authenticated','INSERT'), ('guides','authenticated','UPDATE'), ('guides','authenticated','DELETE'),
      ('guide_stops','authenticated','INSERT'), ('guide_stops','authenticated','UPDATE'), ('guide_stops','authenticated','DELETE')),
  held as (
    select c.relname as t, r.rolname as r, p.p
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) r(rolname)
    cross join unnest(v_privs) p(p)
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and has_table_privilege(r.rolname, c.oid, p.p))
  select string_agg(x, '; ') into v_bad from (
    select 'still held: ' || r || ' ' || p || ' on ' || t as x from held
     where (t, r, p) not in (select * from keep)
    union all
    select 'lost: ' || r || ' ' || p || ' on ' || t from keep
     where (t, r, p) not in (select * from held)) s;
  if v_bad is not null then
    raise exception '#513 self-check: write grants are not the keep-list — %', v_bad;
  end if;

  if has_sequence_privilege('anon', 'public.capture_log_id_seq', 'USAGE, SELECT, UPDATE')
     or has_sequence_privilege('authenticated', 'public.capture_log_id_seq', 'USAGE, SELECT, UPDATE') then
    raise exception '#513 self-check: a browser role still holds capture_log_id_seq';
  end if;

  select string_agg(r || ' ' || col, ', ') into v_bad
  from (values ('anon','device_id'), ('anon','event'), ('authenticated','device_id'), ('authenticated','event')) v(r, col)
  where not has_column_privilege(r, 'public.activity_pings', col, 'INSERT');
  if v_bad is not null then
    raise exception '#513 self-check: activity_pings insert grant lost for %', v_bad;
  end if;

  select string_agg(distinct relname || ' (' || rolname || ')', ', ') into v_bad
  from (
    (select relname, rolname, attname from g513_select_before
     except
     select c.relname, r.rolname, a.attname
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join (values ('anon'), ('authenticated')) r(rolname)
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
       and has_column_privilege(r.rolname, c.oid, a.attname, 'SELECT'))
    union all
    (select c.relname, r.rolname, a.attname
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join (values ('anon'), ('authenticated')) r(rolname)
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
       and has_column_privilege(r.rolname, c.oid, a.attname, 'SELECT')
     except
     select relname, rolname, attname from g513_select_before)) d;
  if v_bad is not null then
    raise exception '#513 self-check: a SELECT grant changed on %', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- RESULT — what each browser role can now write, per table.
-- ---------------------------------------------------------------------
select c.relname as "table",
       r.rolname as role,
       coalesce(nullif(array_to_string(array(
         select p from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
                               || case when current_setting('server_version_num')::int >= 170000
                                       then array['MAINTAIN'] else array[]::text[] end) p
         where has_table_privilege(r.rolname, c.oid, p)), ', '), ''),
         case when c.relname = 'activity_pings' and has_any_column_privilege(r.rolname, c.oid, 'INSERT')
              then 'INSERT (device_id, event)' else '—' end) as can_write,
       '513-browser-grants-v1' as stamp
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join (values ('anon'), ('authenticated')) r(rolname)
where n.nspname = 'public' and c.relkind in ('r', 'p')
order by 1, 2;
