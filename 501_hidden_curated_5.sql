-- 501_hidden_curated_5.sql — #501 Middlesex-Union part 4: a curated row for one HIDDEN storyless OSM pin in Somerset County
-- (handoff §6 story-lines (y)). seed-resolve.ts cannot see a hidden pin, so a story line would plant a second pin beside it;
-- a curated row under the pin's EXACT name at its stored coordinate brings the pin back with its story instead.
-- Checks done (2026-10-28): the pin's name and coordinate as stored in places:v34:811_-1492 (osm_way585500673, name stored as
-- "Firemen's Museuem" — misspelling kept, because the row must match the stored name; desc "A local museum."); absent from that
-- tile's served answer (18 pins, under the ~20 cap), so it is hidden (FROM MIDDLESEX-UNION (3)); no other pin of that name
-- among the box's 1,237 stored pins (CURATED_MATCH_M). The article "West End Hose Company Number 3" puts the firehouse 8 m from
-- the pin, and HMdb's Fireman's Museum marker (m7315) stands 24 m off; that article is in no stored tile (#539's cap), so no
-- wiki twin is served.
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER the names-501-middlesex-union-4.txt commit (no line sits within
-- 2 km of this pin, but keep the habit). Re-runnable: skipped when a same-name curated row sits within 50 m.
-- Expect 1 row returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect Firemen's Museuem among the rows, dist_m 0.
-- BACK-OUT: delete from public.curated_descriptions where note = '#501 hidden-pin row — Middlesex-Union part 4 (2026-10-28)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Firemen's Museuem$t$, 40.5706152::double precision, -74.6180553::double precision, $t$Somerville's fire museum is housed in the West End Hose Company Number 3, a two-story brick firehouse on North Doughty Avenue that was added to the National Register of Historic Places in 2002.$t$, $t$https://en.wikipedia.org/wiki/West_End_Hose_Company_Number_3$t$, $t$#501 hidden-pin row — Middlesex-Union part 4 (2026-10-28)$t$)
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
