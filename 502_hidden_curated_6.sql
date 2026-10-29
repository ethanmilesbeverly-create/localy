-- 502_hidden_curated_6.sql — #502 Queens-Nassau story pass 2, part 2c-3a: a curated row for 1 HIDDEN storyless OSM pin on
-- Uniondale's Museum Row (handoff §6 story-lines (y)). The pin is stored in the box's places:v34 row with filler text
-- ("A local landmark (aircraft)."), so it serves hidden; a seed line would twin it. It becomes a curated row under the
-- pin's EXACT stored name at its stored coordinate.
-- Checks done (2026-10-28): name, id and coordinate as stored in places:v34 row 815_-1472 (Grumman OV-1B Mohawk, 1960,
-- osm_node6033958456 — the comma and year are part of the stored name, kept exactly); the HMdb marker (m285229) stands
-- 5 m from the pin; a served read of 815_-1472 (cached, storyHidden 38) does not return it; no other "Grumman OV-1B
-- Mohawk" pin among the 2,931 unique stored pins, so the row reaches only its own pin (CURATED_MATCH_M 2 km); no
-- same-article Wikipedia pin or gem within 300 m; the aircraft was photographed in place in 2025. Story from the HMdb
-- marker text. No line in names-502-queens-nassau-6.txt shares this name.
-- NOT given a row (gravestones): the two hidden "Museum Row" OSM ways (osm_way228607377, osm_way404400816, 66 m apart —
-- one same-name row would surface both, and Mitchel Field's story already serves on the Mitchel Air Base and Flight Line
-- pin ~300 m away); the hidden Nassau County Firefighters Museum pin (no HMdb marker — outside this pass's source).
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER the names-502-queens-nassau-6.txt commit (keep the habit).
-- Re-runnable: skipped when a same-name curated row sits within 50 m.
-- Expect 1 row returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect "Grumman OV-1B Mohawk, 1960" among the rows, dist_m 0. Re-check the map after 5 minutes (CURATED_INDEX_TTL_MS).
-- BACK-OUT: delete from public.curated_descriptions where note = '#502 hidden-pin row — Queens-Nassau part 2c-3a (2026-10-28)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Grumman OV-1B Mohawk, 1960$t$, 40.7283823::double precision, -73.5967756::double precision, $t$This 1960 OV-1B Mohawk is a Grumman reconnaissance plane of the kind flown over Vietnam's battlefields, one of the many aircraft built by Grumman's Long Island workforce; the company's retirees sponsor its display here.$t$, $t$https://www.hmdb.org/m.asp?m=285229$t$, $t$#502 hidden-pin row — Queens-Nassau part 2c-3a (2026-10-28)$t$)
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
