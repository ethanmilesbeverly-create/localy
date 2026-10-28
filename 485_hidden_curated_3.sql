-- 485_hidden_curated_3.sql — #485 Katy-Energy Corridor part 3: curated rows for 6 HIDDEN storyless OSM pins
-- (handoff §6 story-lines (y)), found by step (5)'s gate dry run (2026-10-28): its dropped lists named every storyless pin in the
-- box; these 6 are Texas Historical Commission marker plaques (OSM nodes 124036xxxxx, desc "A local memorial (plaque).") that the
-- story pass had not reached — four on the box's south edge toward Sugar Land and Richmond, one in Copperfield, and John Foster at
-- Foster High School. Names, ids and coordinates as stored in places:v34 rows 593_-1912/-1913/-1914/-1915/-1916 and 598_-1912/-1913.
-- Stories worded from each marker's text (HMdb inscription excerpts and the THC Atlas), cited per row. Oak Hill Cemetery's own plaque
-- reads only "Established 1918 · Historic Texas Cemetery 2004"; its row adds the church beside it (Oak Hill Baptist, 200 m, same road).
-- Left without rows (no marker text found): Albert and Ethel Herzstein, Johnny Nelson Katy Heritage Museum, Tri-County Marker.
--
-- RUN: the SQL editor, this whole file in its own tab. Re-runnable: skipped when a same-name curated row sits within 50 m.
-- Expect 6 rows returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect these 6 names among the rows, dist_m 0. Re-check the map after 5 minutes (CURATED_INDEX_TTL_MS).
-- BACK-OUT: delete from public.curated_descriptions where note = '#485 hidden-pin row — Katy-Energy Corridor part 3 (2026-10-28)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Oak Hill Baptist Church$t$, 29.66567::double precision, -95.75586::double precision, $t$In 1915 eighteen African American residents, former members of Richmond's Pleasant Green Baptist Church, met under the Rev. A.C. Ray, built a brush arbor on the oak-covered hill here and started a congregation of their own.$t$, $t$https://www.hmdb.org/m.asp?m=225485$t$, $t$#485 hidden-pin row — Katy-Energy Corridor part 3 (2026-10-28)$t$),
  ($t$Oak Hill Cemetery$t$, 29.66669::double precision, -95.75393::double precision, $t$Established in 1918 beside Oak Hill Baptist Church, the African American congregation that began under a brush arbor on this hill in 1915, the cemetery was designated a Historic Texas Cemetery in 2004.$t$, $t$https://www.hmdb.org/m.asp?m=225488$t$, $t$#485 hidden-pin row — Katy-Energy Corridor part 3 (2026-10-28)$t$),
  ($t$Hodge's Bend Cemetery$t$, 29.64069::double precision, -95.66247::double precision, $t$Alexander Hodge, who had fought in "Swamp Fox" Francis Marion's brigade in the American Revolution, brought his family to Texas in 1825 as one of Austin's "Old Three Hundred"; his sons fought in the Texas Revolution, and his 1828 grant, Hodge's Bend, held this burial ground.$t$, $t$https://www.hmdb.org/m.asp?m=27747$t$, $t$#485 hidden-pin row — Katy-Energy Corridor part 3 (2026-10-28)$t$),
  ($t$Sugar Land First United Methodist Church$t$, 29.62895::double precision, -95.61884::double precision, $t$Methodists in Sugar Land met informally from 1910 under the Rev. C.C. Miller, with no full-time minister; in 1918 the Imperial Sugar Company gave Church Park, a parcel between Main and Wood streets, for the Methodist, Presbyterian, Baptist and Catholic congregations to build on.$t$, $t$https://www.hmdb.org/m.asp?m=202062$t$, $t$#485 hidden-pin row — Katy-Energy Corridor part 3 (2026-10-28)$t$),
  ($t$Heritage Presbyterian Church$t$, 29.89311::double precision, -95.63944::double precision, $t$Built in 1916 near the banks of Little Cypress Creek, 11 miles north-west, this chapel served St. John Lutheran Church; Windwood Presbyterian later bought it and moved it to Grant Road, and Heritage Presbyterian Church brought it here in 1980.$t$, $t$https://www.hmdb.org/m.asp?m=241807$t$, $t$#485 hidden-pin row — Katy-Energy Corridor part 3 (2026-10-28)$t$),
  ($t$John Foster$t$, 29.62724::double precision, -95.81115::double precision, $t$Born in South Carolina in 1757, John Foster founded the town of Washington in the Mississippi Territory and helped start Jefferson College there; in 1822 he joined his son Randolph in Texas as one of Austin's "Old Three Hundred," and on Christmas Day 1835 he signed the Columbia Resolutions urging independence from Mexico.$t$, $t$https://www.hmdb.org/m.asp?m=156722$t$, $t$#485 hidden-pin row — Katy-Energy Corridor part 3 (2026-10-28)$t$)
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
