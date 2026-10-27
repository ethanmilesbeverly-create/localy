-- 532_hidden_curated_2.sql — #532 part 4: 10 curated rows that bring back the HIDDEN Old Croton Aqueduct Trail across the
-- Bergen-Westchester box (handoff §6 story-lines (y)). The OSM trail is stored in the box's tiles as 34 same-name
-- segments from Yonkers (40.90) to Ossining (41.18) and NONE is served — each is storyless, so the gate hides it
-- (#367). seed-resolve.ts cannot see a hidden pin, so the Old Croton Aqueduct marker (HMdb m193184, Ossining, the
-- Westchester list's tail mined in part 4) gets curated rows instead of a story line.
-- A curated row reaches every same-name pin within CURATED_MATCH_M (2 km), so the rows are spaced like #519's Lakefront
-- Trail: each sits EXACTLY on a stored segment's coordinate (places:v34, read 2026-10-26), and together they put all 34
-- segments within 1.9 km of a row (a greedy cover; the two segments north of the box edge, 41.18, are reached from row 1).
--    1. osm_way427531828  41.1680054, -73.8648317  Ossining, north of the Double Arch
--    2. osm_way238916014  41.1511340, -73.8589408  Ossining, south
--    3. osm_way238916017  41.1190324, -73.8603087  Scarborough–Sleepy Hollow
--    4. osm_way23517548   41.0916211, -73.8575451  Sleepy Hollow–Tarrytown
--    5. osm_way245634589  41.0668261, -73.8602541  Tarrytown–Irvington
--    6. osm_way245626043  41.0564723, -73.8611052  Irvington
--    7. osm_way250586785  41.0117001, -73.8767838  Dobbs Ferry–Hastings
--    8. osm_way79235976   40.9944083, -73.8783861  Hastings-on-Hudson
--    9. osm_way23517520   40.9354540, -73.8822285  Yonkers, north
--   10. osm_way441951761  40.9016356, -73.8827525  Yonkers, south
-- One sentence in our own words from the Ossining marker, the same on every row; the marker is the source_url.
-- CHECKS (all 10 rows): no same-name STORIED pin within 2 km — every "Old Croton Aqueduct Trail" pin in the box is
-- hidden; no twin to double — the only served aqueduct pin is wiki "New Croton Aqueduct" (a different aqueduct, 1.2 km
-- from row 4); the trail exists and is open (Old Croton Aqueduct State Historic Park). Left out on purpose: the two
-- hidden park pins ("Old Croton Aqueduct State Historic Park", "Old Croton Aqueduct State Park") and the hidden
-- "Old Croton Aqueduct Sing Sing Kill Weir Chamber" — different names, no marker in the lists mined.
--
-- RUN ORDER: AFTER names-532-bergen-westchester-4.txt is committed (its Double Arch line sits 28 m from a segment).
-- RUN: the SQL editor, this whole file in its own tab. Re-runnable: a row is skipped when a same-name curated row
-- already sits within 50 m. Expect 10 rows returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect 10 "Old Croton Aqueduct Trail" rows, every dist_m 0 (category trail).
-- BACK-OUT: delete from public.curated_descriptions where note = '#532 hidden-pin row — Old Croton Aqueduct Trail (2026-10-26)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Old Croton Aqueduct Trail$t$, 41.1680054::double precision, -73.8648317::double precision, $t$This path runs on top of the Old Croton Aqueduct, the brick-and-stone conduit built from 1837 to 1842 that carried Croton River water to New York City by gravity alone, on a gentle downhill grade the whole way.$t$, $t$https://www.hmdb.org/m.asp?m=193184$t$, $t$#532 hidden-pin row — Old Croton Aqueduct Trail (2026-10-26)$t$),
  ($t$Old Croton Aqueduct Trail$t$, 41.151134::double precision, -73.8589408::double precision, $t$This path runs on top of the Old Croton Aqueduct, the brick-and-stone conduit built from 1837 to 1842 that carried Croton River water to New York City by gravity alone, on a gentle downhill grade the whole way.$t$, $t$https://www.hmdb.org/m.asp?m=193184$t$, $t$#532 hidden-pin row — Old Croton Aqueduct Trail (2026-10-26)$t$),
  ($t$Old Croton Aqueduct Trail$t$, 41.1190324::double precision, -73.8603087::double precision, $t$This path runs on top of the Old Croton Aqueduct, the brick-and-stone conduit built from 1837 to 1842 that carried Croton River water to New York City by gravity alone, on a gentle downhill grade the whole way.$t$, $t$https://www.hmdb.org/m.asp?m=193184$t$, $t$#532 hidden-pin row — Old Croton Aqueduct Trail (2026-10-26)$t$),
  ($t$Old Croton Aqueduct Trail$t$, 41.0916211::double precision, -73.8575451::double precision, $t$This path runs on top of the Old Croton Aqueduct, the brick-and-stone conduit built from 1837 to 1842 that carried Croton River water to New York City by gravity alone, on a gentle downhill grade the whole way.$t$, $t$https://www.hmdb.org/m.asp?m=193184$t$, $t$#532 hidden-pin row — Old Croton Aqueduct Trail (2026-10-26)$t$),
  ($t$Old Croton Aqueduct Trail$t$, 41.0668261::double precision, -73.8602541::double precision, $t$This path runs on top of the Old Croton Aqueduct, the brick-and-stone conduit built from 1837 to 1842 that carried Croton River water to New York City by gravity alone, on a gentle downhill grade the whole way.$t$, $t$https://www.hmdb.org/m.asp?m=193184$t$, $t$#532 hidden-pin row — Old Croton Aqueduct Trail (2026-10-26)$t$),
  ($t$Old Croton Aqueduct Trail$t$, 41.0564723::double precision, -73.8611052::double precision, $t$This path runs on top of the Old Croton Aqueduct, the brick-and-stone conduit built from 1837 to 1842 that carried Croton River water to New York City by gravity alone, on a gentle downhill grade the whole way.$t$, $t$https://www.hmdb.org/m.asp?m=193184$t$, $t$#532 hidden-pin row — Old Croton Aqueduct Trail (2026-10-26)$t$),
  ($t$Old Croton Aqueduct Trail$t$, 41.0117001::double precision, -73.8767838::double precision, $t$This path runs on top of the Old Croton Aqueduct, the brick-and-stone conduit built from 1837 to 1842 that carried Croton River water to New York City by gravity alone, on a gentle downhill grade the whole way.$t$, $t$https://www.hmdb.org/m.asp?m=193184$t$, $t$#532 hidden-pin row — Old Croton Aqueduct Trail (2026-10-26)$t$),
  ($t$Old Croton Aqueduct Trail$t$, 40.9944083::double precision, -73.8783861::double precision, $t$This path runs on top of the Old Croton Aqueduct, the brick-and-stone conduit built from 1837 to 1842 that carried Croton River water to New York City by gravity alone, on a gentle downhill grade the whole way.$t$, $t$https://www.hmdb.org/m.asp?m=193184$t$, $t$#532 hidden-pin row — Old Croton Aqueduct Trail (2026-10-26)$t$),
  ($t$Old Croton Aqueduct Trail$t$, 40.935454::double precision, -73.8822285::double precision, $t$This path runs on top of the Old Croton Aqueduct, the brick-and-stone conduit built from 1837 to 1842 that carried Croton River water to New York City by gravity alone, on a gentle downhill grade the whole way.$t$, $t$https://www.hmdb.org/m.asp?m=193184$t$, $t$#532 hidden-pin row — Old Croton Aqueduct Trail (2026-10-26)$t$),
  ($t$Old Croton Aqueduct Trail$t$, 40.9016356::double precision, -73.8827525::double precision, $t$This path runs on top of the Old Croton Aqueduct, the brick-and-stone conduit built from 1837 to 1842 that carried Croton River water to New York City by gravity alone, on a gentle downhill grade the whole way.$t$, $t$https://www.hmdb.org/m.asp?m=193184$t$, $t$#532 hidden-pin row — Old Croton Aqueduct Trail (2026-10-26)$t$)
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
