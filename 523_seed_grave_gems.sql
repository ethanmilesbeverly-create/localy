-- 523_seed_grave_gems.sql — #523: two notable graves #511 hid and #521's priming
-- couldn't bring back get a seed grave gem each, on the grave's OWN plot.
-- Supabase SQL editor (runs as postgres). Nothing outside this file: no function,
-- no Pages, no CACHE_VERSION, no env var.
--
-- WHY A GEM, NOT A PRIME: the serve-path bake keys on the OSM pin's exact label,
-- and these labels don't resolve through the guards — "Marshall Field" also names
-- the store, and "Governor Tanner's Tomb" doesn't token-match *John Riley Tanner*.
-- A seed gem is how Grant, Marshall and Houdini already show (#521's scan). The OSM
-- pins stay hidden by #511, so each person appears once.
--
-- READ FIRST (2026-10-08, public key):
--   * OSM pins, from the tile cache (places:v34:*):
--       osm_node4141079681  "Marshall Field"          41.9603094, -87.6612916  type grave
--                           (tile 839_-1753, Graceland Cemetery, Chicago)
--       osm_way107458555    "Governor Tanner's Tomb"  39.8216975, -89.6554511  type grave
--                           (tile 796_-1793, Oak Ridge Cemetery, Springfield IL)
--   * submissions: no gem named like "Marshall Field" or "Tanner" anywhere except
--     "Grave of Benjamin Tucker Tanner" (Philadelphia — a different person), and no
--     gem within ~1 km of the Tanner tomb. Graceland's existing "Grave of …" gems sit
--     on #372's 50 m ring at 41.9548, -87.6613 — these two go on the PLOT instead
--     (#523's instruction, #520's finding).
--   * Bios: Wikipedia intros of "Marshall Field" (1834–1906) and "John Riley
--     Tanner" (1844–1901), read the same day; dates checked against the burials
--     (Field d. 1906, buried Graceland; Tanner d. 1901, buried Oak Ridge).
--
-- SHAPE: the graves-resolve.ts seed row ("Grave of <person>", category 'history',
-- status 'approved', submitted_by null, source 'seed:wikidata-grave'), with the
-- bio in description AND resolved_description and resolved_source 'wiki' — the
-- same three fields every live Graceland grave gem carries, so the #344 story gate
-- shows it at once. Same source tag so graves-resolve's #338/#384 skip treats
-- these as loaded and a later crawl can't double them. review_note carries #523.
--
-- GUARDS (handoff §5, the disposition-SQL rule): a DO pre-check raises — and the
-- editor's one implicit transaction then changes NOTHING — if ANY submission (any
-- status) already has either name, or any live gem whose name mentions the person
-- sits within 1.5 km of the plot. A second run aborts on the name check. No
-- begin/commit (handoff §5, #10).
--
-- HOW TO RUN: paste the whole file into one SQL-editor tab and Run. The grid is
-- the final SELECT: two rows, "#523 inserted", status approved, resolved_source
-- wiki, at the coordinates above.
--
-- UNDO (reversible, keeps the rows — the #489/#492 retire shape):
--   update public.submissions set status = 'rejected',
--          review_note = review_note || ' | #523 undone'
--    where source = 'seed:wikidata-grave' and review_note like '#523 %'
--      and status = 'approved' and merged_into is null;

do $$
declare
  n_name int;
  n_near int;
begin
  select count(*) into n_name
    from public.submissions s
   where s.name in ('Grave of Marshall Field', 'Grave of John Riley Tanner');
  if n_name <> 0 then
    raise exception '#523 pre-check: % submission(s) already carry one of the two names — already run, or added another way; nothing changed', n_name;
  end if;

  select count(*) into n_near
    from public.submissions s
   where s.status = 'approved' and s.merged_into is null
     and (
       (s.name ilike '%marshall field%'
        and abs(s.lat - 41.9603094) < 0.0135 and abs(s.lng - (-87.6612916)) < 0.0182)
       or
       (s.name ilike '%tanner%'
        and abs(s.lat - 39.8216975) < 0.0135 and abs(s.lng - (-89.6554511)) < 0.0175)
     );
  if n_near <> 0 then
    raise exception '#523 pre-check: % live gem(s) for one of these people already within ~1.5 km of the grave — nothing changed; read them before adding a twin', n_near;
  end if;
end $$;

insert into public.submissions
  (name, description, resolved_description, resolved_source, category,
   lat, lng, city, status, submitted_by, source, review_note)
values
  ('Grave of Marshall Field',
   $bio$Marshall Field (August 18, 1834 – January 16, 1906) was an American entrepreneur and the founder of Marshall Field and Company, the Chicago-based department stores.
Field is also known for some of his philanthropic donations, providing funding for the Field Museum of Natural History and donating land for the campus of the University of Chicago.$bio$,
   $bio$Marshall Field (August 18, 1834 – January 16, 1906) was an American entrepreneur and the founder of Marshall Field and Company, the Chicago-based department stores.
Field is also known for some of his philanthropic donations, providing funding for the Field Museum of Natural History and donating land for the campus of the University of Chicago.$bio$,
   'wiki', 'history',
   41.9603094, -87.6612916, 'Chicago', 'approved', null, 'seed:wikidata-grave',
   '#523 2026-10-08: seed grave gem on the OSM plot (osm_node4141079681, Graceland) — the OSM label clean-misses the grave bank, so the pin stays hidden by #511'),
  ('Grave of John Riley Tanner',
   $bio$John Riley Tanner (April 4, 1844 – May 23, 1901) was the 21st governor of Illinois, from 1897 until 1901.
Tanner was the first governor in the country to be openly neutral in labor disputes, gaining national notoriety for his actions in a series of coal mine disputes. With the Spanish–American War looming, he was the only governor to raise and combat-equip a National Guard unit of African American soldiers led by African American officers.
Tanner's administration was capable and efficient, placing the state on a sound financial footing and passing significant legislation. However, he was constantly at odds with Chicago's political leaders, both Democratic and Republican, a feud that came to be symbolized by his signing of the infamous "Allen bill", which gave control of Chicago's intra-city transportation network to corrupt financier Charles Yerkes.
Tanner declined to seek a second term as governor, instead choosing to oppose the renomination of his former political ally, Shelby Cullom, as U.S. Senator. Tanner was badly defeated within his own party, ending his political career. He died less than five months after leaving office.$bio$,
   $bio$John Riley Tanner (April 4, 1844 – May 23, 1901) was the 21st governor of Illinois, from 1897 until 1901.
Tanner was the first governor in the country to be openly neutral in labor disputes, gaining national notoriety for his actions in a series of coal mine disputes. With the Spanish–American War looming, he was the only governor to raise and combat-equip a National Guard unit of African American soldiers led by African American officers.
Tanner's administration was capable and efficient, placing the state on a sound financial footing and passing significant legislation. However, he was constantly at odds with Chicago's political leaders, both Democratic and Republican, a feud that came to be symbolized by his signing of the infamous "Allen bill", which gave control of Chicago's intra-city transportation network to corrupt financier Charles Yerkes.
Tanner declined to seek a second term as governor, instead choosing to oppose the renomination of his former political ally, Shelby Cullom, as U.S. Senator. Tanner was badly defeated within his own party, ending his political career. He died less than five months after leaving office.$bio$,
   'wiki', 'history',
   39.8216975, -89.6554511, 'Springfield', 'approved', null, 'seed:wikidata-grave',
   '#523 2026-10-08: seed grave gem on the OSM plot (osm_way107458555 "Governor Tanner''s Tomb", Oak Ridge) — the OSM label clean-misses the grave bank, so the pin stays hidden by #511');

select '#523 inserted' as result, s.name, s.status, s.resolved_source, s.category,
       round(s.lat::numeric, 7) as lat, round(s.lng::numeric, 7) as lng, s.city, s.source,
       length(s.resolved_description) as bio_chars
  from public.submissions s
 where s.review_note like '#523 %'
 order by s.name;
