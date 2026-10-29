-- 502_hidden_curated_5.sql — #502 Queens-Nassau story pass 2, part 2c-2: curated rows for 3 HIDDEN storyless OSM pins in
-- Rockville Centre (handoff §6 story-lines (y)). Each is an OSM pin stored in the box's places:v34 rows with filler text
-- ("A local memorial (plaque).", "A local museum."), so it serves hidden; a seed line would twin it. Each becomes a curated
-- row under the pin's EXACT stored name at its stored coordinate.
-- Checks done (2026-10-28): names, ids and coordinates as stored in places:v34 rows 813_-1472 (The Charles P Ketler Power
-- Plant, osm_node11244669023; Church of the Ascension, osm_node11310813486) and 813_-1473 (Philips House,
-- osm_way316474196 — OSM's spelling, kept exactly; HMdb spells it Phillips); each HMdb marker 5–11 m from its pin; no
-- same-name pin within 2 km (CURATED_MATCH_M) among the box's 2,076 unique stored pins, so each row reaches only its own
-- pin. Stories from the HMdb Rockville Centre town list's excerpts and the DeMott Millstone marker page.
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER the names-502-queens-nassau-5.txt commit (no line there
-- shares a name with these rows, but keep the habit). Re-runnable: skipped when a same-name curated row sits within 50 m.
-- Expect 3 rows returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect these 3 names among the rows, dist_m 0. Re-check the map after 5 minutes (CURATED_INDEX_TTL_MS).
-- BACK-OUT: delete from public.curated_descriptions where note = '#502 hidden-pin row — Queens-Nassau part 2c-2 (2026-10-28)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$The Charles P Ketler Power Plant$t$, 40.6586693::double precision, -73.6404266::double precision, $t$Established in 1898, Rockville Centre's village power plant was one of the first municipal power plants in the United States; it was dedicated in 1971 to its long-serving chief engineer, Charles P. Ketler.$t$, $t$https://www.hmdb.org/m.asp?m=289697$t$, $t$#502 hidden-pin row — Queens-Nassau part 2c-2 (2026-10-28)$t$),
  ($t$Church of the Ascension$t$, 40.6590188::double precision, -73.6478205::double precision, $t$Founded in 1885, this parish built its church in 1888 and enlarged it in 1942; it is the only Rockville Centre congregation still worshipping in its original building.$t$, $t$https://www.hmdb.org/m.asp?m=114683$t$, $t$#502 hidden-pin row — Queens-Nassau part 2c-2 (2026-10-28)$t$),
  ($t$Philips House$t$, 40.6619593::double precision, -73.647406::double precision, $t$The Phillips House holds the Museum of the Village of Rockville Centre; in its backyard lie the two halves of a 1700s millstone from the DeMott mill, which the marker says broke during the fighting at Rockville Centre on June 3, 1776.$t$, $t$https://www.hmdb.org/m.asp?m=286553$t$, $t$#502 hidden-pin row — Queens-Nassau part 2c-2 (2026-10-28)$t$)
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
