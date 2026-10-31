-- 447_hidden_curated_3.sql — #447 San Antonio story batch, part 2d-1: curated rows for 3 HIDDEN storyless OSM pins. Same shape
-- and rules as 447_hidden_curated.sql: the row carries the pin's EXACT stored name at its stored coordinate. Batch file — run in the
-- same Mac session, then curated_category_backfill(true); every row should report dist_m 0.
-- Each pin re-passed #542 by pin id across every stored row (2026-10-31). Sources: the Dionicio Rodriguez bridge's National Register
-- nomination (historicbridges.org copy), the City of San Antonio's Hays Street Bridge page, and the San Antonio Report (the Carver).
-- Every number and capitalised name was matched to the source text. Still owed: William J. Morrison Jr., House (no source found).
with v(name, lat, lng, description, source_url, note) as (values
  ($t$The Carver Center$t$, 29.4218045::double precision, -98.4717573::double precision, $t$Built in 1929 as the "Colored Branch" of the San Antonio Library & Auditorium — words still inscribed above its north doors — this Art Deco hall with Egyptian Revival details on its parapets hosted Ella Fitzgerald and Duke Ellington.$t$, $t$https://sanantonioreport.org/?p=97028$t$, $t$#447 hidden-pin row: osm_way78567673, stored in 588_-1969, 588_-1970, 589_-1969, 589_-1970; containing tile 588_-1969 stores it (#542)$t$),
  ($t$Dionicio Rodriguez Bridge$t$, 29.4647951::double precision, -98.4684689::double precision, $t$Dionicio Rodriguez built this 98-foot concrete footbridge around 1926 to look like rustic wood, down to bark, knotholes and insect borings — Popular Mechanics wrote in 1927 that park attendants said it even fooled the woodpeckers — and he never repeated the design.$t$, $t$https://historicbridges.org/texas/dioniciorodriguezbridge/nomination.pdf$t$, $t$#447 hidden-pin row: osm_way576102623, stored in 589_-1969; containing tile 589_-1969 stores it (#542)$t$),
  ($t$Hays Street Bridge$t$, 29.4302052::double precision, -98.4769761::double precision, $t$The Phoenix Bridge Co. built this bridge in 1881 for the Galveston, Harrisburg and San Antonio Railroad's crossing of the Nueces River west of Uvalde; the railroad later moved it here to save costs, and after it was closed as unsafe in 1982 it became a pedestrian bridge.$t$, $t$https://www.sa.gov/Directory/Departments/OHP/About/Resources/Hays-Street-Bridge$t$, $t$#447 hidden-pin row: osm_way40841573, stored in 588_-1969, 588_-1970, 589_-1969, 589_-1970; containing tile 589_-1970 stores it (#542)$t$)
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
