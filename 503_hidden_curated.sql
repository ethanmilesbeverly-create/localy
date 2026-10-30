-- 503_hidden_curated.sql — #503 core New York rescue lines: a curated row for 1 HIDDEN storyless OSM pin
-- (handoff §6 story-lines (y)). seed-resolve.ts cannot see a hidden pin, so a story line would plant a second pin beside it;
-- a curated row under the pin's EXACT name at its stored coordinate brings the pin back with its story instead.
-- Checks done (2026-10-29):
--   Freedom of the Human Spirit — osm_node2610355987, 40.7478868, -73.8458849, category art, stored in rows 815_-1477
--     (core New York, the pin's own tile) and 815_-1476 (Queens-Nassau) with the filler "A sculpture by Marshall
--     Fredericks.", absent from both served answers, so hidden. Its Wikipedia title only redirects to the artist's
--     article, so no pin or article could match it both ways (#437/#438) — why every gate dropped it.
--   545 unique stored pins in rows 814…816 × -1478…-1475: one with this name, none on the Fredericks article; no served
--     same-article pin within 300 m (Soul in Flight 105 m, Unisphere ~180 m).
-- Sources disagree on height (27 vs 28 ft), swans (two vs three) and a 1996 move, so the story states none of them.
-- The five Shea Stadium base plaques are NOT here — a #519 gravestone (519_batch1_remove_shea.sql); do not re-mine them.
--
-- RECONSTRUCTED 2026-10-30: the original file was applied in the SQL editor on 2026-10-29 but never saved or committed.
-- This copy was rebuilt from the live row — name, coordinate and description as served by nearby-places
-- (descSource curated), note as recorded on roadmap #503. The row is already live, so running this file inserts nothing.
--
-- RUN: already applied 2026-10-29 — do NOT run again (a re-run is harmless: skipped when a same-name curated row sits
-- within 50 m; expect 0 rows). Original expectation: 1 row returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expected Freedom of the Human Spirit as art, dist_m 0.
-- Served within the 5-minute curated cache (FROM KATY-ENERGY CORRIDOR (3)).
-- BACK-OUT: delete from public.curated_descriptions where note = '#503 hidden-pin row — New York (2026-10-29)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Freedom of the Human Spirit$t$, 40.7478868::double precision, -73.8458849::double precision, $t$Marshall Fredericks made this colossal bronze of a man and a woman rising skyward among wild swans for the 1964–65 World's Fair; NYC Parks conserved it in 2015, restoring its pale green patina.$t$, $t$https://www2.nycgovparks.org/parks/Q099/monuments/554$t$, $t$#503 hidden-pin row — New York (2026-10-29)$t$)
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
