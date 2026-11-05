-- 457_hidden_curated_2.sql — #457 Columbus story batch part 3: 9 HIDDEN storyless OSM pins brought back with a story (drafted 2026-11-05).
-- Same shape and rules as 457_hidden_curated.sql: exact stored name at the stored coordinate, read from the stored places:v34
-- rows on 2026-11-05 and confirmed hidden by a live serve read; all nine pass #542 by pin id (the containing tile stores each).
-- Six from the sort's CURATED ROW candidates (CB056, CB128, CB217, CB229, CB248; CB212–CB214 share the one "Historic Dublin"
-- pin) and three from reading the unmapped seeds (CB196, CB233, CB300). "Dublin Arts Center" FAILS #542 and is seeded in
-- names-457-columbus-3.txt as "Eleanor A. Gelpi House" instead. Batch file — run in the Mac session after the seed commit,
-- then curated_category_backfill(true). Expect 9 returned names; "Success. No rows returned" means the guard skipped
-- (already run — FROM RIVERSIDE (7)).
with v(name, lat, lng, description, source_url, note) as (values
  ($t$Glen Echo$t$, 40.017064::double precision, -82.9993577::double precision, $t$Platted in 1909 as "Indianola Park View", this neighborhood set aside part of the Glen Echo Ravine as a park, the first such donation to the city of Columbus by a real estate developer.$t$, $t$https://en.wikipedia.org/wiki/Glen_Echo_(Columbus,_Ohio)$t$, $t$#457 hidden-pin row (CB056): osm_way556675713, stored in 800_-1660, 801_-1660; containing tile 800_-1660 stores it (#542)$t$),
  ($t$Old Beechwold Historic District$t$, 40.0607968::double precision, -83.0234242::double precision, $t$A zoo that lasted only five months in 1905 stood here before Joseph A. Jeffrey made the land his estate, Beechwalde, in 1906; the zoo's brick entrance still stands on North High Street.$t$, $t$https://en.wikipedia.org/wiki/Old_Beechwold_Historic_District$t$, $t$#457 hidden-pin row (CB128): osm_node5733734504, stored in 801_-1660, 801_-1661; containing tile 801_-1660 stores it (#542)$t$),
  ($t$Ealy House$t$, 40.0823037::double precision, -82.8197228::double precision, $t$George Ealy, whose family's sawmill made their fortune, wrote the house's construction year, 1860, in the attic in his own hand along with the names of its builders; the New Albany-Plain Township Historical Society has owned it since 2004.$t$, $t$https://en.wikipedia.org/wiki/George_and_Christina_Ealy_House$t$, $t$#457 hidden-pin row (CB217): osm_way547657216, stored in 801_-1656, 802_-1656, 802_-1657; containing tile 802_-1656 stores it (#542)$t$),
  ($t$Hanby House$t$, 40.1261722::double precision, -82.9375602::double precision, $t$In 1856 Benjamin Hanby, later the composer of "Up on the Housetop", wrote the anti-slavery ballad "Darling Nelly Gray" at this house.$t$, $t$https://en.wikipedia.org/wiki/Benjamin_Hanby$t$, $t$#457 hidden-pin row (CB229): osm_way516266412, stored in 802_-1659, 803_-1658, 803_-1659; containing tile 803_-1659 stores it (#542)$t$),
  ($t$Alexander W. Livingston House$t$, 39.9476775::double precision, -82.7956883::double precision, $t$This was the Reynoldsburg home of seed grower Alexander W. Livingston, whose first tomato breed, the Paragon, came out in 1870; the house joined the National Register in 1994.$t$, $t$https://en.wikipedia.org/wiki/Alexander_W._Livingston$t$, $t$#457 hidden-pin row (CB248): osm_way1136097126, stored in 799_-1656; containing tile 799_-1656 stores it (#542)$t$),
  ($t$Historic Dublin$t$, 40.1002333::double precision, -83.1138953::double precision, $t$On land his brothers bought for him in 1802, John Sells began surveying village lots here by 1810 with John Shields, an Irishman who named the town after his birthplace.$t$, $t$https://en.wikipedia.org/wiki/Dublin,_Ohio$t$, $t$#457 hidden-pin row (CB212–CB214): osm_node357470674, stored in 802_-1662, 802_-1663; containing tile 802_-1662 stores it (#542)$t$),
  ($t$Orange Johnson House Museum$t$, 40.0937804::double precision, -83.0175383::double precision, $t$Arora Buttles built the first part of this house in 1811; Orange and Achsa Johnson bought it in 1816, added the Federal-style front in 1819 and lived here until 1863.$t$, $t$https://www.hmdb.org/m.asp?m=12648$t$, $t$#457 hidden-pin row (CB196, Ohio marker 44-25): osm_way480968771, stored in 802_-1660, 802_-1661; containing tile 802_-1660 stores it (#542)$t$),
  ($t$Old Rectory$t$, 40.0870833::double precision, -83.0200466::double precision, $t$Built in 1845 as the rectory of St. John's Episcopal Church and moved twice since, this house now holds the Worthington Historical Society's offices, archives and Doll Museum.$t$, $t$https://www.worthingtonmemory.org/scrapbook/old-rectory-parlor$t$, $t$#457 hidden-pin row (CB300): osm_way556629342, stored in 802_-1660, 802_-1661; containing tile 802_-1660 stores it (#542)$t$),
  ($t$Ferris-Wright Earthworks$t$, 40.1122451::double precision, -83.1072449::double precision, $t$Built by the Hopewell culture, these three earthworks, two circles and a square, were explored by local farmers for years before professional excavations in 1890, 1922 and 1961.$t$, $t$https://dublinohiousa.gov/?p=11218$t$, $t$#457 hidden-pin row (CB233 Holder-Wright Works): osm_way442870759, stored in 802_-1662, 802_-1663; containing tile 802_-1662 stores it (#542)$t$)
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
