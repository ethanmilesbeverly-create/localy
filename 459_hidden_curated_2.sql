-- 459_hidden_curated_2.sql — #459 Cleveland story batch: 1 HIDDEN storyless OSM pin brought back with a story (drafted 2026-11-05).
-- Same shape and rules as 459_hidden_curated.sql: exact stored name at the stored coordinate, read from the stored places:v34
-- rows on 2026-11-05; passes #542 by pin id (containing tile 830_-1636 stores it); not in a live serve of 830_-1636 or
-- 830_-1635 the same day (10 and 17 pins served), and no same-name pin within 2 km or same-article Wikipedia pin within
-- 300 m (no article) (story-lines (y)). From part 3h's sort row CV353 John Honam House (the list's name for the house):
--   Old Stone House Museum — the Lakewood Historical Society's museum in Lakewood Park, the house Honam built in 1834 on
--     Detroit Avenue; written from Cleveland Historical item 222.
-- Batch file — run in the Mac session after the seed commit and after 459_hidden_curated.sql, then
-- curated_category_backfill(true). Expect 1 returned name, "Old Stone House Museum"; "Success. No rows returned" means the
-- guard skipped (already run — FROM RIVERSIDE (7)).
with v(name, lat, lng, description, source_url, note) as (values
  ($t$Old Stone House Museum$t$, 41.4934147::double precision, -81.7984995::double precision, $t$John Honam built this house in 1834 on the north side of Detroit Avenue; Butler had it moved to Lakewood Park, onto land once part of Honam's 97-acre estate, and founded the Lakewood Historical Society.$t$, $t$https://clevelandhistorical.org/items/show/222$t$, $t$#459 hidden-pin row: osm_node1181067423, stored in 830_-1635, 830_-1636; containing tile 830_-1636 stores it (#542)$t$)
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
