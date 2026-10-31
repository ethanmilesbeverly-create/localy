-- 447_hidden_curated_4.sql — #447 San Antonio story batch: the 2 held edge candidates that are HIDDEN storyless OSM plaque pins,
-- settled after the 14 edge tiles warmed (2026-10-31; 42 of 42). Same shape and rules as 447_hidden_curated.sql: exact stored name at
-- the stored coordinate. Both pins confirmed not served (live POST, cached tiles) and passing #542 by pin id. Sources: the Texas
-- Historical Commission markers on HMdb (m=179926, 1999; m=295010, 2014). Batch file — run in the same Mac session, then
-- curated_category_backfill(true); both rows should report dist_m 0.
with v(name, lat, lng, description, source_url, note) as (values
  ($t$Krause House/Mann's Crossing Post Office$t$, 29.30541::double precision, -98.6655::double precision, $t$Anton F. Krause and Johanna Roesler, who emigrated from Austria in 1854 and walked most of the way from the Texas coast, built a log cabin and stone kitchen here in 1876 with help from neighbors; Anton ran the Mann's Crossing post office from the house, and Texas Rangers and federal agents sometimes held prisoners in it.$t$, $t$https://www.hmdb.org/m.asp?m=179926$t$, $t$#447 hidden-pin row: osm_node12395077366, stored in 586_-1973; containing tile 586_-1973 stores it (#542)$t$),
  ($t$Locke Hill Auditorium$t$, 29.5549::double precision, -98.58643::double precision, $t$The Works Progress Administration built this limestone auditorium in 1934 on the original Locke Hill school grounds, using stone from a nearby quarry, and it stayed a community space after the school was rebuilt less than one mile away in 1976.$t$, $t$https://www.hmdb.org/m.asp?m=295010$t$, $t$#447 hidden-pin row: osm_node13971413917, stored in 591_-1971, 591_-1972; containing tile 591_-1972 stores it (#542)$t$)
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
