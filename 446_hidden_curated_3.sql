-- 446_hidden_curated_3.sql — #446 Pittsburgh story pass part 2 (b2-5): a curated row for 1 HIDDEN storyless OSM pin
-- (handoff §6 story-lines (y)). seed-resolve.ts cannot see a hidden pin, so a story line would plant a second pin beside it;
-- a curated row under the pin's EXACT name at its stored coordinate brings the pin back with its story instead.
-- Checks done (2026-10-30, all tiles warm):
--   Arsenal School — osm_way253999569, 40.4676466, -79.9624711, stored in rows 809_-1599 and 810_-1599 with the filler
--     "A local landmark (heritage).", absent from both tiles' served answers (44 and 25 pins; both serve Arsenal Park), so
--     hidden. "Arsenal School" is not an article title (the article is "Arsenal Middle School", 31 m off, in no stored tile,
--     #539). #542: the tile CONTAINING the pin (Math.round → 809_-1599) stores it, so a far-search landing adopts it.
-- Same-name storied pin within 2 km: none. Still stands (an active PreK–8 school).
-- The Johnny Unitas PHMC gem (86 m, on the school's athletic field) keeps its own story; this row does not repeat it.
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER names-446-pittsburgh-9.txt's commit. Re-runnable: skipped when
-- a same-name curated row sits within 50 m. Expect 1 row returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect Arsenal School among the rows, dist_m 0.
-- Served within the 5-minute curated cache (FROM KATY-ENERGY CORRIDOR (3)) — wait it out before phone QA.
-- BACK-OUT: delete from public.curated_descriptions where note = '#446 hidden-pin row — Pittsburgh part 2 (b2-5) (2026-10-30)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Arsenal School$t$, 40.4676466::double precision, -79.9624711::double precision, $t$Lawrenceville won this school by a land swap that gave the federal government a Forbes Avenue parcel for part of the old Allegheny Arsenal's grounds; the junior high opened here in 1932, with a bricklaying student from the vocational school laying its cornerstone, and an elementary wing followed in 1939.$t$, $t$https://en.wikipedia.org/wiki/Arsenal_Middle_School$t$, $t$#446 hidden-pin row — Pittsburgh part 2 (b2-5) (2026-10-30)$t$)
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
