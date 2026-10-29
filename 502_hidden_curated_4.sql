-- 502_hidden_curated_4.sql — #502 Queens-Nassau story pass 2, part 2c-1: a curated row for 1 HIDDEN storyless OSM pin in
-- Lynbrook (handoff §6 story-lines (y)). The pin is stored in the box's places:v34 rows with filler text ("A local
-- memorial (plaque)."), so it serves hidden; a seed line would twin it. It becomes a curated row under the pin's EXACT
-- stored name at its stored coordinate.
-- Checks done (2026-10-28): name, id and coordinate as stored in places:v34 row 813_-1474 (Henri Charpentier,
-- osm_node6808483152, 40.6473842, -73.6711148); the HMdb marker (m=128015) stands 16 m from the pin; no other pin or gem
-- with "Henri" or "Charpentier" in its name among the box's 2,076 stored pins and 463 gems, so the row reaches only its own
-- pin (CURATED_MATCH_M); the restaurant site is the plaque's own subject. Story from the HMdb Nassau County list's excerpt
-- (mixed list page 4, entry 326).
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER the names-502-queens-nassau-4.txt commit (no line there
-- shares a name with this row, but keep the habit). Re-runnable: skipped when a same-name curated row sits within 50 m.
-- Expect 1 row returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect Henri Charpentier among the rows, dist_m 0. Re-check the map after 5 minutes (CURATED_INDEX_TTL_MS).
-- BACK-OUT: delete from public.curated_descriptions where note = '#502 hidden-pin row — Queens-Nassau part 2c-1 (2026-10-28)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Henri Charpentier$t$, 40.6473842::double precision, -73.6711148::double precision, $t$Henri Charpentier, one of the first celebrity chefs and the man credited with inventing crêpes Suzette, opened his original Henri restaurant and bar on this spot in 1910.$t$, $t$https://www.hmdb.org/m.asp?m=128015$t$, $t$#502 hidden-pin row — Queens-Nassau part 2c-1 (2026-10-28)$t$)
)
insert into public.curated_descriptions (name, lat, lng, description, source_url, note)
select v.name, v.lat, v.lng, v.description, v.source_url, v.note
from v
where not exists (
  select 1 from public.curated_descriptions d
  where d.name_clean = regexp_replace(lower(v.name), '[^a-z0-9]', '', 'g')
    and 6371000 * sqrt(
          power(radians(d.lat - v.lat), 2) +
          power(cos(radians((d.lat + v.lat) / 2)) * radians(d.lng - v.lng), 2)) <= 50
)
returning name, note;
