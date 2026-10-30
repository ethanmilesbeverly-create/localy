-- 446_hidden_curated_4.sql — #446 Pittsburgh step (5): curated rows for 3 HIDDEN storyless OSM pins that the gate dry run
-- dropped (handoff §6 story-lines (y); its storied drops are rescue lines). seed-resolve.ts cannot see a hidden pin, so a story
-- line would plant a second pin beside it; a curated row under the pin's EXACT name at its stored coordinate brings the pin
-- back with its story instead.
-- THE GATE DRY RUN (2026-10-30, from the sandbox, gate-tiles 2026-10-29a, --all with GATE_METRO=Pittsburgh, Wikipedia only):
--   48 of 48 tiles read, 0 throttled, 0 held, 0 timeouts; 1,475 drops (792 unique — every one a filler description) and 156
--   resolved. Of the 134 landmark-class drops (history, art, memorials, museums), 9 are already storied by the live serve path
--   and 125 are hidden; each was read against the 415 approved gems, every served pin within 80 m and a Wikipedia geosearch.
--   Five carry a real story in an article and nothing live tells it. These three pass #542; the other two (the Honus Wagner
--   and Mao Yisheng statues) do not and go as seeds under different names in names-446-pittsburgh-12.txt.
-- Checks done (2026-10-30, all tiles warm):
--   Light Up! — osm_node1668422164, 40.4419845, -79.9545208, filler "A sculpture by Tony Smith.", stored in 809_-1599 and
--     809_-1600, absent from both served answers. Article "Light Up (sculpture)" has no coordinate, so no tile carries it.
--     #542: the containing tile (Math.round → 809_-1599) stores it.
--   Guyasuta — osm_node7891092851, 40.494638, -79.932305 (Main and North Canal Streets, Sharpsburg), filler "A public
--     statue.", stored in 810_-1598 and 810_-1599, absent from both served answers. The story is the Sharpsburg statue's
--     paragraph in the "Guyasuta" article — NOT the 1915 Keck statue from the Point Bridge, now on Art Rooney Avenue (that
--     one has no stored pin under this name). #542: the containing tile 810_-1599 stores it.
--   Edward Manning Bigelow — osm_node303455197, 40.4401997, -79.9472028 (his monument in Schenley Park), filler "A local
--     landmark (monument).", stored in 809_-1598 and 809_-1599, absent from both served answers. The article never mentions
--     the monument, so the story says only what the article does about him and the park. #542: the containing tile 809_-1599
--     stores it.
-- Same-name pin within 2 km (CURATED_MATCH_M): none — each name is one pin across all 99 stored rows in the ring
--   (804–812 / −1605…−1595). No gem within 150 m of any of the three tells the same story.
--
-- RUN: the SQL editor, this whole file in its own tab (select nothing — a highlighted fragment runs alone). Re-runnable:
--   skipped when a same-name curated row sits within 50 m. Expect A TABLE WITH 3 ROWS on the first run, an empty result on a
--   re-run. A plain "Success" with no table on the FIRST run means nothing was inserted — re-run the whole file.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect Edward Manning Bigelow, Guyasuta and Light Up! among the rows, dist_m 0.
-- Served within the 5-minute curated cache (FROM KATY-ENERGY CORRIDOR (3)) — wait it out before phone QA.
-- BACK-OUT: delete from public.curated_descriptions where note = '#446 hidden-pin row — Pittsburgh step (5) (2026-10-30)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Light Up!$t$, 40.4419845::double precision, -79.9545208::double precision, $t$Tony Smith made this bright yellow steel sculpture for Westinghouse, which set it up at Gateway Center downtown in 1974; it was given to Pitt and moved here in 1988, and Smith said its colour came from a yellow newspaper truck he had watched winding through the city from the Mount Washington overlook.$t$, $t$https://en.wikipedia.org/wiki/Light_Up_(sculpture)$t$, $t$#446 hidden-pin row — Pittsburgh step (5) (2026-10-30)$t$),
  ($t$Guyasuta$t$, 40.494638::double precision, -79.932305::double precision, $t$The Seneca leader Guyasuta spent his last years in a cabin outside Sharpsburg; his statue and a horse fountain were given to the town in 1896 for this plaza, and after a car wrecked the cast-iron original in 1930 a copy was cast from its mould, later replaced in bronze once a truck hit the fountain in the 1980s.$t$, $t$https://en.wikipedia.org/wiki/Guyasuta$t$, $t$#446 hidden-pin row — Pittsburgh step (5) (2026-10-30)$t$),
  ($t$Edward Manning Bigelow$t$, 40.4401997::double precision, -79.9472028::double precision, $t$Remembered as the father of Pittsburgh's parks, city engineer Edward Manning Bigelow talked Mary Schenley into giving the land that opened as Schenley Park in 1889, then bought Highland Park's ground parcel by parcel and laid out boulevards to link them — Bigelow Boulevard was renamed for him days after his death in 1916.$t$, $t$https://en.wikipedia.org/wiki/Edward_Manning_Bigelow$t$, $t$#446 hidden-pin row — Pittsburgh step (5) (2026-10-30)$t$)
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
