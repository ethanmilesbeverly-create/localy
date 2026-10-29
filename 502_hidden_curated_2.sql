-- 502_hidden_curated_2.sql — #502 Queens-Nassau story pass 2, part 2a: curated rows for 7 HIDDEN storyless OSM pins in
-- Freeport and Glen Cove (handoff §6 story-lines (y)). Both towns' markers are mapped in OSM node by node and hidden as
-- storyless (the Katy pattern, FROM KATY-ENERGY CORRIDOR (1)), so seed lines would twin them; each becomes a curated row
-- under the pin's EXACT stored name at its stored coordinate.
-- Checks done (2026-10-28): names, ids and coordinates as stored in places:v34 rows 812_-1472, 813_-1471/-1472 (Freeport)
-- and 817_-1472/-1473, 818_-1473 (Glen Cove); each marker 1–15 m from its pin; no same-name pin within 2 km (CURATED_MATCH_M)
-- among the box's 3,233 stored pins — so the generic names (Saw Mill, The Place, R.R. Station, Methodist Church) reach
-- only their own pin; no storied pin within 120 m. Stories from the HMdb town lists (Freeport 41, Glen Cove 20 entries).
-- Left hidden on purpose: Libtery Pole (a Civil War flagpole site, one line, no story); Colonel James Dean Historic Site
-- (person-only plaque); "Cannon" at Freeport's first-school site (the Trubia Rifle — too generic a name for a row).
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER the names-502-queens-nassau-2.txt commit (no line there sits
-- within 2 km of these names, but keep the habit). Re-runnable: skipped when a same-name curated row sits within 50 m.
-- Expect 7 rows returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect these 7 names among the rows, dist_m 0. Re-check the map after 5 minutes (CURATED_INDEX_TTL_MS).
-- BACK-OUT: delete from public.curated_descriptions where note = '#502 hidden-pin row — Queens-Nassau part 2a (2026-10-28)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Woodcleft Canal Site$t$, 40.6345701::double precision, -73.5820368::double precision, $t$John Randall and William G. Miller dredged Woodcleft Canal at the end of the 1800s, creating what became the largest working waterfront on Long Island's South Shore, today's Nautical Mile.$t$, $t$https://www.hmdb.org/m.asp?m=127239$t$, $t$#502 hidden-pin row — Queens-Nassau part 2a (2026-10-28)$t$),
  ($t$Woodcleft Inn$t$, 40.6399837::double precision, -73.5831402::double precision, $t$Freeport's first summer hotel opened on this site in 1897, built by the developers Randall & Miller, and in 1907 it was sold to the Society of St. Vincent de Paul as a fresh-air home.$t$, $t$https://www.hmdb.org/m.asp?m=126821$t$, $t$#502 hidden-pin row — Queens-Nassau part 2a (2026-10-28)$t$),
  ($t$Starch Works$t$, 40.8615077::double precision, -73.6342314::double precision, $t$From 1855 the largest cornstarch plant in the world stood here, until the Great Fire of 1906 destroyed the building.$t$, $t$https://www.hmdb.org/m.asp?m=164187$t$, $t$#502 hidden-pin row — Queens-Nassau part 2a (2026-10-28)$t$),
  ($t$Saw Mill$t$, 40.8629099::double precision, -73.6363406::double precision, $t$Joseph Carpenter put up a sawmill on this site in 1668, the same year Glen Cove's first settlers built their homes along The Place.$t$, $t$https://www.hmdb.org/m.asp?m=221073$t$, $t$#502 hidden-pin row — Queens-Nassau part 2a (2026-10-28)$t$),
  ($t$The Place$t$, 40.8646677::double precision, -73.6390773::double precision, $t$Glen Cove's first settlers built their homes along this street in 1668.$t$, $t$https://www.hmdb.org/m.asp?m=220447$t$, $t$#502 hidden-pin row — Queens-Nassau part 2a (2026-10-28)$t$),
  ($t$R.R. Station$t$, 40.8584957::double precision, -73.6204572::double precision, $t$The first train from Glen Cove to New York left from here at Glen Street on May 16, 1867.$t$, $t$https://www.hmdb.org/m.asp?m=65073$t$, $t$#502 hidden-pin row — Queens-Nassau part 2a (2026-10-28)$t$),
  ($t$Methodist Church$t$, 40.8664669::double precision, -73.6306868::double precision, $t$Circuit rider Ezekiel Cooper founded this congregation in 1785, making it one of the oldest Methodist societies on Long Island.$t$, $t$https://www.hmdb.org/m.asp?m=207417$t$, $t$#502 hidden-pin row — Queens-Nassau part 2a (2026-10-28)$t$)
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
