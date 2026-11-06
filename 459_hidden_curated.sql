-- 459_hidden_curated.sql — #459 Cleveland story batch: 2 HIDDEN storyless OSM pins brought back with a story (drafted 2026-11-05).
-- Same shape and rules as 457_hidden_curated.sql: exact stored name at the stored coordinate, read from the stored places:v34
-- rows on 2026-11-05; both pass #542 by pin id (the containing tile stores each), both read hidden in a live serve of their
-- tiles the same day, and neither has a same-name pin within 2 km or a same-article Wikipedia pin within 300 m (story-lines
-- (y)). Both come from the list sort's CURATED ROW verdicts:
--   CV041 Cleveland East Pierhead Light — no Wikipedia article; written from Lighthouse Friends' page for the light. Its twin
--     across the harbour mouth, the West Pierhead Light ("Cleveland Harbor Main Entrance Light", osm_way414659280), is
--     served with its article, so the pair reads alike on the map; the tower is seen from shore, not walked to.
--   CV167 Miles Park — the sort flagged CHECK SUBJECT (pin "Miles Park" vs list "Miles Park Historic District"); the row
--     is the PARK's own story, from the *Union–Miles Park* article (the district has no article), not the district's.
-- Batch file — run in the Mac session after the seed commit, then curated_category_backfill(true). Expect 2 returned names,
-- first "Cleveland East Pierhead Light"; "Success. No rows returned" means the guard skipped (already run — FROM RIVERSIDE (7)).
with v(name, lat, lng, description, source_url, note) as (values
  ($t$Cleveland East Pierhead Light$t$, 41.5102005::double precision, -81.7154659::double precision, $t$Standing on the east breakwater pierhead since 1911, this white twenty-five-foot iron tower with a black lantern room is the light boats pass as they enter Cleveland Harbor.$t$, $t$https://lighthousefriends.com/light.asp?ID=283$t$, $t$#459 hidden-pin row: osm_way414659021, stored in 830_-1634, 830_-1635; containing tile 830_-1634 stores it (#542)$t$),
  ($t$Miles Park$t$, 41.4468445::double precision, -81.6228439::double precision, $t$Originally the town square of Newburgh Village, this green was land Theodore Miles gave for a village square in 1850, and it was named Miles Park in his honor in 1877.$t$, $t$https://en.wikipedia.org/wiki/Union%E2%80%93Miles_Park$t$, $t$#459 hidden-pin row: osm_way467671728, stored in 829_-1632, 829_-1633; containing tile 829_-1632 stores it (#542)$t$)
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
