-- 502_hidden_curated_3.sql — #502 Queens-Nassau story pass 2, part 2b: curated rows for 5 HIDDEN storyless OSM pins in
-- Hempstead, Oyster Bay, Port Washington and Old Bethpage (handoff §6 story-lines (y)). Each is an OSM pin stored in the
-- box's places:v34 rows with filler text ("A local memorial (plaque).", "A local green space to wander.", "A local
-- museum."), so it serves hidden; a seed line would twin it. Each becomes a curated row under the pin's EXACT stored
-- name at its stored coordinate.
-- Checks done (2026-10-28): names, ids and coordinates as stored in places:v34 rows 814_-1473 (Denton Green Park,
-- osm_way329959858), 817_-1471 (U.S.S Maine Memorial, osm_node9898076922; Fortified Hill, osm_node9898155642),
-- 817_-1474 (Mill Pond Park, osm_way918016220) and 816_-1469 (Museum of American Armor, osm_way556394274); each HMdb marker
-- 1–150 m from its pin (Mill Pond Park is a way — its stored point is the park's middle); no same-name pin within 2 km
-- (CURATED_MATCH_M) among the box's 3,233 stored pins, so each row reaches only its own pin. Stories from the HMdb
-- Nassau County list's excerpts (pages 3–5).
-- Left hidden on purpose: Fort Hill (its plaque is the Townsend burying ground; the Townsend Cemetery article and Robert
-- Townsend's grave gem serve 11 m away); Presbyterian Church (a plaque pin 49 m from the served First Presbyterian
-- Church); Civil War Trophy Gun (no text); Saint George's Episcopal Churdyard (part 1's gravestone).
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER the names-502-queens-nassau-3.txt commit (no line there
-- shares a name with these rows, but keep the habit). Re-runnable: skipped when a same-name curated row sits within 50 m.
-- Expect 5 rows returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect these 5 names among the rows, dist_m 0. Re-check the map after 5 minutes (CURATED_INDEX_TTL_MS).
-- BACK-OUT: delete from public.curated_descriptions where note = '#502 hidden-pin row — Queens-Nassau part 2b (2026-10-28)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Denton Green Park$t$, 40.7092505::double precision, -73.6230304::double precision, $t$Named for the Rev. Richard Denton, who led the pioneers who settled Hempstead in 1644 and served as its first minister, this green is the site of an early burying ground where many of the first settlers lie.$t$, $t$https://www.hmdb.org/m.asp?m=288585$t$, $t$#502 hidden-pin row — Queens-Nassau part 2b (2026-10-28)$t$),
  ($t$U.S.S Maine Memorial$t$, 40.873642::double precision, -73.5326841::double precision, $t$This memorial tablet was cast from metal recovered from the battleship USS Maine, destroyed in Havana Harbor on February 15, 1898.$t$, $t$https://www.hmdb.org/m.asp?m=65087$t$, $t$#502 hidden-pin row — Queens-Nassau part 2b (2026-10-28)$t$),
  ($t$Fortified Hill$t$, 40.8712612::double precision, -73.5325165::double precision, $t$Colonel John Graves Simcoe's Loyalist Queen's Rangers held and fortified this hill from 1779 to 1781, during the British occupation of Oyster Bay.$t$, $t$https://www.hmdb.org/m.asp?m=42783$t$, $t$#502 hidden-pin row — Queens-Nassau part 2b (2026-10-28)$t$),
  ($t$Mill Pond Park$t$, 40.8371515::double precision, -73.6991455::double precision, $t$Mill Pond was formed in 1795 when the bay's inlet was closed off, and the Town of North Hempstead later restored the pond and its park over twelve years with federal, state and local grants.$t$, $t$https://www.hmdb.org/m.asp?m=286868$t$, $t$#502 hidden-pin row — Queens-Nassau part 2b (2026-10-28)$t$),
  ($t$Museum of American Armor$t$, 40.7762463::double precision, -73.4457752::double precision, $t$This museum displays armored vehicles from World War II through the Cold War, among them an M42B1 Sherman flamethrower tank, an M60 main battle tank, a Soviet-built T-72 and an M110 self-propelled howitzer.$t$, $t$https://www.hmdb.org/m.asp?m=288249$t$, $t$#502 hidden-pin row — Queens-Nassau part 2b (2026-10-28)$t$)
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
