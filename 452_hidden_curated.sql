-- 452_hidden_curated.sql — #452 Riverside story batch: 7 HIDDEN storyless OSM pins brought back with a story (drafted 2026-11-03).
-- Same shape and rules as 450_hidden_curated.sql: exact stored name at the stored coordinate, read from the stored places:v34
-- rows; every pin passed #542 by pin id (its containing tile stores it). Five come from the list sort (RV016 Galleano Winery,
-- RV040 Trujillo Adobe, RV072 De Anza Crossing, RV075 Site of the Third Serrano Adobe, RV076 Agua Mansa Pioneer Cemetery); two
-- from reading: RV001's building IS the Sherman Indian Museum pin (11 m), and the Serrano Tanning Vats plaque (CHL 186) stands
-- 12 m from the Third Serrano Adobe's. A third plaque pin on that lot, "Tanning Vats" (osm_node911594447, a 1962 Scouts
-- plaque for the same vats), stays hidden — one story per subject. Part 2's rescues (gate drops, leads) go in
-- 452_hidden_curated_2.sql. Batch file — run in the Mac session after the seed commit, then curated_category_backfill(true);
-- each row should report dist_m 0.
with v(name, lat, lng, description, source_url, note) as (values
  ($t$Galleano Winery$t$, 34.0110485::double precision, -117.5419259::double precision, $t$Riverside County's oldest winery: Domenico Galleano, a winegrower from Italy, bought this ranch in 1927 from Col. Esteban Cantu, a former governor of Baja California, along with its 1890s house, and founded the winery in 1933 after Prohibition's repeal; the early-1900s barn is one of the last local examples of a barn raising.$t$, $t$https://www.hmdb.org/m.asp?m=50714$t$, $t$#452 hidden-pin row: osm_node995776093, stored in 680_-2350, 680_-2351; containing tile 680_-2351 stores it (#542)$t$),
  ($t$Trujillo Adobe$t$, 34.0191774::double precision, -117.350111::double precision, $t$Inside the building here stand the remaining walls of the Trujillo Adobe, center of La Placita de los Trujillos, a Hispanic village founded in the 1860s by families Lorenzo Trujillo had inspired to come to California in the 1840s; many of them settled here after the disastrous flood of 1862, and their descendants still call the area home.$t$, $t$https://www.hmdb.org/m.asp?m=143382$t$, $t$#452 hidden-pin row: osm_way694156921, stored in 680_-2347, 681_-2347; containing tile 680_-2347 stores it (#542)$t$),
  ($t$De Anza Crossing$t$, 33.9758722::double precision, -117.4413649::double precision, $t$On January 1, 1776, the first party of colonists to come overland to the Pacific Coast, 242 men, women and children recruited in Sonora and led by Juan Bautista de Anza, crossed the Santa Ana River just south of here and camped between this spot and the river, on their way north to found San Francisco.$t$, $t$https://www.hmdb.org/m.asp?m=50995$t$, $t$#452 hidden-pin row: osm_node997055831, stored in 679_-2349, 680_-2349; containing tile 680_-2349 stores it (#542)$t$),
  ($t$Site of the Third Serrano Adobe$t$, 33.7779::double precision, -117.4861756::double precision, $t$Nearby stood the adobe, built about 1867, where Leandro Serrano's widow Josefa lived until 1898; under Spanish law she owned the surrounding 20,000-acre Rancho Temescal, but the US Supreme Court denied her ownership.$t$, $t$https://www.hmdb.org/m.asp?m=50645$t$, $t$#452 hidden-pin row: osm_node911594368, stored in 676_-2349, 676_-2350; containing tile 676_-2350 stores it (#542)$t$),
  ($t$Serrano Tanning Vats$t$, 33.7780079::double precision, -117.4861458::double precision, $t$Luiseño Indians built these two vats in 1819 under the direction of Leandro Serrano, the first non-Indian settler in what is now Riverside County, to make leather from cowhides; they were restored and placed here in 1981.$t$, $t$https://www.hmdb.org/m.asp?m=50643$t$, $t$#452 hidden-pin row: osm_node911594346, stored in 676_-2349, 676_-2350; containing tile 676_-2350 stores it (#542)$t$),
  ($t$Agua Mansa Pioneer Cemetery$t$, 34.0416201::double precision, -117.3644635::double precision, $t$This cemetery is all that remains of Agua Mansa, founded in the 1840s by colonists from New Mexico and once the largest settlement in San Bernardino County; the 1862 flood swept away many of its adobes, and the bell of its 1853 San Salvador church now hangs at the Mission Inn.$t$, $t$https://en.wikipedia.org/wiki/Agua_Mansa,_California$t$, $t$#452 hidden-pin row: osm_way33225944, stored in 681_-2347, 681_-2348; containing tile 681_-2347 stores it (#542)$t$),
  ($t$Sherman Indian Museum$t$, 33.9250601::double precision, -117.4373829::double precision, $t$The museum fills the last of Sherman Institute's original buildings, its 1901 Mission-style administration building, from a federal school for American Indian students named for Congressman James Schoolcraft Sherman, who pushed through the funding to build it.$t$, $t$https://www.hmdb.org/m.asp?m=249929$t$, $t$#452 hidden-pin row: osm_node14129783839, stored in 678_-2349, 679_-2349; containing tile 679_-2349 stores it (#542)$t$)
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
