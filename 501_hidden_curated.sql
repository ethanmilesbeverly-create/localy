-- 501_hidden_curated.sql — #501 Middlesex-Union part 1: a curated row for one HIDDEN storyless OSM pin (handoff §6 story-lines (y)).
-- seed-resolve.ts cannot see a hidden pin, so a story line would plant a second pin beside it; a curated row under the pin's
-- EXACT name at its stored coordinate brings the pin back with its story instead.
-- Checks done (2026-10-27): no other pin of the same name within 2 km (CURATED_MATCH_M); no pin of any kind served within
-- 300 m (no twin to double); no Wikipedia article for the park (so the serve path cannot resolve it itself).
--   Oak Tree Pond Park — osm_way39642090, tile 812_-1488 (markers m213296 and m53341 stand in the park, 23–78 m)
-- CONSIDERED AND DROPPED: Queens Campus (Old Queens) is NOT hidden — the serve path resolves it to its own article and it is
--   served at 0 m; Rutgers Geology Museum's name redirects to "Geology Hall, New Brunswick, New Jersey", the same resolve path,
--   so it is left alone (verify on the phone; if it does not show, give it a row in a later part).
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER the names-501-middlesex-union.txt commit (no line sits near this
-- pin, but keep the habit). Re-runnable: a row is skipped when a same-name curated row already sits within 50 m.
-- Expect 1 row returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect Oak Tree Pond Park among the rows, dist_m 0, category park.
-- BACK-OUT: delete from public.curated_descriptions where note = '#501 hidden-pin row — Middlesex-Union part 1 (2026-10-27)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Oak Tree Pond Park$t$, 40.576644::double precision, -74.3755929::double precision, $t$On June 26, 1777, American troops clashed with Howe and Cornwallis's army at the Oak Tree crossroads here, one of the running fights now called the Battle of the Short Hills; the spring-fed pond beside it is northern Edison's largest.$t$, $t$https://www.hmdb.org/m.asp?m=213296$t$, $t$#501 hidden-pin row — Middlesex-Union part 1 (2026-10-27)$t$)
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
