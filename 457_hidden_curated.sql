-- 457_hidden_curated.sql — #457 Columbus story batch: 4 HIDDEN storyless OSM pins brought back with a story (drafted 2026-11-05).
-- Same shape and rules as 454_hidden_curated.sql: exact stored name at the stored coordinate, read from the stored places:v34
-- rows on 2026-11-05; all four pass #542 by pin id (the containing tile stores each). Three come from the list sort (CB042,
-- CB055, CB082 — CURATED ROW verdicts); one from reading part 1 (CB165: the hidden pin "Station 67" is the Toledo and Ohio
-- Central Railroad Station, 9 m from the article's point). Later parts add _2 files. Batch file — run in the Mac session
-- after the seed commit, then curated_category_backfill(true). Expect 4 returned names; "Success. No rows returned" means the
-- guard skipped (already run — FROM RIVERSIDE (7)).
with v(name, lat, lng, description, source_url, note) as (values
  ($t$Station 67$t$, 39.9606049::double precision, -83.0106341::double precision, $t$Built by the Toledo and Ohio Central Railroad in 1895–1896, this station served passengers until 1930, sheltered Volunteers of America from 1931 to 2003, and is now a union meeting space and event hall.$t$, $t$https://en.wikipedia.org/wiki/Toledo_and_Ohio_Central_Railroad_Station$t$, $t$#457 hidden-pin row: osm_way169456061, stored in 799_-1660, 799_-1661; containing tile 799_-1660 stores it (#542)$t$),
  ($t$Central Ohio Fire Museum$t$, 39.9681908::double precision, -82.996956::double precision, $t$This firefighting museum fills the former Engine House No. 16, built in 1908 to plans by department architect A. C. Burley.$t$, $t$https://en.wikipedia.org/wiki/Central_Ohio_Fire_Museum$t$, $t$#457 hidden-pin row: osm_way638035970, stored in 799_-1660, 800_-1660; containing tile 799_-1660 stores it (#542)$t$),
  ($t$German Village$t$, 39.9458811::double precision, -82.9925654::double precision, $t$German immigrants, at one time as much as a third of Columbus's population, settled this neighborhood in the 19th century; in 1974 it became the National Register's largest privately funded preservation district.$t$, $t$https://en.wikipedia.org/wiki/German_Village$t$, $t$#457 hidden-pin row: osm_way559723213, stored in 799_-1659, 799_-1660; containing tile 799_-1660 stores it (#542)$t$),
  ($t$Jefferson Avenue Historic District$t$, 39.96562::double precision, -82.9846269::double precision, $t$One of the few residential neighborhoods left downtown, this district of about 12 buildings includes James Thurber's former home and the Columbus Landmarks Foundation's headquarters.$t$, $t$https://en.wikipedia.org/wiki/Jefferson_Avenue_Historic_District_(Columbus,_Ohio)$t$, $t$#457 hidden-pin row: osm_node357470681, stored in 799_-1659, 799_-1660, 800_-1660; containing tile 799_-1660 stores it (#542)$t$)
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
