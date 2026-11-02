-- 450_hidden_curated.sql — #450 Sacramento story batch: 1 HIDDEN storyless OSM pin brought back with a story (drafted 2026-11-02).
-- Same shape and rules as 449_hidden_curated.sql: exact stored name at the stored coordinate, read from the stored places:v34
-- rows. McKinley Park is stored as "A local green space to wander." (filler) and is hidden in the live serve; it passed #542 by
-- pin id — its containing tile 772_-2429 stores it. The list sort (SA051) would have seeded a twin 193 m away at the article's
-- point. Part 2's rescues (gate drops, leads) go in 450_hidden_curated_2.sql. Batch file — run in the Mac session after the
-- seed commit, then curated_category_backfill(true); the row should report dist_m 0.
with v(name, lat, lng, description, source_url, note) as (values
  ($t$McKinley Park$t$, 38.5761275::double precision, -121.4616161::double precision, $t$The Sacramento Street Railway Company laid out this park in 1871 as East Park, to draw riders to its line; the city bought it in 1902 and renamed it for President William McKinley, and its rose garden dates from 1928 and its lake, Lake Keisel, once held an alligator exhibit in the 1920s.$t$, $t$https://en.wikipedia.org/wiki/McKinley_Park,_Sacramento$t$, $t$#450 hidden-pin row: osm_way25420437, stored in 771_-2429, 772_-2429, 772_-2430; containing tile 772_-2429 stores it (#542)$t$)
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
