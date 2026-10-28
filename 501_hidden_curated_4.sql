-- 501_hidden_curated_4.sql — #501 Middlesex-Union part 3: curated rows for three HIDDEN storyless OSM pins in Union County
-- (handoff §6 story-lines (y)). seed-resolve.ts cannot see a hidden pin, so a story line would plant a second pin beside it;
-- a curated row under the pin's EXACT name at its stored coordinate brings the pin back with its story instead.
-- Each row: the pin's name and coordinate as stored in its places:v34 row (read 2026-10-28); one sentence in our own words;
-- the source as source_url. Checks done for every row (2026-10-28): absent from its tile's served answer, which serves fewer
-- than ~20 pins (FROM MIDDLESEX-UNION (3)); no other pin of the same name among the box's 1,237 stored pins (CURATED_MATCH_M);
-- no Wikipedia article for the place, so the serve path cannot resolve it and no wiki twin is served.
--   Shakespeare Garden               — osm_way344307077,  tile 812_-1488 (19 served); marker m94481 12 m; inside the served
--                                      Cedar Brook Park
--   New Providence Historical Society — osm_way1158205844, tile 814_-1488 (14 served); its Salt Box Museum marker m251755 13 m
--   Briant Park                      — osm_way40136501,   tile 814_-1486 (15 served); marker m193098 ~200 m, in the park
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER the names-501-middlesex-union-3.txt commit (no line sits within
-- 1 km of these pins, but keep the habit). Re-runnable: a row is skipped when a same-name curated row already sits within
-- 50 m. Expect 3 rows returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect these 3 among the rows, each dist_m 0.
-- BACK-OUT: delete from public.curated_descriptions where note = '#501 hidden-pin row — Middlesex-Union part 3 (2026-10-28)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Shakespeare Garden$t$, 40.6057171::double precision, -74.4117242::double precision, $t$Laid out in Cedar Brook Park more than 75 years ago, the Shakespeare Garden is still tended by the Plainfield Garden Club, historically a volunteer women's club.$t$, $t$https://www.hmdb.org/m.asp?m=94481$t$, $t$#501 hidden-pin row — Middlesex-Union part 3 (2026-10-28)$t$),
  ($t$New Providence Historical Society$t$, 40.7048207::double precision, -74.4086034::double precision, $t$The society's Salt Box Museum is the Garrison-Dickinson-Genung House, whose east half was built around 1842 for Augustus Garrison, a local farmer and sexton of the New Providence Presbyterian Church.$t$, $t$https://www.hmdb.org/m.asp?m=251755$t$, $t$#501 hidden-pin row — Middlesex-Union part 3 (2026-10-28)$t$),
  ($t$Briant Park$t$, 40.7140984::double precision, -74.3365929::double precision, $t$Farmed by generations of the Briant family until Union County acquired it in 1930, the park was laid out to a design by Olmsted Brothers, the firm founded by Frederick Law Olmsted's sons.$t$, $t$https://www.hmdb.org/m.asp?m=193098$t$, $t$#501 hidden-pin row — Middlesex-Union part 3 (2026-10-28)$t$)
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
