-- 519_chicago_curated.sql — #519 shape (a), Chicago: 17 curated rows (12 places; Lakefront Trail ×6)
--
-- WHY SQL, NOT seed-resolve.ts: the tool's duplicate check reads the SERVED map, and the served map hides storyless
-- OSM pins (#367) — so these hidden pins were invisible to it and every line fell back to seeding a NEW pin
-- (dry run 2026-10-22: 13 new-seed, 4 review, 0 attached). A curated row named exactly as the hidden pin, within
-- 2 km (CURATED_MATCH_M), un-hides it at serve time (#362/#419) — no seed, no new pin, no tile write.
--
-- Each row: the hidden OSM pin's exact name and coordinate, from the 48 Chicago roster tiles' places:v34 rows
-- (2026-10-21). One sentence in our own words; the Wikipedia article travels as source_url. Lakefront Trail: six
-- rows cover all 42 hidden segments (farthest 1.7 km from its row). Eleven of the 10-20 measurement's 23 places
-- are left out on purpose — they still serve through a same-article Wikipedia pin 0–133 m away (see #519).
--
-- RUN: the SQL editor, this whole file in its own tab. Re-runnable: a row is skipped when a same-name curated row
-- already sits within 50 m (the seed-resolve.ts rule). Expect 17 rows returned on the first run, 0 on a re-run.
-- THEN: select category, count(*) from public.curated_category_backfill(true) group by 1;   (#495)
-- BACK-OUT: delete from public.curated_descriptions where note = '#519 rescue line — Chicago (2026-10-22)';

with v(name, lat, lng, description, source_url) as (values
  ($t$Dialogo$t$, 41.789051::double precision, -87.598162::double precision, $t$Virginio Ferrari's 1971 abstract sculpture outside Pick Hall is known for its midday shadow, which looks like a hammer and sickle and draws onlookers every year, though the artist says he never meant it to.$t$, $t$https://en.wikipedia.org/wiki/Dialogo_(sculpture)$t$),
  ($t$Torch Song$t$, 41.786842::double precision, -87.585355::double precision, $t$Alison Saar's bronze in the Obama Presidential Center's Women's Garden recasts the Statue of Liberty as a woman raising a gilded flame, with a nod to Chicago's blues tradition.$t$, $t$https://en.wikipedia.org/wiki/Torch_Song_(sculpture)$t$),
  ($t$Gráinne$t$, 41.879453::double precision, -87.643794::double precision, $t$A gift from Galway, Ireland, Maurice Harron's statue was dedicated here in 2007 by the mayors of both cities to mark Chicago's long ties with Ireland.$t$, $t$https://en.wikipedia.org/wiki/Grainne_(sculpture)$t$),
  ($t$Olmec Head$t$, 41.867151::double precision, -87.615721::double precision, $t$This 7-foot head beside the Field Museum's north entrance copies one of the colossal Olmec heads found at San Lorenzo, and was given to Chicago by the Mexican state of Veracruz in 2003.$t$, $t$https://en.wikipedia.org/wiki/Olmec_Head,_Number_8$t$),
  ($t$William Shakespeare Monument$t$, 41.923824::double precision, -87.636214::double precision, $t$William Ordway Partridge's bronze of Shakespeare holding a book was made in 1893 and has stood in Lincoln Park since 1894.$t$, $t$https://en.wikipedia.org/wiki/Statue_of_William_Shakespeare_(Chicago)$t$),
  ($t$Tomáš Garrigue Masaryk Memorial$t$, 41.786945::double precision, -87.590154::double precision, $t$Albin Polasek's monument to Czechoslovakia's founding president shows a Blaník knight on horseback; made in 1949, it was raised on the Midway in 1955.$t$, $t$https://en.wikipedia.org/wiki/Thomas_Garrigue_Masaryk_Monument$t$),
  ($t$Camp Douglas$t$, 41.835156::double precision, -87.617657::double precision, $t$Near here stood Camp Douglas, a Union training ground that became one of the North's largest Civil War prison camps for Confederates; more than 4,000 of its dead were later moved to a mass grave at Oak Woods Cemetery.$t$, $t$https://en.wikipedia.org/wiki/Camp_Douglas_(Chicago)$t$),
  ($t$Gold Star Families Memorial$t$, 41.862440::double precision, -87.614104::double precision, $t$Dedicated in 2006 just east of Soldier Field, this memorial honors 585 Chicago police officers who died in the line of duty and is tended by the department's honor guard.$t$, $t$https://en.wikipedia.org/wiki/Gold_Star_Families_Memorial_and_Park$t$),
  ($t$Jane M. Byrne Plaza$t$, 41.8971705::double precision, -87.624553::double precision, $t$The green beside the Water Tower was called Water Tower Park until 2014, when it was renamed for Jane Byrne, Chicago's first woman mayor.$t$, $t$https://en.wikipedia.org/wiki/Jane_Byrne_Park$t$),
  ($t$Skating Ribbon$t$, 41.883750::double precision, -87.618767::double precision, $t$Opened in December 2014, this quarter-mile ribbon of ice climbs and dips as it loops through Maggie Daley Park, holds up to 700 skaters, and turns into a walking and roller path in summer.$t$, $t$https://en.wikipedia.org/wiki/Maggie_Daley_Skating_Ribbon$t$),
  ($t$SkyDeck Chicago Willis Tower$t$, 41.878505::double precision, -87.635887::double precision, $t$The 103rd-floor deck of the former Sears Tower, the world's tallest building when it opened in 1973, has taken visitors since June 1974 and is the highest observation deck in the United States.$t$, $t$https://en.wikipedia.org/wiki/Willis_Tower$t$),
  ($t$Lakefront Trail$t$, 41.787885::double precision, -87.577649::double precision, $t$This path runs about 18.5 miles along Lake Michigan through Jackson, Burnham, Grant and Lincoln parks, and on busy summer days some 70,000 people walk, run or ride it.$t$, $t$https://en.wikipedia.org/wiki/Chicago_Lakefront_Trail$t$),
  ($t$Lakefront Trail$t$, 41.860188::double precision, -87.612587::double precision, $t$This path runs about 18.5 miles along Lake Michigan through Jackson, Burnham, Grant and Lincoln parks, and on busy summer days some 70,000 people walk, run or ride it.$t$, $t$https://en.wikipedia.org/wiki/Chicago_Lakefront_Trail$t$),
  ($t$Lakefront Trail$t$, 41.883801::double precision, -87.612816::double precision, $t$This path runs about 18.5 miles along Lake Michigan through Jackson, Burnham, Grant and Lincoln parks, and on busy summer days some 70,000 people walk, run or ride it.$t$, $t$https://en.wikipedia.org/wiki/Chicago_Lakefront_Trail$t$),
  ($t$Lakefront Trail$t$, 41.934018::double precision, -87.631726::double precision, $t$This path runs about 18.5 miles along Lake Michigan through Jackson, Burnham, Grant and Lincoln parks, and on busy summer days some 70,000 people walk, run or ride it.$t$, $t$https://en.wikipedia.org/wiki/Chicago_Lakefront_Trail$t$),
  ($t$Lakefront Trail$t$, 41.962740::double precision, -87.643995::double precision, $t$This path runs about 18.5 miles along Lake Michigan through Jackson, Burnham, Grant and Lincoln parks, and on busy summer days some 70,000 people walk, run or ride it.$t$, $t$https://en.wikipedia.org/wiki/Chicago_Lakefront_Trail$t$),
  ($t$Lakefront Trail$t$, 41.987403::double precision, -87.654386::double precision, $t$This path runs about 18.5 miles along Lake Michigan through Jackson, Burnham, Grant and Lincoln parks, and on busy summer days some 70,000 people walk, run or ride it.$t$, $t$https://en.wikipedia.org/wiki/Chicago_Lakefront_Trail$t$)
)
insert into public.curated_descriptions (name, lat, lng, description, source_url, note)
select v.name, v.lat, v.lng, v.description, v.source_url, '#519 rescue line — Chicago (2026-10-22)'
from v
where not exists (
  select 1 from public.curated_descriptions d
  where d.name_clean = regexp_replace(lower(v.name), '[^a-z0-9]', '', 'g')
    and 6371000 * sqrt(
          power(radians(d.lat - v.lat), 2) +
          power(cos(radians((d.lat + v.lat) / 2)) * radians(d.lng - v.lng), 2)) <= 50
)
returning name, lat, lng;
