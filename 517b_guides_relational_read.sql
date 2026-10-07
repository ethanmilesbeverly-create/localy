-- 517b_guides_relational_read.sql — #517, second door: the RELATIONAL guide copies.
-- Supabase SQL editor (runs as postgres). Stamp: 517b-guides-v1 (2026-10-06).
--
-- WHY. 517_guide_read_lockdown.sql hid the `hunt-code:%` blobs in shared_kv, but
-- #277's Pass 1 BACKFILLED every guide into `guides` / `guide_stops`, and both still
-- carry `for select to public using (true)` (#411's contract for a Pass 2 that has
-- not shipped). From the browser's public key on 2026-10-06: 16 guides (codes and
-- names) and 30 stops with coordinates were listable — and a listed code opens the
-- full guide through get_guide. Nothing reads these tables today (no client, tool
-- or function references them; #277 Pass 2 is unbuilt), so narrowing them breaks
-- no app path.
--
-- THE CHANGE. Reads become OWNER-ONLY, signed in: a guide row is visible to its
-- owner; a stop is visible to the owner of its guide. Writes are untouched (#411's
-- owner-only policies and guard triggers stay as they are).
-- CONTRACT CHANGE FOR #277 PASS 2: a read BY CODE must go through a SECURITY
-- DEFINER function keyed on the exact code (the get_guide pattern), never a public
-- SELECT — and that function joins 488's grant (5) list in the same pass.
--
-- OUTSIDE THIS FILE: nothing. Run 488_rls_audit_sweep.sql v4 after it (CLOSED).
-- HOW TO RUN: one block at a time, each in its own SQL-editor tab.


-- ===========================================================================
-- BLOCK 1 — READ ONLY. As the browser's public key sees it.
-- EXPECT (before Block 2): guides_listable 16, stops_listable 30 (2026-10-06).
-- ===========================================================================
begin;
set local role anon;
select (select count(*) from public.guides)      as guides_listable,
       (select count(*) from public.guide_stops) as stops_listable;
rollback;


-- ===========================================================================
-- BLOCK 2 — THE CHANGE, self-checking: rolls itself back unless a signed-out
-- reader and a signed-in stranger both see 0 guides and 0 stops, while an owner
-- still sees their own.
-- ===========================================================================
begin;

drop policy if exists guides_select on public.guides;
create policy guides_select on public.guides
  as permissive for select to authenticated
  using (owner = auth.uid());

drop policy if exists guide_stops_select on public.guide_stops;
create policy guide_stops_select on public.guide_stops
  as permissive for select to authenticated
  using (exists (select 1 from public.guides g
                  where g.id = guide_stops.guide_id and g.owner = auth.uid()));

do $$
declare
  v_owner uuid; v_stranger uuid;
  n_anon_g int; n_anon_s int; n_str_g int; n_str_s int; n_own_g int; n_own_total int;
begin
  select owner into v_owner from public.guides where owner is not null order by code limit 1;
  select count(*) into n_own_total from public.guides where owner = v_owner;
  select id into v_stranger from auth.users
   where id is distinct from v_owner
     and not exists (select 1 from public.guides g where g.owner = auth.users.id)
   order by created_at limit 1;

  set local role anon;
  select count(*) into n_anon_g from public.guides;
  select count(*) into n_anon_s from public.guide_stops;
  reset role;

  if v_stranger is not null then
    perform set_config('request.jwt.claim.sub', v_stranger::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_stranger, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n_str_g from public.guides;
    select count(*) into n_str_s from public.guide_stops;
    reset role;
  end if;

  if v_owner is not null then
    perform set_config('request.jwt.claim.sub', v_owner::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n_own_g from public.guides;
    reset role;
  end if;

  if n_anon_g <> 0 or n_anon_s <> 0 then
    raise exception '#517b check: signed out still lists % guide(s) / % stop(s) — rolled back', n_anon_g, n_anon_s;
  end if;
  if coalesce(n_str_g, 0) <> 0 or coalesce(n_str_s, 0) <> 0 then
    raise exception '#517b check: a signed-in stranger lists % guide(s) / % stop(s) — rolled back', n_str_g, n_str_s;
  end if;
  if v_owner is not null and n_own_g <> n_own_total then
    raise exception '#517b check: an owner sees % of their % guide(s) — rolled back', n_own_g, n_own_total;
  end if;
  raise notice '#517b check passed: signed out 0/0, stranger %/%, owner sees % of %',
    coalesce(n_str_g, 0), coalesce(n_str_s, 0), coalesce(n_own_g, 0), n_own_total;
end $$;

commit;

-- After commit (read only). EXPECT: guides_listable 0, stops_listable 0.
begin;
set local role anon;
select (select count(*) from public.guides)      as guides_listable,
       (select count(*) from public.guide_stops) as stops_listable;
rollback;


-- ===========================================================================
-- UNDO (do not run unless reversing #517b): restore #411's public reads.
-- ===========================================================================
-- drop policy if exists guides_select on public.guides;
-- create policy guides_select on public.guides as permissive for select to public using (true);
-- drop policy if exists guide_stops_select on public.guide_stops;
-- create policy guide_stops_select on public.guide_stops as permissive for select to public using (true);
