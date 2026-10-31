-- 447_hidden_curated_2.sql — #447 San Antonio story batch, part 2b: curated rows for 4 HIDDEN storyless OSM pins, written from
-- Texas Historical Commission marker inscriptions as transcribed on HMdb. Same shape and rules as 447_hidden_curated.sql: the row
-- carries the pin's EXACT stored name at its stored coordinate. Batch file — run in the same Mac session, then
-- curated_category_backfill(true); every row should report dist_m 0.
-- Each pin passed #542 by pin id across every stored row (2026-10-30). Every fact was matched to the inscription text.
-- St. Mary's University: one hidden plaque sits between St. Louis Hall and Reinbolt Hall; its marker (THC 14981) is the
-- university's own, so the row tells the university's founding and both hall candidates fold into it.
with v(name, lat, lng, description, source_url, note) as (values
  ($t$Little Church of La Villita Historic District$t$, 29.4216642::double precision, -98.4886937::double precision, $t$Built in 1879 by German Methodists, this Gothic Revival church has lancet windows hinged with pegs carved by a Norwegian sailor named Olaf; the Episcopal diocese bought it in 1895 and the city in 1945.$t$, $t$https://www.hmdb.org/m.asp?m=61253$t$, $t$#447 hidden-pin row: osm_node356861879, stored in 588_-1970, 589_-1970; containing tile 588_-1970 stores it (#542); story from THC marker 3096$t$),
  ($t$St. Mary's University$t$, 29.45303::double precision, -98.56112::double precision, $t$Four French Marianist brothers opened the all-boys St. Mary's Institute in San Antonio on August 12, 1852, first overlooking Military Plaza; known locally as "the French School," it grew into St. Mary's University.$t$, $t$https://www.hmdb.org/m.asp?m=238300$t$, $t$#447 hidden-pin row: osm_node12395077309, stored in 589_-1971, 589_-1972; containing tile 589_-1971 stores it (#542); story from THC marker 14981$t$),
  ($t$The Argyle$t$, 29.47566::double precision, -98.47179::double precision, $t$Charles Anderson built this house in 1859 as headquarters of a 1,400-acre ranch; it was named the Argyle in 1890 after a developer's native Argyllshire, and the O'Grady family made it famous for food — its Argyle Cook Book came out in 1940.$t$, $t$https://www.hmdb.org/m.asp?m=211553$t$, $t$#447 hidden-pin row: osm_node12395077334, stored in 590_-1969, 590_-1970; containing tile 590_-1969 stores it (#542); story from THC marker 197$t$),
  ($t$Huebner-Onion Homestead$t$, 29.4942038::double precision, -98.6165295::double precision, $t$Austrian immigrant Joseph Huebner bought land here in 1858, built three limestone buildings and ran a stagecoach stop on the San Antonio–Bandera line, with a blacksmith, fresh teams and beds when the creek flooded; he was buried here in 1882.$t$, $t$https://www.hmdb.org/m.asp?m=171819$t$, $t$#447 hidden-pin row: osm_way462418463, stored in 590_-1972; containing tile 590_-1972 stores it (#542); story from THC marker 14818$t$)
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
