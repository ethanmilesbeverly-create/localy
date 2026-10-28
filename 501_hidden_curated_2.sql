-- 501_hidden_curated_2.sql — #501 Middlesex-Union part 1b: a curated row for one more HIDDEN storyless OSM pin (handoff §6 (y)).
-- Rutgers Geology Museum was left out of 501_hidden_curated.sql on the guess that the serve path would resolve it through its
-- name's redirect to "Geology Hall, New Brunswick, New Jersey" (as Queens Campus resolves to its own article). Phone QA
-- 2026-10-27 showed it does NOT show: a redirect title is not enough for the strict match, so the pin is hidden.
-- Checks done (2026-10-27): the pin's name and coordinate as stored in places:v34:810_-1489 (osm_node4403759525); no other
-- "geology" pin within 2 km (CURATED_MATCH_M); the Geology Hall article is in no stored tile, so no wiki twin is served; the
-- nearest served pins are other buildings (Winants Hall 41 m, Queens Campus 42 m).
--
-- RUN: the SQL editor, this whole file in its own tab. Re-runnable: skipped when a same-name curated row sits within 50 m.
-- Expect 1 row returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect Rutgers Geology Museum among the rows, dist_m 0.
-- BACK-OUT: delete from public.curated_descriptions where note = '#501 hidden-pin row — Middlesex-Union part 1b (2026-10-27)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Rutgers Geology Museum$t$, 40.4987008::double precision, -74.446722::double precision, $t$The museum fills Geology Hall, an 1872 brownstone by Henry Janeway Hardenbergh — later the architect of the Dakota and the Plaza Hotel — and shows a New Jersey mastodon skeleton alongside an Egyptian mummy.$t$, $t$https://www.hmdb.org/m.asp?m=10017$t$, $t$#501 hidden-pin row — Middlesex-Union part 1b (2026-10-27)$t$)
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
