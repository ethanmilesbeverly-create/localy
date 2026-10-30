-- 446_hidden_curated_2.sql — #446 Pittsburgh story pass part 2 (b2-1): a curated row for 1 HIDDEN storyless OSM pin
-- (handoff §6 story-lines (y)). seed-resolve.ts cannot see a hidden pin, so a story line would plant a second pin beside it;
-- a curated row under the pin's EXACT name at its stored coordinate brings the pin back with its story instead.
-- Checks done (2026-10-29, all tiles warm):
--   Soldiers and Sailors Monument — osm_node5330245776, 40.4530436, -80.0125113, stored with the filler "A war memorial.",
--     absent from tile 809_-1600's served answer (39 pins, curatedIndexRows 1651), so hidden. HMdb's "Allegheny County
--     Soldier's Monument" (m=58142, Civil War) stands 7 m away in West Park; its inscription is the source.
-- Same-name storied pin within 2 km: none.
--
-- RUN: the SQL editor, this whole file in its own tab. Re-runnable: skipped when a same-name curated row sits within 50 m.
-- Expect 1 row returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect Soldiers and Sailors Monument among the rows, dist_m 0.
-- Served within the 5-minute curated cache (FROM KATY-ENERGY CORRIDOR (3)) — wait it out before phone QA.
-- BACK-OUT: delete from public.curated_descriptions where note = '#446 hidden-pin row — Pittsburgh part 2 (b2-1) (2026-10-29)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Soldiers and Sailors Monument$t$, 40.4530436::double precision, -80.0125113::double precision, $t$Allegheny County raised this West Park monument to the memory of its 4,000 men who died fighting to hold the Union together in the Civil War.$t$, $t$https://www.hmdb.org/m.asp?m=58142$t$, $t$#446 hidden-pin row — Pittsburgh part 2 (b2-1) (2026-10-29)$t$)
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
