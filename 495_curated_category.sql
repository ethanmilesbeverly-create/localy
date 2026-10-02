-- =============================================================================
-- 495_curated_category.sql — roadmap #495
-- Supabase SQL editor. Run ONE SECTION AT A TIME, in order, BEFORE the
-- index.html 2026.10.02a upload. Pairs with that index.html.
-- =============================================================================
--
-- THE BUG: curated_descriptions stores no category, so search_pin_names returns
-- null for every 'story' row and the client files them all as History. Right
-- for most stories (#57 history markers on Wikipedia pins), wrong for a story on
-- an OSM park or art pin — search says History, the sheet says Park once the
-- tile loads.
--
-- THE FIX:
--   1. curated_descriptions.category — nullable; null still means "unknown",
--      which the client keeps showing as History (its old behaviour).
--   2. public.curated_category_backfill(do_write) — fills a NULL category from
--      the tile pin the story actually attaches to, using nearby-places' OWN
--      identity rule (#362/#419: same normName, within 2 km, an OSM or Wikipedia
--      facts pin — history/park/trail/art). It reads only the current cache
--      version's tiles around each story (the story's tile and its 8 neighbours),
--      never the whole cache. Nearest matching pin wins. Idempotent: it only
--      ever fills NULLs, so it never overwrites a category set by hand.
--      do_write=false is a dry run (lists what it WOULD set).
--      RE-RUN IT after any story commit (seed-resolve.ts --commit inserts rows
--      without a category) — or a new story reads History in search until then.
--   3. search_pin_names returns c.category for a story row. Everything else in
--      the function is byte-for-byte the #475 version.
--
-- A story whose pin is not in a cached tile right now stays NULL (→ History in
-- search) until a re-run after that tile is warm.
--
-- ROLLBACK: section 6.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- SECTION 1 — THE COLUMN. Idempotent.
-- No client grant is involved: curated_descriptions is RLS-on with no policy,
-- and search_pin_names (security definer) is the only anon path into it.
-- -----------------------------------------------------------------------------
alter table public.curated_descriptions
  add column if not exists category text;

comment on column public.curated_descriptions.category is
  '#495: the category of the tile pin this story attaches to (history/park/trail/art), filled by curated_category_backfill(). NULL = unknown; search shows it as History.';

-- check: expect one row, text, nullable YES
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'curated_descriptions' and column_name = 'category';


-- -----------------------------------------------------------------------------
-- SECTION 2 — THE BACKFILL FUNCTION. Idempotent (create or replace).
-- Service-role / SQL-editor only: EXECUTE revoked from every API role.
-- -----------------------------------------------------------------------------
create or replace function public.curated_category_backfill(do_write boolean default false)
returns table (
  id        uuid,
  name      text,
  category  text,
  dist_m    integer,
  tile      text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  ver int;
begin
  -- The live tile-cache version: the highest places:vN: prefix in use (the same
  -- read the tilecache-sweep cron makes).
  select max((substring(k.key from '^places:v([0-9]+):'))::int)
    into ver
  from public.shared_kv k
  where k.key ~ '^places:v[0-9]+:';
  if ver is null then return; end if;

  create temporary table if not exists _cc_match (
    id uuid, name text, category text, dist_m integer, tile text
  ) on commit drop;
  truncate _cc_match;

  insert into _cc_match
  with c as (
    select d.id, d.name, d.name_clean, d.lat, d.lng,
           round(d.lat / 0.05)::int as ty,          -- nearby-places tileKey: round(coord / 0.05)
           round(d.lng / 0.05)::int as tx
    from public.curated_descriptions d
    where d.category is null
  ),
  keys as (
    select distinct 'places:v' || ver || ':' || (c.ty + dy) || '_' || (c.tx + dx) as key
    from c, generate_series(-1, 1) dy, generate_series(-1, 1) dx
  ),
  pins as (
    select substring(k.key from ':([^:]+)$')            as tile,
           p ->> 'name'                                  as pname,
           (p ->> 'lat')::double precision               as plat,
           (p ->> 'lng')::double precision               as plng,
           p ->> 'category'                              as pcat
    from public.shared_kv k
    join keys using (key)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(k.value::jsonb -> 'places') = 'array'
           then k.value::jsonb -> 'places' else '[]'::jsonb end) p
    where k.value like '{%'
      and p ->> 'source' in ('osm', 'wiki')
      and p ->> 'category' in ('history', 'park', 'trail', 'art')
      and p ->> 'lat' is not null and p ->> 'lng' is not null
  ),
  cand as (
    select c.id, c.name, pn.pcat, pn.tile,
           6371000 * sqrt(
             power(radians(pn.plat - c.lat), 2) +
             power(cos(radians((pn.plat + c.lat) / 2)) * radians(pn.plng - c.lng), 2)) as dist
    from c
    join pins pn on regexp_replace(lower(pn.pname), '[^a-z0-9]', '', 'g') = c.name_clean
  )
  select distinct on (cand.id) cand.id, cand.name, cand.pcat, round(cand.dist)::int, cand.tile
  from cand
  where cand.dist <= 2000                             -- nearby-places CURATED_MATCH_M
  order by cand.id, cand.dist;

  if do_write then
    update public.curated_descriptions d
       set category = m.category
      from _cc_match m
     where d.id = m.id and d.category is null;
  end if;

  return query select m.id, m.name, m.category, m.dist_m, m.tile from _cc_match m order by m.category, m.name;
