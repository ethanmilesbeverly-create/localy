-- 532_hidden_curated_3.sql — #532 part 4b-2: curated rows for two HIDDEN storyless OSM pins in the Bergen-Westchester box
-- (handoff §6 story-lines (y)). seed-resolve.ts cannot see a hidden pin, so a story line would plant a second pin beside
-- it; a curated row under the pin's EXACT name at its stored coordinate brings the pin back with its story instead.
-- Each row: the pin's name and coordinate as stored in its places:v34 row (read 2026-10-27); one sentence in our own
-- words from the HMdb marker; the marker as source_url. Checks done for every row: no other pin of the same name within
-- 2 km (CURATED_MATCH_M); no same-subject pin served within 300 m (no twin to double — the Historic District article
-- 32 m from the schoolhouse is the church district, a different subject); and the thing still exists.
--   School House Museum                — osm_node736950265, tiles 819_-1482 / 820_-1481 / 820_-1482 (marker m24985, 30 m)
--   Hiram Bauvelt Wildlife Art Museum  — osm_way667891619,  tiles 819_-1480 / 819_-1481 / 820_-1481 (marker m143637, 63 m)
--     ("Bauvelt" is OpenStreetMap's spelling; the row must match the stored name exactly. The museum is the Hiram
--      Blauvelt Art Museum, on the estate the marker describes.)
--
-- RUN: the SQL editor, this whole file in its own tab. Re-runnable: a row is skipped when a same-name curated row
-- already sits within 50 m. Expect 2 rows returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect these 2 among the rows, each dist_m 0, category history.
-- BACK-OUT: delete from public.curated_descriptions where note = '#532 hidden-pin row — Bergen-Westchester (2026-10-27)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$School House Museum$t$, 40.9856594::double precision, -74.093992::double precision, $t$Built in 1872 on the grounds of the Paramus Reformed Church, this was probably the fifth schoolhouse the church put up there, and it later served the township as District School No. 45.$t$, $t$https://www.hmdb.org/m.asp?m=24985$t$, $t$#532 hidden-pin row — Bergen-Westchester (2026-10-27)$t$),
  ($t$Hiram Bauvelt Wildlife Art Museum$t$, 40.9653743::double precision, -74.0313258::double precision, $t$The museum sits on the former Kimball Chase-Atwood estate, whose shingle-style carriage house and stables architect Fred W. Wentworth designed in 1896–98; the Elmer Blauvelt family owned it later.$t$, $t$https://www.hmdb.org/m.asp?m=143637$t$, $t$#532 hidden-pin row — Bergen-Westchester (2026-10-27)$t$)
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
