-- 446_hidden_curated.sql — #446 Pittsburgh story pass part 2 (b): curated rows for 2 HIDDEN storyless OSM pins
-- (handoff §6 story-lines (y)). seed-resolve.ts cannot see a hidden pin, so a story line would plant a second pin beside it;
-- a curated row under the pin's EXACT name at its stored coordinate brings the pin back with its story instead.
-- Checks done (2026-10-29, all tiles warm):
--   Fort Duquesne Tracery — osm_way109499957, 40.4416311, -80.0109422, stored in rows 809_-1600 and 809_-1601 with the
--     filler "A local landmark (fort).", absent from both tiles' served answers (32 and 38 pins), so hidden. It is the brick
--     outline of Fort Duquesne's walls in Point State Park, 1 m from the Fort Duquesne article's coordinate; that article is
--     in no stored tile (#539), so nothing serves the story. Carries the Forbes Road "Fort Duquesne End" PHMC plaque's
--     subject (the plaque stands 123 m away, by the Blockhouse).
--   Homestead Works Pump House — osm_way395358227, 40.4131696, -79.8968139, stored in rows 808_-1598 and 809_-1598 with the
--     filler "A local landmark (monument).", absent from both served answers (16 and 33 pins), so hidden. The "Homestead
--     Strike" PHMC marker stands 43 m away; the strike article says the pump house where the gunfight happened survives as a
--     museum and meeting hall. The served Homestead Steel Works wiki pin (~230 m) is the whole mill — a different subject.
-- Same-name storied pin within 2 km: none for either. Both still stand.
--
-- RUN: the SQL editor, this whole file in its own tab. Re-runnable: skipped when a same-name curated row sits within 50 m.
-- Expect 2 rows returned on the first run, 0 on a re-run.
-- THEN (new tab): select name, category, dist_m from public.curated_category_backfill(true) order by 1;
--   expect both names among the rows, dist_m 0.
-- Served within the 5-minute curated cache (FROM KATY-ENERGY CORRIDOR (3)) — wait it out before phone QA.
-- BACK-OUT: delete from public.curated_descriptions where note = '#446 hidden-pin row — Pittsburgh part 2 (2026-10-29)';

with v(name, lat, lng, description, source_url, note) as (values
  ($t$Fort Duquesne Tracery$t$, 40.4416311::double precision, -80.0109422::double precision, $t$These bricks trace the walls of Fort Duquesne, which the French destroyed and abandoned before General John Forbes's army, at the end of the road it had cut across Pennsylvania, took the site on November 25, 1758.$t$, $t$https://en.wikipedia.org/wiki/Fort_Duquesne$t$, $t$#446 hidden-pin row — Pittsburgh part 2 (2026-10-29)$t$),
  ($t$Homestead Works Pump House$t$, 40.4131696::double precision, -79.8968139::double precision, $t$On July 6, 1892, two barges carrying some 300 Pinkerton agents hired by Frick tried to land here during the Homestead strike; the strikers fought them for the day until the agents surrendered, and this pump house, where the gunfight took place, survives as a museum.$t$, $t$https://en.wikipedia.org/wiki/Homestead_strike$t$, $t$#446 hidden-pin row — Pittsburgh part 2 (2026-10-29)$t$)
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
