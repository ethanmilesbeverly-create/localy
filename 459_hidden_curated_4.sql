-- 459_hidden_curated_4.sql — #459 Cleveland story batch, part 5: 2 HIDDEN storyless OSM pins brought back with the story of the
-- Ohio Historical Marker that stands at each (drafted 2026-11-06). Same shape and rules as 459_hidden_curated.sql: exact stored
-- name at the stored coordinate, read from a fresh stored places:v34 read of all 51 stored tiles (48 box + ring) on 2026-11-06;
-- both pass #542 by pin id (the containing tile stores it), neither is served in a live serve of its tiles the same day, and
-- neither has a same-name pin within 2 km or a same-name line in parts 1–5. Sources: Remarkable Ohio (156-18; the Lakewood Park
-- marker); every number and capitalised name checked against its source text (checker re-proven on 1917 / "Russel").
-- Batch file — run in the Mac session after the seed commit and after 459_hidden_curated.sql, _2.sql and _3.sql, then
-- curated_category_backfill(true). Expect 2 returned names, first "African American Cultural Garden"; "Success. No rows returned"
-- means the guard skipped (already run — FROM RIVERSIDE (7)).
with v(name, lat, lng, description, source_url, note) as (values
  ($t$African American Cultural Garden$t$, 41.5300436::double precision, -81.6294721::double precision, $t$As its state marker records, winning this garden was a Civil Rights era struggle for equitable access to public space in Cleveland.$t$, $t$https://remarkableohio.org/marker/156-18-the-african-american-cultural-garden/$t$, $t$#459 hidden-pin row: osm_node8567373858, stored in 830_-1632, 830_-1633, 831_-1632, 831_-1633; containing tile 831_-1633 stores it (#542)$t$),
  ($t$Lakewood Park$t$, 41.4952809::double precision, -81.7969511::double precision, $t$Robert Russell Rhodes built his summer cottage, The Hickories, on this land in 1881; the park's changing use traces Lakewood's growth from a small farming community to a modern suburb, and the stone wall engraved with the estate's name is all that remains of it.$t$, $t$https://remarkableohio.org/?p=4379$t$, $t$#459 hidden-pin row: osm_way108244779, stored in 830_-1635, 830_-1636; containing tile 830_-1636 stores it (#542)$t$)
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
