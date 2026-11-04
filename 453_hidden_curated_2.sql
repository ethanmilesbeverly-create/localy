-- 453_hidden_curated_2.sql — #453 Orlando story batch, part 3: 1 HIDDEN storyless OSM pin brought back with a story (drafted 2026-11-04).
-- Dickson Azalea Park (osm_way69539601), from state marker 837 (the park and its Washington Street Bridge). Same shape, rules and
-- checks as 453_hidden_curated.sql: exact stored name at the stored coordinate; #542 passed by pin id; no same-name pin or gem
-- within 2 km. Run it in the Mac session AFTER 453_hidden_curated.sql; expect 1 returned name.
with v(name, lat, lng, description, source_url, note) as (values
  ($t$Dickson Azalea Park$t$, 28.5443397::double precision, -81.3584972::double precision, $t$State Senator Walter Rose set aside this Fern Creek ravine as a park and deeded it to the city in 1924; renamed in 1933 for Colonel Henry Hill Dickson, who planted azaleas across Orlando, it was rebuilt from 1935 to Mulford Foster's design with walls and steps built by the Works Progress Administration, and the 1926 Washington Street Bridge, carried over the creek on three 20-foot concrete arches, is the only bridge of its kind in the city.$t$, $t$https://markers.flheritage.com/home/details/837$t$, $t$#453 hidden-pin row: osm_way69539601, stored in 571_-1627, 571_-1628; containing tile 571_-1627 stores it (#542)$t$)
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
