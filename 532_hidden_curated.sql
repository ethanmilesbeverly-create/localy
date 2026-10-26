-- 532_hidden_curated.sql — #532 part 3: curated rows for six HIDDEN storyless OSM pins in the Bergen-Westchester box
-- (handoff §6 story-lines (y)). seed-resolve.ts cannot see a hidden pin, so a story line would plant a second pin beside
-- it; a curated row under the pin's EXACT name at its stored coordinate brings the pin back with its story instead.
-- Rows: 4 from Rockland (part 3's mining) + the 2 Westchester lines part 2 held (Howe's HQ, Battle Park).
-- Each row: the pin's name and coordinate as stored in its places:v34 row (read 2026-10-26); one sentence in our own
-- words from the HMdb marker; the marker as source_url. Checks done for every row: no same-name pin within 2 km
-- (CURATED_MATCH_M), no served pin of any name within 300 m (no twin to double), and the thing still exists.
--   The Flywheel: A Monument to Piermont's Industrial Past — osm_node9316622808, tile 821_-1478/-1479 (marker m138606, 5 m)
--   Indian Rock                    — osm_node10726866893, tile 822_-1482/-1483 (marker m215815, 4 m)
--   Piermont Train Station Museum  — osm_way105426881,  tile 821_-1478/-1479 (marker m138616, 14 m)
--   Suffern Railroad Museum        — osm_way138481617,  tile 822_-1483/823_-1483 (marker m84081, 25 m)
--   Sir William Howe Headquarters  — osm_node8184514271, tile 820_-1476 (marker m310589, 5 m)
--   Battle of White Plains Park    — osm_way651415881,  tile 820_-1476/821_-1476 (marker m8310, 32 m)
--
-- RUN: the SQL editor, this whole file in its own tab. Re-runnable: a row is skipped when a same-name curated row
-- already sits within 50 m. Expect 6 rows returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect these 6 among the rows, every dist_m 0 (history ×5, park ×1 — Battle of White Plains Park).
-- BACK-OUT: delete from public.curated_descriptions where note = '#532 hidden-pin row — Bergen-Westchester (2026-10-26)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$The Flywheel: A Monument to Piermont's Industrial Past$t$, 41.0415975::double precision, -73.9146117::double precision, $t$Workers installed this flywheel in 1902 as part of the Piermont Paper Company's steam-driven power plant; it now stands as a monument to the village's mill era.$t$, $t$https://www.hmdb.org/m.asp?m=138606$t$, $t$#532 hidden-pin row — Bergen-Westchester (2026-10-26)$t$),
  ($t$Indian Rock$t$, 41.1134856::double precision, -74.1291228::double precision, $t$This 17,300-ton block of granite gneiss, about a billion years old, is a glacial erratic the Laurentide Ice Sheet dropped here some 21,000 years ago.$t$, $t$https://www.hmdb.org/m.asp?m=215815$t$, $t$#532 hidden-pin row — Bergen-Westchester (2026-10-26)$t$),
  ($t$Piermont Train Station Museum$t$, 41.0415352::double precision, -73.9183814::double precision, $t$The Northern Railroad, finished in 1859, ran trains from Jersey City to this station; its old route through the village is today's Erie Path.$t$, $t$https://www.hmdb.org/m.asp?m=138616$t$, $t$#532 hidden-pin row — Bergen-Westchester (2026-10-26)$t$),
  ($t$Suffern Railroad Museum$t$, 41.1173551::double precision, -74.1559254::double precision, $t$As the gateway to the Ramapo Pass, Suffern became an important stop once the Erie Railroad laid track from Piermont Pier in 1841, and its depot served the line for a century.$t$, $t$https://www.hmdb.org/m.asp?m=84081$t$, $t$#532 hidden-pin row — Bergen-Westchester (2026-10-26)$t$),
  ($t$Sir William Howe Headquarters$t$, 41.004028::double precision, -73.7804018::double precision, $t$Sir William Howe, commander in chief of the British forces in America, made this house his headquarters after the Battle of White Plains in October 1776.$t$, $t$https://www.hmdb.org/m.asp?m=310589$t$, $t$#532 hidden-pin row — Bergen-Westchester (2026-10-26)$t$),
  ($t$Battle of White Plains Park$t$, 41.0300814::double precision, -73.7798671::double precision, $t$This park sits on Chatterton Hill, where the heaviest fighting of the Battle of White Plains took place on October 28, 1776, as British and Hessian troops drove the Americans from the crest.$t$, $t$https://www.hmdb.org/m.asp?m=8310$t$, $t$#532 hidden-pin row — Bergen-Westchester (2026-10-26)$t$)
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
