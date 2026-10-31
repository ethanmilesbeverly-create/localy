-- 447_hidden_curated.sql — #447 San Antonio story batch, part 2a: curated rows for 4 HIDDEN storyless OSM pins (handoff §6
-- story-lines (y)). A curated row under the pin's EXACT stored name at its stored coordinate brings the pin back with its
-- story; a seed line would plant a twin beside it. Batch file — run in the same Mac session as the batch's names files, then
-- curated_category_backfill(true); every row should report dist_m 0.
-- Each pin passed #542 (its containing tile, by Math.round, stores it), checked by pin id across every stored row, 2026-10-30.
-- Every fact in every story was matched to its source article's text before this file was written.
-- Mission San Juan Capistrano has two OSM ways of that name ~380 m apart; the row sits on osm_way130922318, the one at the
-- mission (39 m from the article's coordinate).
with v(name, lat, lng, description, source_url, note) as (values
  ($t$Mission San Francisco de la Espada Dam, Ditch and Aqueduct$t$, 29.3329::double precision, -98.46159::double precision, $t$Franciscan friars built this 1731 irrigation system for Mission Espada, carrying its ditch over Piedras Creek on a stone aqueduct; the acequia still waters the old mission farmlands and is a National Historic Landmark.$t$, $t$https://en.wikipedia.org/wiki/Espada_Acequia$t$, $t$#447 hidden-pin row: osm_node12395077363, stored in 587_-1969, 587_-1970; containing tile 587_-1969 stores it (#542)$t$),
  ($t$Hangar Nine$t$, 29.34402::double precision, -98.444::double precision, $t$Built in 1918 as one of sixteen wooden hangars at Brooks Field, this is the oldest Air Force aircraft storage and repair building and one of the only World War I hangars left in the country; it became a National Historic Landmark in 1976.$t$, $t$https://en.wikipedia.org/wiki/Hangar_9,_Brooks_Air_Force_Base$t$, $t$#447 hidden-pin row: osm_node12395077341, stored in 587_-1969; containing tile 587_-1969 stores it (#542)$t$),
  ($t$Mission San Juan Capistrano$t$, 29.3328186::double precision, -98.4548968::double precision, $t$Franciscans refounded this mission in 1731 on the east bank of the San Antonio River; a larger church begun around 1760 was never finished for want of workers, and with too little land for big crops or herds, San Juan never prospered like its sister missions.$t$, $t$https://en.wikipedia.org/wiki/Mission_San_Juan_Capistrano_(Texas)$t$, $t$#447 hidden-pin row: osm_way130922318, stored in 587_-1969; containing tile 587_-1969 stores it (#542)$t$),
  ($t$La Villita$t$, 29.4217177::double precision, -98.4888274::double precision, $t$One of San Antonio's first neighbourhoods, on the south bank of the river, La Villita was restored in 1939 under Mayor Maury Maverick with the National Youth Administration and is now an arts village of galleries and shops beside the River Walk.$t$, $t$https://en.wikipedia.org/wiki/La_Villita$t$, $t$#447 hidden-pin row: osm_way78486005, stored in 588_-1970, 589_-1970; containing tile 588_-1970 stores it (#542)$t$)
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
