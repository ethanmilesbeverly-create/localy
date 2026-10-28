-- 485_prairie_grove_twin.sql — #485 Katy-Energy Corridor (2026-10-28): retire ONE seed that twins a hidden OSM pin.
-- WHAT HAPPENED: the "Prairie Grove Cemetery" story line (names-485-katy-energy-corridor.txt, committed as a seed at
-- 29.683683, -95.622767) sits 2 m from osm_node12403653011 "Prairie Grove Cemetery" (desc "A local memorial (plaque)."),
-- a hidden storyless pin stored in the NEIGHBOURING tile's row, places:v34:594_-1913 — the line's own tile is 594_-1912,
-- and the pre-mining read checked only each line's own tile. curated_category_backfill(true) exposed it (dist_m 2).
-- The commit's curated_descriptions row for the line is KEPT: it matches the OSM pin by name within 50 m, so that pin now
-- serves the story; only the twin seed goes.
-- FIX (the #492 retire shape): status 'rejected' + a review note, matched on exact name and coordinate.
-- RUN: the SQL editor, this whole file in its own tab. Step 1 shows the state; step 2 retires the seed.
-- EXPECT: step 1 → 1 row, status approved, resolved_source curated. Step 2 → 1 row returned, status rejected.
--         A re-run of step 2 returns 0 rows.
-- BACK-OUT: update public.submissions set status = 'approved'
--             where name = 'Prairie Grove Cemetery' and review_note like '%#485 2026-10-28: twin%';

-- Step 1: look first.
select id, name, status, round(lat::numeric, 6) as lat, round(lng::numeric, 6) as lng, city, resolved_source
  from public.submissions
 where name = 'Prairie Grove Cemetery'
   and abs(lat - 29.683683) < 0.000001
   and abs(lng - (-95.622767)) < 0.000001
   and merged_into is null;

-- Step 2: retire the twin seed.
update public.submissions s
   set status      = 'rejected',
       reviewed_at = now(),
       review_note = concat_ws(' | ', s.review_note, '#485 2026-10-28: twin of hidden OSM pin osm_node12403653011 (2 m); the curated story now serves that pin')
 where s.name = 'Prairie Grove Cemetery'
   and abs(s.lat - 29.683683) < 0.000001
   and abs(s.lng - (-95.622767)) < 0.000001
   and s.city = 'Katy-Energy Corridor'
   and s.status = 'approved' and s.merged_into is null
returning s.id, s.name, s.status;
