-- 411_guides_owner_lockdown.sql — #411: close the no-owner hole on the
-- relational guides tables before #277's Pass 2 cutover.
--
-- RUN: Supabase SQL editor, the whole file at once. DB-only — no Pages upload,
-- no function deploy, no APP_VERSION move. One transaction: if any assertion
-- at the end fails, NOTHING is changed.
--
-- THE HOLE (found by #409's export, confirmed live 2026-09-24): guides_update,
-- guide_stops_insert/update allowed `owner IS NULL`, guide_stops_delete allowed
-- it outright; all four were `to public`, and anon + authenticated held every
-- table privilege (incl. TRUNCATE). All 16 guides had owner NULL, so with only
-- the publishable key, logged out, anyone could rename / withdraw / re-flag any
-- guide and add, change or delete any stop. A zero-row PATCH on guides with the
-- public key returned 200. The app does not read these tables yet (#277 Pass 1
-- only), so nothing user-visible could be defaced — but tampering would carry
-- over at cutover.
--
-- WHAT THIS DOES (definitions copied from 409_schema_baseline.sql and changed
-- only where stated):
--   1. OWNER BACKFILL. guides.owner := the shared_kv `hunt-code:<code>` row's
--      owner (#135) where that is set and still a real auth.users id. The
--      guides_guard trigger silently resets any owner change on UPDATE (it does
--      `new.owner := old.owner`, not an error), so it is disabled for this one
--      statement and re-enabled straight after — inside the transaction.
--      Expected live result: 4 guides gain an owner (GYRVQE, AMAMQA, CEMJ2Z,
--      WCGLQJ); 12 stay unowned — the blob never recorded their maker.
--   2. FREEZE UNOWNED LEGACY GUIDES. An unowned guide gets editable = false.
--      With the NULL arms gone (step 3) nobody can update it or its stops, so
--      it is read-only: still openable by code, never editable. Only two were
--      editable (WZGCHY, RBRDK8). A frozen guide can be handed to its real
--      maker later with a one-row owner update, run as postgres with the guard
--      disabled the same way as step 1.
--   3. POLICIES. Same six policies, same names. Changes:
--      - every write policy: the `owner IS NULL` arm is removed, and the policy
--        is scoped `to authenticated` (was `to public`);
--      - guides_update: the `editable = true` arm is ALSO removed. It let any
--        signed-in user rename, withdraw (#84 delete) or un-share someone
--        else's collaborative guide. #202's collaboration is about STOPS; the
--        guide row is the owner's. A WITH CHECK is added (owner = auth.uid()).
--      - guide_stops insert/update: the editable arm now also requires the stop
--        to be the caller's own (added_by = auth.uid()) and the guide not
--        withdrawn — the shape guide_stops_delete already had. This is #202's
--        "append-only by author" rule enforced in SQL instead of only in the
--        client (the gap handoff §6 #135 note (a) left open for the KV blob).
--        The owner can still add, edit and delete any stop.
--      - the two SELECT policies are unchanged (guides are public by code,
--        exactly like the shared_kv blob they mirror).
--   4. GRANTS. anon keeps SELECT only; authenticated keeps SELECT, INSERT,
--      UPDATE, DELETE (drops TRUNCATE / TRIGGER / REFERENCES / MAINTAIN, which
--      RLS does not govern). service_role untouched.
--   5. ASSERTIONS. The transaction aborts unless: no policy on either table
--      mentions `owner IS NULL`; no write policy applies to public/anon; anon
--      holds no write privilege; no unowned guide is still editable.
--   6. CHECK ROW. One row to read after the run (see QA).
--
-- NOT CHANGED, ON PURPOSE: the shared_kv `hunt-code:` policies. The app's live
-- guides still run on that blob, and its `owner IS NULL` grandfather arm is
-- #135's documented option (b) — legacy makers keep editing their guides.
-- Closing it is #135 option (c), a separate decision.
--
-- FOR #277 PASS 2 (the client cutover must follow these rules):
--   - INSERT a guide with owner = the signed-in user's id (policy requires it);
--   - a collaborator's stop must be sent with added_by = their own id;
--   - a collaborator never UPDATEs the guides row (only its owner can);
--   - re-copy from shared_kv right before cutover: 5 guides made after Pass 1
--     (HTQYE4, DNSXJ7, 7E7JSL, A2LWDF, GKYB9Z) exist only in the blob.
--
-- BACK-OUT (restores the pre-#411 policies and grants; the owner backfill and
-- the freeze are harmless to keep): replay the guides / guide_stops policy and
-- grant sections of 409_schema_baseline.sql after dropping these six policies,
-- and `update public.guides set editable = true where code in ('WZGCHY','RBRDK8');`.
--
-- Related: #277, #135, #202, #84, #410, #409.

begin;

-- 1. OWNER BACKFILL ----------------------------------------------------------
alter table public.guides disable trigger guides_guard_trg;

update public.guides g
   set owner = kv.owner
  from public.shared_kv kv
 where kv.key = 'hunt-code:' || g.code
   and g.owner is null
   and kv.owner is not null
   and exists (select 1 from auth.users u where u.id = kv.owner);

alter table public.guides enable trigger guides_guard_trg;

-- 2. FREEZE UNOWNED LEGACY GUIDES -------------------------------------------
update public.guides
   set editable = false
 where owner is null
   and editable;

-- 3. POLICIES ----------------------------------------------------------------
drop policy if exists guides_insert       on public.guides;
drop policy if exists guides_update       on public.guides;
drop policy if exists guide_stops_insert  on public.guide_stops;
drop policy if exists guide_stops_update  on public.guide_stops;
drop policy if exists guide_stops_delete  on public.guide_stops;

create policy guides_insert on public.guides as permissive for insert to authenticated
  with check (owner = auth.uid());

create policy guides_update on public.guides as permissive for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

create policy guide_stops_insert on public.guide_stops as permissive for insert to authenticated
  with check (exists (select 1
    from public.guides g
   where g.id = guide_stops.guide_id
     and (g.owner = auth.uid()
          or (g.editable = true and not g.withdrawn and guide_stops.added_by = auth.uid()))));

create policy guide_stops_update on public.guide_stops as permissive for update to authenticated
  using (exists (select 1
    from public.guides g
   where g.id = guide_stops.guide_id
     and (g.owner = auth.uid()
          or (g.editable = true and not g.withdrawn and guide_stops.added_by = auth.uid()))))
  with check (exists (select 1
    from public.guides g
   where g.id = guide_stops.guide_id
     and (g.owner = auth.uid()
          or (g.editable = true and not g.withdrawn and guide_stops.added_by = auth.uid()))));

create policy guide_stops_delete on public.guide_stops as permissive for delete to authenticated
  using (exists (select 1
    from public.guides g
   where g.id = guide_stops.guide_id
     and (g.owner = auth.uid()
          or (g.editable = true and guide_stops.added_by = auth.uid()))));

-- guides_select / guide_stops_select (to public, using true): unchanged.

-- 4. GRANTS ------------------------------------------------------------------
revoke all on table public.guides, public.guide_stops from public, anon, authenticated;
grant select on table public.guides, public.guide_stops to anon;
grant select, insert, update, delete on table public.guides, public.guide_stops to authenticated;

-- 5. ASSERTIONS (any failure rolls the whole file back) ----------------------
do $$
declare
  n int;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('guides', 'guide_stops')
     and (coalesce(qual, '') ilike '%owner IS NULL%'
          or coalesce(with_check, '') ilike '%owner IS NULL%');
  if n > 0 then raise exception '#411: % policy(ies) still have an owner IS NULL arm', n; end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('guides', 'guide_stops')
     and cmd <> 'SELECT'
     and roles && array['public', 'anon']::name[];
  if n > 0 then raise exception '#411: % write policy(ies) still apply to public/anon', n; end if;

  if has_table_privilege('anon', 'public.guides',      'INSERT, UPDATE, DELETE, TRUNCATE')
  or has_table_privilege('anon', 'public.guide_stops', 'INSERT, UPDATE, DELETE, TRUNCATE') then
    raise exception '#411: anon still holds a write privilege';
  end if;

  select count(*) into n from public.guides where owner is null and editable;
  if n > 0 then raise exception '#411: % unowned guide(s) still editable', n; end if;
end $$;

commit;

-- 6. CHECK ROW ---------------------------------------------------------------
-- Expected on the live DB: guides 16 · owned 4 · unowned_frozen 12 ·
-- unowned_editable 0 · null_arm_policies 0 · public_write_policies 0 ·
-- every anon_can_* false · auth_can_truncate false · auth_can_update true ·
-- guard_trigger_on true.
select
  (select count(*) from public.guides)                                        as guides,
  (select count(*) from public.guides where owner is not null)                as owned,
  (select count(*) from public.guides where owner is null)                    as unowned_frozen,
  (select count(*) from public.guides where owner is null and editable)       as unowned_editable,
  (select string_agg(code, ',' order by code) from public.guides
    where owner is not null)                                                  as owned_codes,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('guides', 'guide_stops')
      and (coalesce(qual, '') ilike '%owner IS NULL%'
           or coalesce(with_check, '') ilike '%owner IS NULL%'))             as null_arm_policies,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('guides', 'guide_stops')
      and cmd <> 'SELECT' and roles && array['public', 'anon']::name[])       as public_write_policies,
  has_table_privilege('anon', 'public.guides', 'UPDATE')                      as anon_can_update_guides,
  has_table_privilege('anon', 'public.guide_stops', 'INSERT, UPDATE, DELETE') as anon_can_write_stops,
  has_table_privilege('authenticated', 'public.guides', 'TRUNCATE')           as auth_can_truncate,
  has_table_privilege('authenticated', 'public.guides', 'UPDATE')             as auth_can_update,
  (select tgenabled = 'O' from pg_trigger
    where tgname = 'guides_guard_trg' and tgrelid = 'public.guides'::regclass) as guard_trigger_on;