end
$fn$;

revoke all on function public.curated_category_backfill(boolean) from public, anon, authenticated;

comment on function public.curated_category_backfill(boolean) is
  '#495: fill curated_descriptions.category (NULLs only) from the tile pin each story attaches to — same normName, within 2 km, osm/wiki facts pin, current cache version. do_write=false is a dry run. Re-run after every story commit.';


-- -----------------------------------------------------------------------------
-- SECTION 3 — DRY RUN (writes nothing). Read the split, then the non-History
-- rows: these are the stories search has been mislabelling. Paste both back.
-- -----------------------------------------------------------------------------
-- 3a: how many stories exist, and what the dry run would set.
select (select count(*) from public.curated_descriptions)                         as stories_total,
       (select count(*) from public.curated_descriptions where category is null)  as stories_without_category,
       count(*) filter (where category = 'history') as would_be_history,
       count(*) filter (where category = 'park')    as would_be_park,
       count(*) filter (where category = 'trail')   as would_be_trail,
       count(*) filter (where category = 'art')     as would_be_art
from public.curated_category_backfill(false);

-- 3b: the non-History ones (the actual fix), nearest-pin distance and tile.
select name, category, dist_m, tile
from public.curated_category_backfill(false)
where category <> 'history'
order by category, name
limit 40;


-- -----------------------------------------------------------------------------
-- SECTION 4 — WRITE IT. Fills NULLs only; safe to re-run any time.
-- Expect the same counts as 3a.
-- -----------------------------------------------------------------------------
select category, count(*)
from public.curated_category_backfill(true)
group by category
order by category;

-- check: expect the categories now stored, plus the NULLs no tile pin matched.
select coalesce(category, '∅ null (no cached pin matched)') as category, count(*)
from public.curated_descriptions
group by 1
order by 1;


-- -----------------------------------------------------------------------------
-- SECTION 5 — search_pin_names RETURNS THE STORY'S CATEGORY.
-- Identical to 475_search_pin_names.sql except the `story` CTE selects
-- c.category instead of null. Same signature and return type, so
-- create or replace keeps the existing grants.
-- -----------------------------------------------------------------------------
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
  category  text               -- a gem's stored bucket; a story's tile-pin category (#495), null if unknown
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
    select 'story'::text as kind, c.id::text as id, c.name, c.lat, c.lng, c.category
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
  '#475 — map search box pin-name lookup. Returns names + coordinates only (never descriptions). Approved, unmerged, story-gated gems plus curated_descriptions rows without a gem twin; near-first ranking. #495: a story row now carries its stored category (null = unknown). See 475_search_pin_names.sql + 495_curated_category.sql.';

-- check: one of section 3b's names should now come back with its category.
-- Replace the name, then run:
-- select kind, name, category from public.search_pin_names('PASTE A NAME FROM 3b');


-- -----------------------------------------------------------------------------
-- SECTION 6 — REVERT (only if needed). Restore the #475 function first (re-run
-- 475_search_pin_names.sql), then:
-- -----------------------------------------------------------------------------
-- drop function if exists public.curated_category_backfill(boolean);
-- alter table public.curated_descriptions drop column if exists category;
