-- 501_hidden_curated_3.sql — #501 Middlesex-Union part 2: a curated row for one HIDDEN storyless OSM pin (handoff §6 story-lines (y)).
-- seed-resolve.ts cannot see a hidden pin, so a story line would plant a second pin beside it; a curated row under the pin's
-- EXACT name at its stored coordinate brings the pin back with its story instead.
-- Checks done (2026-10-28): the pin's name and coordinate as stored in places:v34:810_-1486 (osm_way1497713236, desc "A local
-- landmark (building)."); absent from the served answer of tiles 810_-1485 (19 pins) and 810_-1486 (18 pins), both under the
-- ~20 cap, so it is hidden (FROM MIDDLESEX-UNION (3)); no other "Surveyor"/"Proprietors" pin among the box's 1,237 stored
-- pins (CURATED_MATCH_M); no Wikipedia article for the building, so the serve path cannot resolve it and no wiki twin is
-- served; the nearest served pins are other things (Perth Amboy City Hall and the Kearny Cottage wiki pin 47 m, the George
-- Washington statue 48–59 m). HMdb markers m76796, m208979 and m208975 stand at the building (0–15 m).
--
-- RUN: the SQL editor, this whole file in its own tab, AFTER the names-501-middlesex-union-2.txt commit (no line sits near this
-- pin — the Fireman's Triangle is 82 m off — but keep the habit). Re-runnable: skipped when a same-name curated row sits
-- within 50 m. Expect 1 row returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect Surveyor General's Office among the rows, dist_m 0.
-- BACK-OUT: delete from public.curated_descriptions where note = '#501 hidden-pin row — Middlesex-Union part 2 (2026-10-28)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Surveyor General's Office$t$, 40.5065405::double precision, -74.265275::double precision, $t$Built in 1852–54 as the headquarters of the Board of Proprietors of East New Jersey — the land company, founded in 1684, that held and sold off the colony's original land grants — and the office of its Surveyor General.$t$, $t$https://www.hmdb.org/m.asp?m=208979$t$, $t$#501 hidden-pin row — Middlesex-Union part 2 (2026-10-28)$t$)
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
