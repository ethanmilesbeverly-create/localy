-- 502_hidden_curated.sql — #502 Queens-Nassau story pass 2, part 1: curated rows for the gate's rescue lines
-- (handoff §6 story-lines (y)). #482's gate dropped these storied places for want of a matching article; after #509's
-- rebuild every one is now a LIVE-BUT-HIDDEN storyless OSM pin, which seed-resolve.ts cannot see (a seed would twin it),
-- so each gets a curated row under the pin's EXACT stored name at its stored coordinate instead.
-- Checks done (2026-10-28): names, ids and coordinates as stored in the places:v34 rows of the box's 48 tiles plus one ring
-- (58 rows read with the publishable key); each pin absent from its tile's served answer and present under showhidden (so
-- hidden); no same-name pin within 2 km (CURATED_MATCH_M) among the 3,233 stored pins; no storied pin or gem within 300 m on
-- the same subject (the Roosevelt grave gems ~150 m from the sanctuary and the Ward clock tower 10–17 m from the cannon are
-- other subjects). Each still exists (the F-14 test below).
-- ONE ROW IS A FIX, NOT A RESCUE: Garvies Point Museum (osm_way456415311) is SERVED today with the lead of "List of museums on
-- Long Island" — the #538 class. A curated row replaces a pin's line on serve even when it carries a Wikipedia intro (#419).
-- Left out on purpose:
--   Northrop Grumman F-14 Tomcat (osm_node6240910909) — the jet left Bethpage for the Cradle of Aviation Museum in June 2022;
--     the OSM pin is stale, so it stays hidden (story-lines (y) check 3, the thing must still exist).
--   Grumman OV-1B Mohawk — an outdoor exhibit 59 m from the served Cradle of Aviation Museum pin (operator call, 2026-10-28).
--   Lakeville A.M.E. Zionist Church Cemetery — no source tells the cemetery's own story; the CHURCH (organized 1821, building
--     1832) is the story and is not on the map — it becomes a seed line in part 2.
--   Matinecock Friends Meetinghouse Cemetery and Saint George's Episcopal Churdyard — their churches' articles already serve
--     beside them (61 m and 19–24 m).
--   Old Bethpage Village Restoration — #519 batch 1 already gave its visitor-centre pin a row, and it serves.
--
-- RUN: the SQL editor, this whole file in its own tab. Re-runnable: skipped when a same-name curated row sits within 50 m.
-- Expect 9 rows returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect these 9 names among the rows, dist_m 0. Re-check the map after 5 minutes (CURATED_INDEX_TTL_MS).
-- BACK-OUT: delete from public.curated_descriptions where note = '#502 rescue row — Queens-Nassau part 1 (2026-10-28)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Falaise$t$, 40.8609171::double precision, -73.689241::double precision, $t$Harry Guggenheim built this cliffside manor in 1923 on 90 acres his father gave him as a wedding gift, his close friend Charles Lindbergh wrote his book "We" here, and Guggenheim left the house to Nassau County when he died in 1971.$t$, $t$https://longislandpress.com/2017/10/30/a-cliffside-dream$t$, $t$#502 rescue row — Queens-Nassau part 1 (2026-10-28)$t$),
  ($t$Garvies Point Museum$t$, 40.8596868::double precision, -73.6514474::double precision, $t$The museum sits on the former estate of Dr. Thomas Garvie, a Scottish-born physician who settled in Glen Cove in the early 1800s, and among its geology exhibits are local clay concretions that Native Americans used as paint pots.$t$, $t$https://www.nassaucountyny.gov/2821/Garvies-Point-Museum-and-Preserve$t$, $t$#502 rescue row — Queens-Nassau part 1 (2026-10-28)$t$),
  ($t$Theodore Roosevelt Sanctuary and Audubon Center$t$, 40.8695563::double precision, -73.507756::double precision, $t$Opened in 1923 on land the Roosevelt family gave in Theodore Roosevelt's memory, this was the country's first Audubon songbird sanctuary, a short walk from the president's grave.$t$, $t$https://ny.audubon.org/node/10026$t$, $t$#502 rescue row — Queens-Nassau part 1 (2026-10-28)$t$),
  ($t$Tackapausha Museum$t$, 40.6678592::double precision, -73.4833816::double precision, $t$Named for Tackapausha, the 17th-century sachem who spoke for western Long Island's Native peoples in land dealings with Dutch and English settlers for more than fifty years, this was the first preserve Nassau County set aside, in 1938.$t$, $t$https://en.wikipedia.org/wiki/Tackapausha$t$, $t$#502 rescue row — Queens-Nassau part 1 (2026-10-28)$t$),
  ($t$Jones Beach Energy & Nature Center$t$, 40.5848286::double precision, -73.5604196::double precision, $t$Opened in 2020 on the foundations of a 1960s bathhouse, this 330-foot building is raised off the sand to ride out storms, and the native dune planting around it covers 12 acres of former parking lot that was ground into rubble for its base.$t$, $t$https://narchitects.com/work/jones-beach/$t$, $t$#502 rescue row — Queens-Nassau part 1 (2026-10-28)$t$),
  ($t$General Elijah Ward Memorial Horse Trough$t$, 40.8032998::double precision, -73.6464902::double precision, $t$After Congressman Elijah Ward died in Roslyn in 1882, his widow gave this horse trough in his memory; after her own death in 1893, their children built the nearby clock tower in hers.$t$, $t$https://en.wikipedia.org/wiki/Elijah_Ward$t$, $t$#502 rescue row — Queens-Nassau part 1 (2026-10-28)$t$),
  ($t$Cannon from Spanish Sloop "Jorge Juan"$t$, 40.7998385::double precision, -73.6504225::double precision, $t$This gun came off the Spanish sloop Jorge Juan, sunk off Cuba by the USS Wasp and three other American warships in 1898; the Wasp's commander, Aaron Ward, later set it on the lawn of his Roslyn estate, Willowmere.$t$, $t$https://www.roslynlandmarks.org/news/roslyn-times-december-23-2022-roslyn-approves-cannon-restoration-by-scouts$t$, $t$#502 rescue row — Queens-Nassau part 1 (2026-10-28)$t$),
  ($t$Lauder Museum$t$, 40.6769324::double precision, -73.417581::double precision, $t$Built in 1909 for the Bank of Amityville, this building has housed the Amityville Historical Society's Lauder Museum since 1972.$t$, $t$https://en.wikipedia.org/wiki/Amityville,_New_York$t$, $t$#502 rescue row — Queens-Nassau part 1 (2026-10-28)$t$),
  ($t$Shu Swamp Preserve$t$, 40.8784729::double precision, -73.5665203::double precision, $t$Fed by Beaver Brook, this 59-acre preserve protects one of the last intact red maple and black gum swamps on Long Island, where some of the tulip trees and beeches are centuries old.$t$, $t$https://www.ebsco.com/research-starters/environmental-sciences/shu-swamp$t$, $t$#502 rescue row — Queens-Nassau part 1 (2026-10-28)$t$)
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
