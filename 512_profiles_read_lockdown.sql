-- 512_profiles_read_lockdown.sql — #512: the public `profiles` read hands out
-- more than the app uses. Run in the Supabase SQL editor, whole file.
-- Idempotent — safe to re-run.
--
-- WHY. The read policy `profiles read` is `using (true)` and anon/authenticated
-- hold table-level SELECT, so the publishable key (shipped in index.html) can
-- download EVERY row and EVERY column without signing in: the whole account
-- list (including people who never set a name, so there is nothing of theirs
-- to credit), each account's signup date (`created_at`), its last-rename time
-- (`updated_at`), and `status` — i.e. which accounts moderation has blocked.
-- Found 2026-10-05 from an outside scanner report; confirmed live (21 rows).
--
-- WHAT STAYS PUBLIC, ON PURPOSE (#23, #156). A gem's "Submitted by ___" credit
-- renders for signed-out visitors, so OTHER people's names must stay readable.
-- privacy.html already tells users their display name is public. The scanner's
-- suggested fix ("each user sees only their own row") would blank every credit
-- line, silently — #154: a refused read looks exactly like "nobody set a name".
--
-- WHAT IT DOES. Two narrowings, the #276 allowlist shape:
--   ROWS:    others' rows are visible only when status='ok' AND a name is set
--            (exactly what the credit lookup asks for); your OWN row is always
--            visible to you, so Settings and the name save keep working for a
--            nameless or blocked account.
--   COLUMNS: anon/authenticated lose table-level SELECT and get it back on
--            user_id, display_name, status ONLY. created_at / updated_at are
--            no longer readable from the browser at all.
--
-- WHAT THE APP READS (index.html 2026.10.02d, main @ 14c290d, read 2026-10-05):
--   loadMyProfile   select display_name,status  where user_id = me
--   saveDisplayName upsert {user_id, display_name} on conflict user_id
--   fetchGemCredits select user_id,display_name where user_id in (...)
--                   and status='ok' and display_name is not null
-- All three stay inside the grant + policy below. No index.html change.
--
-- WHO IS NOT TOUCHED. service_role (app-report, delete-account, every tool)
-- and the SQL editor (postgres) bypass RLS and keep full column access.
-- INSERT / UPDATE grants and policies, the profiles_guard trigger and
-- handle_new_user are unchanged.
--
-- FAILS CLOSED ON A NEW COLUMN. Same rule as #276 on `submissions`: a new
-- profiles column a client must read has to be ADDED to the grant below and
-- this file re-run, or the read fails. That is the intended direction.
--
-- RESTORE ORDER. 409_schema_baseline.sql holds the PRE-#512 policy and grants;
-- re-run this file after any restore from it, until #413 refreshes the
-- baseline.
--
-- VERIFY. Run 512_profiles_read_probe.sql: summary CLOSED, policy stamp
-- 512-profiles-read-v1. This file also refuses to commit if the result is
-- not what it says (the verify block below raises and everything rolls back).
--
-- BACK-OUT (restores the pre-#512 posture exactly):
--   drop policy "profiles read" on public.profiles;
--   create policy "profiles read" on public.profiles as permissive for select
--     to public using (true);
--   grant select on table public.profiles to anon, authenticated;

begin;

-- Preflight: the baseline has exactly one SELECT policy here. A second one
-- would OR with ours (permissive) and quietly keep the table open.
do $$
declare v_other text;
begin
  select string_agg(policyname, ', ') into v_other
  from pg_policies
  where schemaname = 'public' and tablename = 'profiles'
    and cmd in ('SELECT', 'ALL') and policyname <> 'profiles read';
  if v_other is not null then
    raise exception '#512 stopped: another SELECT policy on profiles would keep it open: %', v_other;
  end if;
end $$;

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles
  as permissive for select to public
  using (
    user_id = auth.uid()
    or (status = 'ok' and display_name is not null)
  );
comment on policy "profiles read" on public.profiles is '512-profiles-read-v1';

-- Revoke first: revoking table-level SELECT also strips column grants.
revoke select on table public.profiles from anon, authenticated;
grant select (user_id, display_name, status) on table public.profiles to anon, authenticated;

-- Verify before commit; any raise rolls the whole file back.
do $$
declare r text; c text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.profiles', 'SELECT') then
      raise exception '#512 verify: % still holds table-level SELECT', r;
    end if;
    foreach c in array array['user_id', 'display_name', 'status'] loop
      if not has_column_privilege(r, 'public.profiles', c, 'SELECT') then
        raise exception '#512 verify: % cannot read %, the app needs it', r, c;
      end if;
    end loop;
    foreach c in array array['created_at', 'updated_at'] loop
      if has_column_privilege(r, 'public.profiles', c, 'SELECT') then
        raise exception '#512 verify: % can still read %', r, c;
      end if;
    end loop;
  end loop;
  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'profiles'
        and cmd in ('SELECT', 'ALL')) <> 1 then
    raise exception '#512 verify: expected exactly one SELECT policy on profiles';
  end if;
end $$;

commit;

-- One-grid readout (no PII: counts only).
select 'policy'  as item, (select qual from pg_policies
         where schemaname = 'public' and tablename = 'profiles'
           and policyname = 'profiles read') as detail
union all
select 'stamp', obj_description(
         (select oid from pg_policy
          where polrelid = 'public.profiles'::regclass
            and polname = 'profiles read'), 'pg_policy')
union all
select 'anon columns', (select string_agg(column_name, ', ' order by column_name)
         from information_schema.column_privileges
         where table_schema = 'public' and table_name = 'profiles'
           and grantee = 'anon' and privilege_type = 'SELECT')
union all
select 'rows: total / now public',
       (select count(*) from public.profiles)::text || ' / ' ||
       (select count(*) from public.profiles
        where status = 'ok' and display_name is not null)::text;
