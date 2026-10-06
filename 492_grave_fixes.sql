-- 492_grave_fixes.sql — #492: grave pins in the wrong cemetery (same-named
-- cemeteries, reinterments, and a few plain misplacements). Supabase SQL editor
-- (runs as postgres). Nothing outside this file: no function, no Pages, no
-- CACHE_VERSION, no env var. Stamp: 492-fixes-v1 (2026-10-06).
--
-- WHAT THE SPIKE FOUND (2026-10-06, read-only, from the sandbox):
--   Read the 4,954 live "Grave of …" pins (approved, unmerged) through the anon
--   gem read, and each person's English Wikipedia article (Wikidata itself is
--   outside the sandbox's network allowlist). Compared every pin with the
--   article's resting place — infobox coordinate, the cemetery article's own
--   coordinate, the state named in the infobox, and any "buried / interred …"
--   sentence in the body. Every flag was hand-judged; namesakes ("Will Rogers"
--   the congressman, "Phil Harris" the crab captain) and parser artifacts were
--   cleared. ~1,670 pins had checkable evidence; the other ~3,300 have none and
--   are UNMEASURED, not cleared. 20 confirmed wrong (+1 held, below):
--
--   MOVE (8) — the true cemetery is inside a roster metro's grave box; each pin
--   joins that cemetery's existing grave cluster on the next free graves-resolve
--   ring slot (#372: 50 m rings of 8 around the rank-0 pin; slots 1–4 taken in
--   every cluster here, so these take 5, 6, 7):
--     Whitney Houston, Bobbi Kristina Brown — pinned in Fairview (Bergen Co.),
--       buried Fairview Cemetery, WESTFIELD, NJ (same-named). → Béla Julesz's cluster.
--     Robert La Tourneaux — pinned near St. Louis (a "Rose Hill"), buried Rosedale
--       & Rosehill, Linden, NJ (same-named). → Fats Navarro's cluster; city → New York.
--     Greer Garson, Mary Kay Ash, August Schellenberg — ~31 km east of Dallas,
--       buried Sparkman-Hillcrest, Dallas (one bad cemetery coordinate). → Jack Kilby's.
--     Frank Epperson — pinned in Hayward, buried Mountain View, Oakland. → Donald Glaser's.
--     Frank Capone — pinned at Mount Olivet, Chicago (his first grave); now
--       Mount Carmel, Hillside (infobox). → Al Capone's cluster (NOT Tony Accardo's
--       next door — that is Queen of Heaven).
--
--   RETIRE (12) — the true grave is in no roster metro, or has no sourced coordinate:
--     Same-named cemetery: Patty Duke (Forest Cem., Coeur d'Alene ID), Ellen
--       Swallow Richards (Christ Church Cem., Gardiner ME), Charles McGavin (Mount
--       Auburn, HARVARD IL — pin is Stickney's Mount Auburn), Mercy Otis Warren
--       (Burial Hill, Plymouth MA), Aiyana Stanley-Jones (Trinity Cem., Detroit —
--       Detroit IS a roster metro, but no source gives the cemetery's location,
--       so retire rather than guess; blank beats wrong, #101/#178).
--     Reinterred (pin marks a former grave): Ze'ev Jabotinsky (Mount Herzl,
--       Jerusalem, 1964), Gary Cooper (Southampton NY, 1974), Robert Crain (Crain
--       Cemetery, Mount Victoria MD — pin is his temporary Prospect Hill grave).
--     Elsewhere: George Foreman (Logan Park, Sioux City IA, announced 2026), John
--       Parke Custis (Queen's Creek, York Co. VA), Addison Hutton (Short Creek
--       Meeting House, Jefferson Co. OH), Sam Jaffe (Williston Cem., SC).
--
--   HELD, NOT IN THIS FILE: Lewis Strauss — Wikipedia says Hebrew Cemetery,
--   Richmond VA; the pin sits beside Salem Fields, Brooklyn. Sources disagree;
--   settle it before acting.
--
-- WILL A graves-resolve RE-RUN UNDO THIS? No. Its #338 skip keys on every row's
-- name + coordinate WHATEVER its status (a retired row still blocks its exact
-- re-plant), and its #384 by-name index reports a moved pin as "loaded-elsewhere"
-- and skips it. A metro graves pass will not re-plant any of the 20.
--
-- HOW TO RUN: one block at a time, each in its own SQL-editor tab, in order.
--   Block 1 — read only.        Block 2 — the change (one transaction).
--   Block 3 — read only, the check after Block 2.
-- Block 2 is guarded (handoff §5's disposition pattern, as #489): it matches each
-- pin by name + its own stored coordinate (no pasted UUIDs), aborts the WHOLE run
-- unless all 20 match exactly one live row each, and ends with a result table.
-- A second run aborts on the pre-check and changes nothing.


-- ===========================================================================
-- BLOCK 1 — READ ONLY. The 20 pins as they stand. EXPECT: 20 rows, every one
-- live = true, matches = 1. Any other count: stop and paste the result.
-- ===========================================================================
with t(name, lat, lng) as (values
  ('Grave of Whitney Houston',            40.8148228,       -74.0054171),
  ('Grave of Bobbi Kristina Brown',       40.8151404009617, -74.004997451405),
  ('Grave of Robert La Tourneaux',        38.4447,          -90.2081),
  ('Grave of Greer Garson',               32.7525,          -96.47444444),
  ('Grave of Mary Kay Ash',               32.7521823990383, -96.4740668001151),
  ('Grave of August Schellenberg',        32.7525,          -96.4739103765531),
  ('Grave of Frank Epperson',             37.6485823990383, -122.063598871495),
  ('Grave of Frank Capone',               41.6893380455875, -87.69166667),
  ('Grave of Patty Duke',                 42.523611111,     -71.400277777),
  ('Grave of Ellen Swallow Richards',     40.4736,          -74.2799),
  ('Grave of Charles McGavin',            41.8142,          -87.7897),
  ('Grave of Mercy Otis Warren',          42.51095556,      -70.84623889),
  ('Grave of Ze''ev Jabotinsky',          40.72638889,      -73.38722222),
  ('Grave of Gary Cooper',                33.9919666009617, -118.386712941674),
  ('Grave of Robert Crain',               38.9196158215875, -77.007777777),
  ('Grave of George Foreman',             29.8897,          -95.4592),
  ('Grave of John Parke Custis',          38.7082269325875, -77.086111111),
  ('Grave of Addison Hutton',             39.9568176009617, -75.251805665226),
  ('Grave of Sam Jaffe',                  34.280444,        -118.467930419334),
  ('Grave of Aiyana Mo''Nay Stanley-Jones', 40.6347715,     -73.7077512306395)
)
select t.name,
       count(s.id)                                                          as matches,
       bool_and(s.status = 'approved' and s.merged_into is null)           as live,
       min(s.city)                                                          as city,
       min(s.source)                                                        as source
  from t
  left join public.submissions s
    on s.name = t.name
   and abs(s.lat - t.lat) < 0.000001
   and abs(s.lng - t.lng) < 0.000001
   and s.status = 'approved' and s.merged_into is null
 group by t.name
 order by t.name;


-- ===========================================================================
-- BLOCK 2 — THE CHANGE. Move 8 pins onto their true cemetery's cluster; retire
-- 12 (status 'rejected', as #489 — row, name and bio kept, reversible; the
-- submissions_propagate_merged_status trigger carries the status to any merged
-- copy). Every row gets a #492 review_note saying what and why.
-- ===========================================================================
begin;

create temp table t492 (
  name text, lat double precision, lng double precision,
  action text, new_lat double precision, new_lng double precision,
  new_city text, note text
) on commit drop;

insert into t492 values
  -- MOVES (new coordinate = next free #372 ring slot at the true cemetery's cluster)
  ('Grave of Whitney Houston',      40.8148228,       -74.0054171,       'move', 40.6658508, -74.3306,    null,
   'moved from Fairview NJ (Bergen Co.) to Fairview Cemetery, Westfield NJ — same-named cemetery'),
  ('Grave of Bobbi Kristina Brown', 40.8151404009617, -74.004997451405,  'move', 40.6659824, -74.3310187, null,
   'moved from Fairview NJ (Bergen Co.) to Fairview Cemetery, Westfield NJ — same-named cemetery'),
  ('Grave of Robert La Tourneaux',  38.4447,          -90.2081,          'move', 40.6311418, -74.238127,  'New York',
   'moved from near St. Louis to Rosedale & Rosehill Cemetery, Linden NJ — same-named cemetery'),
  ('Grave of Greer Garson',         32.7525,          -96.47444444,      'move', 32.8675508, -96.781,     null,
   'moved ~31 km to Sparkman-Hillcrest Memorial Park, Dallas — bad cemetery coordinate'),
  ('Grave of Mary Kay Ash',         32.7521823990383, -96.4740668001151, 'move', 32.8676824, -96.7813781, null,
   'moved ~31 km to Sparkman-Hillcrest Memorial Park, Dallas — bad cemetery coordinate'),
  ('Grave of August Schellenberg',  32.7525,          -96.4739103765531, 'move', 32.868,     -96.7815348, null,
   'moved ~31 km to Sparkman-Hillcrest Memorial Park, Dallas — bad cemetery coordinate'),
  ('Grave of Frank Epperson',       37.6485823990383, -122.063598871495, 'move', 37.8344508, -122.237,    null,
   'moved from Hayward to Mountain View Cemetery, Oakland (Wikipedia resting place)'),
  ('Grave of Frank Capone',         41.6893380455875, -87.69166667,      'move', 41.8637508, -87.9075,    null,
   'moved from Mount Olivet, Chicago (first grave) to Mount Carmel, Hillside IL (Wikipedia resting place)'),
  -- RETIRES
  ('Grave of Patty Duke',               42.523611111,     -71.400277777,     'retire', null, null, null,
   'retired — buried Forest Cemetery, Coeur d''Alene ID (same-named cemetery); in no roster metro'),
  ('Grave of Ellen Swallow Richards',   40.4736,          -74.2799,          'retire', null, null, null,
   'retired — buried Christ Church Cemetery, Gardiner ME (same-named cemetery); in no roster metro'),
  ('Grave of Charles McGavin',          41.8142,          -87.7897,          'retire', null, null, null,
   'retired — pin is Mount Auburn, Stickney IL; buried Mount Auburn, Harvard IL (same-named); outside the Chicago box'),
  ('Grave of Mercy Otis Warren',        42.51095556,      -70.84623889,      'retire', null, null, null,
   'retired — buried Burial Hill, Plymouth MA; outside the Boston box'),
  ('Grave of Aiyana Mo''Nay Stanley-Jones', 40.6347715,   -73.7077512306395, 'retire', null, null, null,
   'retired — buried Trinity Cemetery, Detroit (same-named); no sourced cemetery coordinate, so not moved'),
  ('Grave of Ze''ev Jabotinsky',        40.72638889,      -73.38722222,      'retire', null, null, null,
   'retired — reinterred at Mount Herzl, Jerusalem, 1964; pin marks the former grave'),
  ('Grave of Gary Cooper',              33.9919666009617, -118.386712941674, 'retire', null, null, null,
   'retired — reinterred at Sacred Hearts Cemetery, Southampton NY, 1974; pin marks the former grave'),
  ('Grave of Robert Crain',             38.9196158215875, -77.007777777,     'retire', null, null, null,
   'retired — reinterred at Crain Cemetery, Mount Victoria MD; pin marks the temporary Prospect Hill grave'),
  ('Grave of George Foreman',           29.8897,          -95.4592,          'retire', null, null, null,
   'retired — buried Logan Park Cemetery, Sioux City IA (announced 2026); in no roster metro'),
  ('Grave of John Parke Custis',        38.7082269325875, -77.086111111,     'retire', null, null, null,
   'retired — buried at Queen''s Creek, York County VA; in no roster metro'),
  ('Grave of Addison Hutton',           39.9568176009617, -75.251805665226,  'retire', null, null, null,
   'retired — buried Short Creek Meeting House, Jefferson County OH; in no roster metro'),
  ('Grave of Sam Jaffe',                34.280444,        -118.467930419334, 'retire', null, null, null,
   'retired — ashes buried Williston Cemetery, Williston SC (2006); in no roster metro');

do $$
declare n_rows int; n_hit int; n_pairs int;
begin
  select count(*) into n_rows from t492;
  select count(distinct t.name), count(*) into n_hit, n_pairs
    from t492 t join public.submissions s
      on s.name = t.name
     and abs(s.lat - t.lat) < 0.000001
     and abs(s.lng - t.lng) < 0.000001
   where s.status = 'approved' and s.merged_into is null;
  if n_rows <> 20 or n_hit <> 20 or n_pairs <> 20 then
    raise exception '#492 pre-check: expected 20 pins each matching exactly 1 live row; list % / matched % / pairs % — nothing changed',
      n_rows, n_hit, n_pairs;
  end if;
end $$;

update public.submissions s
   set lat         = t.new_lat,
       lng         = t.new_lng,
       city        = coalesce(t.new_city, s.city),
       reviewed_at = now(),
       review_note = concat_ws(' | ', s.review_note, '#492 2026-10-06: ' || t.note)
  from t492 t
 where t.action = 'move'
   and s.name = t.name
   and abs(s.lat - t.lat) < 0.000001
   and abs(s.lng - t.lng) < 0.000001
   and s.status = 'approved' and s.merged_into is null;

update public.submissions s
   set status      = 'rejected',
       reviewed_at = now(),
       review_note = concat_ws(' | ', s.review_note, '#492 2026-10-06: ' || t.note)
  from t492 t
 where t.action = 'retire'
   and s.name = t.name
   and abs(s.lat - t.lat) < 0.000001
   and abs(s.lng - t.lng) < 0.000001
   and s.status = 'approved' and s.merged_into is null;

-- Result: EXPECT 20 rows — 8 'approved' at their new coordinates, 12 'rejected'.
select t.action, s.name, s.status, round(s.lat::numeric, 5) as lat, round(s.lng::numeric, 5) as lng,
       s.city, right(s.review_note, 70) as note_tail
  from t492 t
  join public.submissions s
    on s.name = t.name and s.merged_into is null
   and s.review_note like '%#492 2026-10-06%'
 order by t.action, s.name;

commit;


-- ===========================================================================
-- BLOCK 3 — READ ONLY, after Block 2. EXPECT: live_grave_pins = 12 fewer than
-- before (4,942 if nothing else changed), moved_live = 8, retired = 12,
-- strauss_live = 1 (held, untouched), and every moved pin within 120 m of its
-- cluster's rank-0 pin.
-- ===========================================================================
select (select count(*) from public.submissions
         where name ilike 'Grave of %' and status = 'approved' and merged_into is null) as live_grave_pins,
       (select count(*) from public.submissions
         where review_note like '%#492 2026-10-06: moved%'
           and status = 'approved' and merged_into is null)                              as moved_live,
       (select count(*) from public.submissions
         where review_note like '%#492 2026-10-06: retired%'
           and status = 'rejected' and merged_into is null)                              as retired,
       (select count(*) from public.submissions
         where name = 'Grave of Lewis Strauss'
           and status = 'approved' and merged_into is null)                              as strauss_live;

with anchor(pin, centre) as (values
  ('Grave of Whitney Houston',      'Grave of Béla Julesz'),
  ('Grave of Bobbi Kristina Brown', 'Grave of Béla Julesz'),
  ('Grave of Robert La Tourneaux',  'Grave of Fats Navarro'),
  ('Grave of Greer Garson',         'Grave of Jack Kilby'),
  ('Grave of Mary Kay Ash',         'Grave of Jack Kilby'),
  ('Grave of August Schellenberg',  'Grave of Jack Kilby'),
  ('Grave of Frank Epperson',       'Grave of Donald Arthur Glaser'),
  ('Grave of Frank Capone',         'Grave of Al Capone')
)
select a.pin, a.centre,
       round((2 * 6371000 * asin(sqrt(
         power(sin(radians(c.lat - p.lat) / 2), 2) +
         cos(radians(p.lat)) * cos(radians(c.lat)) *
         power(sin(radians(c.lng - p.lng) / 2), 2))))::numeric) as metres_from_centre
  from anchor a
  join public.submissions p on p.name = a.pin    and p.status = 'approved' and p.merged_into is null
  join public.submissions c on c.name = a.centre and c.status = 'approved' and c.merged_into is null
 order by a.pin;


-- ===========================================================================
-- UNDO (do not run unless reversing #492). Retires: put them back (the trigger
-- restores any merged copy). Moves: restore the old coordinate (and La
-- Tourneaux's city — set it to what Block 1 showed).
-- ===========================================================================
-- update public.submissions
--    set status = 'approved'
--  where review_note like '%#492 2026-10-06: retired%' and merged_into is null;
--
-- update public.submissions s
--    set lat = v.lat, lng = v.lng
--   from (values
--     ('Grave of Whitney Houston',      40.8148228,       -74.0054171),
--     ('Grave of Bobbi Kristina Brown', 40.8151404009617, -74.004997451405),
--     ('Grave of Robert La Tourneaux',  38.4447,          -90.2081),
--     ('Grave of Greer Garson',         32.7525,          -96.47444444),
--     ('Grave of Mary Kay Ash',         32.7521823990383, -96.4740668001151),
--     ('Grave of August Schellenberg',  32.7525,          -96.4739103765531),
--     ('Grave of Frank Epperson',       37.6485823990383, -122.063598871495),
--     ('Grave of Frank Capone',         41.6893380455875, -87.69166667)
--   ) as v(name, lat, lng)
--  where s.name = v.name
--    and s.review_note like '%#492 2026-10-06: moved%' and s.merged_into is null;
