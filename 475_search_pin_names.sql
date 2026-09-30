-- 475_search_pin_names.sql
-- #475 (bundled with #469) — server-side pin NAME search for the map search box,
-- plus the partial index #469's by-area gem read uses.
--
-- WHY: #469 stops the client downloading the whole approved-gem table on every
-- open (5,842 rows / ~5.8 MB on 2026-09-30) and loads gems by area instead. The
-- map search box (#433 matchLoadedPins) used to find far-away gems only because
-- that whole table was in memory; with gems loaded by area it would silently
-- shrink to nearby gems. This function gives search its far reach back, and adds
-- what #433 could never reach: curated story pins that live in the tile cache
-- (Tom Wilson Park, Nashville tile 723_-1735), via curated_descriptions.
--
-- WHAT IT EXPOSES — NAMES AND COORDINATES ONLY. Never description, note,
-- source_url, submitted_by or any moderation column. Approved, unmerged gems are
-- already anon-readable through the submissions SELECT grant; the NEW public read
-- is curated_descriptions' name + lat + lng (the table stays RLS-on with no
-- policy — this SECURITY DEFINER function is the only anon path into it, and it
-- returns only those three fields).
--
-- STORY GATE (#344 brick 5): a gem with resolved_source = 'none' is hidden, the
-- same rule the map uses (null stays visible). include_hidden mirrors the
-- client's ?showhidden=1 escape hatch; it reveals nothing the anon submissions
-- grant does not already expose.
--
-- A curated row that is the same place as an approved gem (a #57 story seed
-- carries both) is returned once, as the gem: same normalised name within a
-- ~110 m box. The twin test is against ANY approved, unmerged gem, gated or not,
-- so a curated row can never resurface a gem the story gate hides.
--
-- RANKING mirrors the client (#433 .30c): pins within 80,467 m (50 mi) of the
-- anchor first, nearest first; then farther pins by name tier (exact, starts
-- with, a word starts with, anywhere), nearest first within a tier. The client
-- re-ranks the merged list anyway; this only decides which rows make the cap.
--
-- DEPLOY: Supabase SQL editor, BEFORE the index.html 2026.09.30d upload. The
-- client degrades safely if this is missing (the search box just shows in-memory
-- pins and addresses, with a console warning), but far-away gems and curated
-- tile pins are not findable until it runs.
--
-- ROLLBACK: drop function if exists public.search_pin_names(text, double precision, double precision, integer, boolean);
--           drop index if exists public.submissions_approved_geo_idx;

-- #469 — the by-area gem read (lat/lng range over approved, unmerged rows) and
-- this function's twin test both filter on exactly this predicate. Tiny today;
-- it keeps both reads index-backed as the metro rows (#445–#462) grow the table.
create index if not exists submissions_approved_geo_idx
  on public.submissions using btree (lat, lng)
  where status = 'approved' and merged_into is null;

create or replace function public.search_pin_names(
  q               text,
  at_lat          double precision default null,
  at_lng          double precision default null,
  max_rows        integer          default 10,
  include_hidden  boolean          default false
)
returns table (
  kind      text,              -- 'gem' (a submissions row) | 'story' (a curated_descriptions row)
  id        text,              -- submissions.id / curated_descriptions.id, as text
  name      text,              -- display name (a gem's name_clean when set, else name)
  lat       double precision,
  lng       double precision,
  category  text               -- a gem's stored bucket; null for a story row (its tile pin owns the category)
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with params as (
    select
      regexp_replace(lower(left(coalesce(q, ''), 100)), '[^a-z0-9]', '', 'g')                   as nq,
      ' ' || btrim(regexp_replace(lower(left(coalesce(q, ''), 100)), '[^a-z0-9]+', ' ', 'g'))  as wq,
      least(greatest(coalesce(max_rows, 10), 1), 20)                                            as cap
  ),
  gem as (
    select 'gem'::text                                              as kind,
           s.id::text                                               as id,
           coalesce(nullif(btrim(s.name_clean), ''), s.name)        as name,
           s.lat, s.lng, s.category
    from public.submissions s, params p
    where length(p.nq) >= 2
      and s.status = 'approved'
      and s.merged_into is null
      and (include_hidden or s.resolved_source is distinct from 'none')
      and position(p.nq in regexp_replace(lower(coalesce(nullif(btrim(s.name_clean), ''), s.name)), '[^a-z0-9]', '', 'g')) > 0
  ),
  story as (
    select 'story'::text as kind, c.id::text as id, c.name, c.lat, c.lng, null::text as category
    from public.curated_descriptions c, params p
    where length(p.nq) >= 2
      and position(p.nq in c.name_clean) > 0
      and not exists (
        select 1
        from public.submissions s
        where s.status = 'approved'
          and s.merged_into is null
          and s.lat between c.lat - 0.001  and c.lat + 0.001
          and s.lng between c.lng - 0.0015 and c.lng + 0.0015
          and regexp_replace(lower(coalesce(nullif(btrim(s.name_clean), ''), s.name)), '[^a-z0-9]', '', 'g') = c.name_clean
      )
  ),
  hits as (
    select h.*,
           regexp_replace(lower(h.name), '[^a-z0-9]', '', 'g')                  as nn,
           ' ' || regexp_replace(lower(h.name), '[^a-z0-9]+', ' ', 'g')         as wn,
           case when at_lat is null or at_lng is null then null
                else 6371000 * sqrt(
                       power(radians(h.lat - at_lat), 2) +
                       power(cos(radians((h.lat + at_lat) / 2)) * radians(h.lng - at_lng), 2))
           end                                                                   as dist
    from (select * from gem union all select * from story) h
  )
  select x.kind, x.id, x.name, x.lat, x.lng, x.category
  from hits x, params p
  order by
    (x.dist is not null and x.dist <= 80467) desc,
    case when x.dist is not null and x.dist <= 80467 then x.dist end asc nulls last,
    case when x.nn = p.nq                      then 0
         when left(x.nn, length(p.nq)) = p.nq  then 1
         when position(p.wq in x.wn) > 0       then 2
         else 3 end asc,
    x.dist asc nulls last,
    x.name asc
  limit (select cap from params)
$fn$;

revoke all on function public.search_pin_names(text, double precision, double precision, integer, boolean) from public;
grant execute on function public.search_pin_names(text, double precision, double precision, integer, boolean) to anon, authenticated;

comment on function public.search_pin_names(text, double precision, double precision, integer, boolean) is
  '#475 — map search box pin-name lookup. Returns names + coordinates only (never descriptions). Approved, unmerged, story-gated gems plus curated_descriptions rows without a gem twin; near-first ranking. See 475_search_pin_names.sql.';
