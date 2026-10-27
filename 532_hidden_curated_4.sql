-- 532_hidden_curated_4.sql — #532 part 4b-3: curated rows for two HIDDEN storyless OSM pins in the Bergen-Westchester box
-- (handoff §6 story-lines (y)). seed-resolve.ts cannot see a hidden pin, so a story line would plant a second pin beside
-- it; a curated row under the pin's EXACT name at its stored coordinate brings the pin back with its story instead.
-- Each row: the pin's name and coordinate as stored in its places:v34 row (read 2026-10-27); one sentence in our own
-- words; the source as source_url. Checks done for every row: no other pin of the same name within 2 km
-- (CURATED_MATCH_M); no pin of any kind served within 300 m (no twin to double — Eastside Park's own Wikipedia article
-- is not in any stored tile); and the thing still exists.
--   Eastside Park           — osm_way39648883,  tiles 818_-1483 / 818_-1482 / 819_-1483 (article "Eastside Park (Paterson,
--                             New Jersey)" 40.9158, −74.1361; the Pulaski, Godwin and Curie markers stand in it)
--   Fort Independence Park  — osm_way423894006, tile 818_-1477 (marker m310443 on the playground gatepost, 201 m)
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER the names-532-bergen-westchester-7.txt commit (order does
-- not matter for these two — no line sits near either — but keep the habit). Re-runnable: a row is skipped when a
-- same-name curated row already sits within 50 m. Expect 2 rows returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect these 2 among the rows, each dist_m 0, category park.
-- BACK-OUT: delete from public.curated_descriptions where note = '#532 hidden-pin row — Bergen-Westchester 4b-3 (2026-10-27)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Eastside Park$t$, 40.9164781::double precision, -74.1360201::double precision, $t$Paterson bought Civil War colonel Andrew Derrom's 66-acre estate for this park, laid out in 1899 by John Y. Culyer, who had worked on Central and Prospect Parks; it anchors a National Register historic district.$t$, $t$https://en.wikipedia.org/wiki/Eastside_Park_(Paterson,_New_Jersey)$t$, $t$#532 hidden-pin row — Bergen-Westchester 4b-3 (2026-10-27)$t$),
  ($t$Fort Independence Park$t$, 40.8818211::double precision, -73.8939196::double precision, $t$After Washington rode out to inspect the King's Bridge in June 1776, his troops threw up an earthwork on this hill to guard it — the outpost later called Fort Independence.$t$, $t$https://www.hmdb.org/m.asp?m=310443$t$, $t$#532 hidden-pin row — Bergen-Westchester 4b-3 (2026-10-27)$t$)
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
