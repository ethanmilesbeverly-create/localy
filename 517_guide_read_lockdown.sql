-- 517_guide_read_lockdown.sql — #517: a shared guide can be OPENED by its code,
-- but no longer LISTED. Supabase SQL editor (runs as postgres).
-- Stamp: 517-guides-v1 (2026-10-06).
--
-- THE PROBLEM. `shared_kv_public_read` is `for select to public using (true)`, so
-- anyone holding the browser's public (anon) key can run
--   select key, value from shared_kv where key like 'hunt-code:%'
-- and get EVERY shared guide — its name and every stop's coordinates — not just
-- the one whose code they were given. (The #26 comment in index.html says #133
-- limited anon reads to `hunt-code:%`; the live policy says otherwise.)
--
-- THE FIX, in three steps, IN THIS ORDER:
--   BLOCK 2 (now, additive — changes nothing for anyone): two functions.
--     get_guide(code)        → one guide's value, by its EXACT code. anon + auth.
--     save_guide(code,value) → the guide write, with the SAME rules the table's
--                              insert/update policies enforce today: a new guide
--                              is owned by its maker; an existing one may be
--                              written by its owner, or by anyone if it has no
--                              owner (pre-#135 rows) or is marked editable (#202).
--                              The owner never changes (shared_kv_lock_owner).
--                              Signed-in users only.
--   THEN deploy index.html 2026.10.06a + landing.html 2026.10.06a (Pages), which
--     read and write guides ONLY through these two functions, and confirm the
--     version in Settings → About.
--   BLOCK 3 (last): narrow the public read policy to every key EXCEPT
--     `hunt-code:%`. Tiles, banks and every other key stay readable exactly as
--     now — gate-tiles.ts reads tile rows with the anon key, and #509 is running.
-- WHY SAVES MOVE TOO: the app saves a guide with an upsert (INSERT … ON CONFLICT
-- DO UPDATE), and Postgres refuses that when the existing row is hidden by the
-- writer's SELECT policy — so hiding guide rows from reads without moving the
-- save would break every guide edit.
--
-- OUTSIDE THIS FILE: nothing — no env var, no dashboard toggle, no function deploy.
-- Old cached copies of the app (before 2026.10.06a) can still OPEN guides until
-- Block 3 runs; after it, an old copy can't open or edit a guide until it reloads.
--
-- HOW TO RUN: one block at a time, each in its own SQL-editor tab.


-- ===========================================================================
-- BLOCK 1 — READ ONLY. The exposure as it stands. Runs as the anon role inside
-- a rolled-back transaction, so it sees exactly what the browser key sees.
-- EXPECT (before Block 3): guides_listable = the guide count (22 on 2026-10-06),
-- tiles_readable > 0.
-- ===========================================================================
begin;
set local role anon;
select (select count(*) from public.shared_kv where key like 'hunt-code:%') as guides_listable,
       (select count(*) from public.shared_kv where key like 'places:%')    as tiles_readable;
rollback;


-- ===========================================================================
-- BLOCK 2 — THE FUNCTIONS. Additive and safe to run now: nothing calls them
-- until the new app deploys. Re-runnable (create or replace).
-- ===========================================================================
create or replace function public.get_guide(p_code text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  -- Exactly one guide, by its exact code (the alphabet the insert policy has
  -- always enforced: no I, O, 0 or 1). A malformed code returns nothing.
  select s.value
    from public.shared_kv s
   where upper(btrim(coalesce(p_code, ''))) ~ '^[A-HJ-NP-Z2-9]{6}$'
     and s.key = 'hunt-code:' || upper(btrim(p_code));
$$;

create or replace function public.save_guide(p_code text, p_value text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_code  text := upper(btrim(coalesce(p_code, '')));
  v_key   text;
  v_owner uuid;
  v_old   text;
  v_found boolean;
  v_old_editable boolean;
  v_new_editable boolean;
begin
  if v_uid is null then
    raise exception 'save_guide: sign in to save a guide' using errcode = '42501';
  end if;
  if v_code !~ '^[A-HJ-NP-Z2-9]{6}$' then
    raise exception 'save_guide: malformed guide code' using errcode = '22023';
  end if;
  v_key := 'hunt-code:' || v_code;

  begin
    v_new_editable := coalesce((p_value::jsonb ->> 'editable')::boolean, false);
  exception when others then
    v_new_editable := false;          -- not JSON / not a boolean: not editable
  end;

  select owner, value, true into v_owner, v_old, v_found
    from public.shared_kv where key = v_key
    for update;

  if not coalesce(v_found, false) then
    -- New guide: the maker owns it (the old insert policy: owner = auth.uid()).
    begin
      insert into public.shared_kv (key, value, updated_at, owner)
      values (v_key, p_value, now(), v_uid);
      return;
    exception when unique_violation then
      -- Someone created the same code a moment ago: fall through to the update
      -- rules against their row.
      select owner, value into v_owner, v_old
        from public.shared_kv where key = v_key
        for update;
    end;
  end if;

  begin
    v_old_editable := coalesce((v_old::jsonb ->> 'editable')::boolean, false);
  exception when others then
    v_old_editable := false;
  end;

  -- The old update policy, both halves:
  --   USING (the existing row):  owner = me OR owner is null OR it was editable
  --   WITH CHECK (the new row):  owner = me OR owner is null OR it stays editable
  -- (the owner itself never changes — shared_kv_lock_owner).
  if not (v_owner = v_uid or v_owner is null or v_old_editable) then
    raise exception 'save_guide: not allowed to change this guide' using errcode = '42501';
  end if;
  if not (v_owner = v_uid or v_owner is null or v_new_editable) then
    raise exception 'save_guide: not allowed to change this guide' using errcode = '42501';
  end if;

  update public.shared_kv
     set value = p_value, updated_at = now()
   where key = v_key;
end;
$$;

revoke all on function public.get_guide(text)        from public;
revoke all on function public.save_guide(text, text) from public;
grant execute on function public.get_guide(text)        to anon, authenticated;
grant execute on function public.save_guide(text, text) to authenticated;

-- Self-check (read only): get_guide returns a real guide for the anon role, and
-- returns nothing for a malformed code. EXPECT: opened_by_code = true,
-- malformed_is_null = true, anon_can_save = false.
begin;
create temp table t517 on commit drop as
  select substr(key, 11) as code from public.shared_kv where key like 'hunt-code:%' order by key limit 1;
grant select on t517 to anon;
set local role anon;
select ((select public.get_guide(code) from t517) is not null)                 as opened_by_code,
       (public.get_guide('not-a-code') is null)                                 as malformed_is_null,
       has_function_privilege('anon', 'public.save_guide(text, text)', 'execute') as anon_can_save;
rollback;


-- ===========================================================================
-- BLOCK 3 — THE FLIP. Run ONLY after index.html 2026.10.06a and landing.html
-- 2026.10.06a are live and you have opened a guide and saved an edit on the new
-- build. Public reads keep every key EXCEPT guides.
-- ===========================================================================
begin;

drop policy if exists shared_kv_public_read on public.shared_kv;
create policy shared_kv_public_read on public.shared_kv
  as permissive for select to public
  using (key not like 'hunt-code:%');

-- Self-check inside the same transaction, as the browser roles. Any failure
-- raises and rolls the whole block back (the old policy is restored).
do $$
declare n_guides_anon int; n_guides_auth int; n_tiles int;
begin
  set local role anon;
  select count(*) into n_guides_anon from public.shared_kv where key like 'hunt-code:%';
  select count(*) into n_tiles       from public.shared_kv where key like 'places:%';
  reset role;
  set local role authenticated;
  select count(*) into n_guides_auth from public.shared_kv where key like 'hunt-code:%';
  reset role;
  if n_guides_anon <> 0 or n_guides_auth <> 0 then
    raise exception '#517 flip check: guides still listable (anon %, authenticated %) — rolled back', n_guides_anon, n_guides_auth;
  end if;
  if n_tiles = 0 then
    raise exception '#517 flip check: tile rows no longer readable by anon — rolled back';
  end if;
end $$;

commit;

-- After commit (read only). EXPECT: guides_listable 0, tiles_readable > 0,
-- opened_by_code true.
begin;
create temp table t517 on commit drop as
  select substr(key, 11) as code from public.shared_kv where key like 'hunt-code:%' order by key limit 1;
grant select on t517 to anon;
set local role anon;
select (select count(*) from public.shared_kv where key like 'hunt-code:%') as guides_listable,
       (select count(*) from public.shared_kv where key like 'places:%')    as tiles_readable,
       ((select public.get_guide(code) from t517) is not null)                as opened_by_code;
rollback;


-- ===========================================================================
-- UNDO (do not run unless reversing #517). Block 3's undo restores the old
-- read-everything policy; the functions can stay (harmless) or be dropped.
-- ===========================================================================
-- drop policy if exists shared_kv_public_read on public.shared_kv;
-- create policy shared_kv_public_read on public.shared_kv as permissive for select to public using (true);
-- drop function if exists public.save_guide(text, text);
-- drop function if exists public.get_guide(text);
