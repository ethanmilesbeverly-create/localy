-- 454_hidden_curated.sql — #454 Charlotte story batch: 2 HIDDEN storyless OSM pins brought back with a story (drafted 2026-11-04).
-- Same shape and rules as 453_hidden_curated.sql: exact stored name at the stored coordinate, read from the stored places:v34
-- rows on 2026-11-04; both pins pass #542 by pin id (the containing tile stores each); no same-name pin or gem within 2 km
-- (#519 (1)); no same-article Wikipedia pin within 300 m. One comes from the list sort (CL022: the Ervin Building, listed
-- 2023, carries the mural the hidden pin names; the building has no article and no stored pin of its own); one from the
-- graves read (Bonnie Ethel Cone is interred in the Van Landingham Glen at UNC Charlotte, where the hidden pin "Bonnie Cone
-- Memorial" stands — a curated row on it instead of a twin "Grave of" pin; 454_hand_add_graves.sql's header says so).
-- Part 2's union read adds a second file. Batch file — run in the Mac session after the seed commit, then
-- curated_category_backfill(true). Expect 2 returned names; "Success. No rows returned" means the guard skipped (already
-- run — FROM RIVERSIDE (7)).
with v(name, lat, lng, description, source_url, note) as (values
  ($t$Ervin Building murals$t$, 35.200382::double precision, -80.7716206::double precision, $t$Artists Eva Crawford and Hillary Siber painted this 30-foot-tall, 5,500-square-foot mural on the Ervin Building in 2022, fitting 50 years of Charlotte history onto one wall while the tower was being renovated.$t$, $t$https://qclife.wbtv.com/2022/07/15/30-foot-mural-tells-50-years-charlotte-history/$t$, $t$#454 hidden-pin row: osm_node13721278157, stored in 704_-1615; containing tile 704_-1615 stores it (#542)$t$),
  ($t$Bonnie Cone Memorial$t$, 35.3063562::double precision, -80.7279858::double precision, $t$Bonnie Ethel Cone, the Central High teacher who ran Charlotte's 1946 university extension center, kept it alive as Charlotte College, chose this campus site in 1957 and saw the school become the University of North Carolina at Charlotte in 1965, is buried in the Van Landingham Glen, where this memorial stands.$t$, $t$https://en.wikipedia.org/wiki/Bonnie_Ethel_Cone$t$, $t$#454 hidden-pin row: osm_way169460851, stored in 706_-1614, 706_-1615; containing tile 706_-1615 stores it (#542)$t$)
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
