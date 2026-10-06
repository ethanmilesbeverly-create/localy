-- 492b_grave_fixes.sql — #492 second pass: the LIVE grave pins the new
-- resting-place check (graves-resolve 2026.10.06b, --all dry run with the
-- submissions-aware skip on, 2026-10-06) put in its audit. Supabase SQL editor
-- (runs as postgres). Nothing outside this file: no function, no Pages, no
-- CACHE_VERSION, no env var. Stamp: 492b-fixes-v1 (2026-10-06).
--
-- THE AUDIT listed 19 live pins (18 disputed by the person's own article, 1 #342
-- non-cemetery). Dispositioned by hand:
--   MOVE (6) — the true cemetery is inside a roster box; each joins that cemetery's
--   existing grave cluster on the next free graves-resolve ring slot (#372; slots
--   1–4 taken in every cluster here):
--     Jan Karski → Mount Olivet, Washington D.C. (pinned at a same-named Mount
--       Olivet in Monmouth Co., NJ). → James Hoban's cluster; city → Washington, D.C.
--     W. H. H. Hart → National Harmony Memorial Park, Landover MD (Columbian
--       Harmony, D.C., was relocated there). → Billy Stewart's cluster (beside Hyman).
--     Thomas Birch Florence, John Hull Campbell, Harriet Judd Sartain → Lawnview
--       Memorial Park, Rockledge PA (Monument Cemetery closed 1956, remains moved).
--       → George Lippard's cluster (Gobrecht and Dunlap, earlier transfers, are there).
--     Paul Castellano → Moravian Cemetery, Staten Island (his P119 was the CITY, so
--       the pin sat on New York's centre point). → Cornelius Vanderbilt's cluster.
--   RETIRE (9) — the true grave is outside every roster box, or there is no sourced
--   current grave: Béla Bartók (Budapest 1988), William Hays (West Point 1894),
--   Henry Hill (Schuylkill Haven PA), John Franklin Miller (Arlington 1913), John
--   Currey (Lone Mountain cleared), Pete Knight (Hot Springs AR 1960), Jesse Walter
--   Fewkes (Abbey Mausoleum demolished), Henry Lawrence Burnett (Goshen NY), W. W. S.
--   Bliss (Fort Bliss TX).
--   NOT IN THIS FILE — PIN IS RIGHT, released in graves-resolve 2026.10.06c: Richard
--   Montgomery (reinterred AT St. Paul's 1818), Shirley Horn (Fort Lincoln, MD —
--   "near Washington, D.C." tripped the state test), Lucien Lee Kinsolving (his
--   wife's burial sentence). HELD: William C. McCool — the article's text says
--   Anacortes WA, its own category says Naval Academy Cemetery; settle first.
--   (Lewis Strauss stays held from #492's first pass.)
--
-- DURABLE: graves-resolve's #338 skip keys every row whatever its status, and its
-- #384 index treats a moved pin as a hand placement (trusted) — a later --all
-- won't re-plant or re-propose any of these 15.
--
-- HOW TO RUN: one block at a time, each in its own SQL-editor tab, in order.
-- Block 2 is guarded (#489/#492): name + stored coordinate, aborts the WHOLE run
-- unless all 15 match exactly one live row each; a second run aborts unchanged.


-- ===========================================================================
-- BLOCK 1 — READ ONLY. EXPECT: 15 rows, every one matches = 1, live = true.
-- ===========================================================================
with t(name, lat, lng) as (values
  ('Grave of Jan Karski', 40.3748, -74.0815),
  ('Grave of William Henry Harrison Hart', 38.9196823990383, -76.9928917850834),
  ('Grave of Thomas Birch Florence', 39.981, -75.153),
  ('Grave of John Hull Campbell', 39.981, -75.153),
  ('Grave of Harriet Judd Sartain', 39.9813176009617, -75.1525855166991),
  ('Grave of Paul Castellano', 40.7132269325875, -74.006111111),
  ('Grave of Béla Bartók', 41.0279491555875, -73.8325),
  ('Grave of William Hays', 40.9411011, -73.8811039940416),
  ('Grave of Henry Hill', 40.8963176009617, -74.4085798368732),
  ('Grave of John Franklin Miller', 37.784166666, -122.450833333),
  ('Grave of John Currey', 37.784166666, -122.450265014961),
  ('Grave of Pete Knight', 37.6747, -122.048432521436),
  ('Grave of Jesse Walter Fewkes', 38.8702, -77.0741),
  ('Grave of Henry Lawrence Burnett', 40.232222, -74.8275),
  ('Grave of William Wallace Smith Bliss', 29.9500398229617, -90.0785223395626)
)
select t.name, count(s.id) as matches,
       bool_and(s.status = 'approved' and s.merged_into is null) as live,
       min(s.city) as city
  from t
  left join public.submissions s
    on s.name = t.name
   and abs(s.lat - t.lat) < 0.000001 and abs(s.lng - t.lng) < 0.000001
   and s.status = 'approved' and s.merged_into is null
 group by t.name
 order by t.name;


-- ===========================================================================
-- BLOCK 2 — THE CHANGE. Move 6 onto their true cemetery's cluster; retire 9
-- (status 'rejected', as #489/#492 — reversible). Each row gets a #492b note.
-- ===========================================================================
begin;

create temp table t492b (
  name text, lat double precision, lng double precision,
  action text, new_lat double precision, new_lng double precision,
  new_city text, note text
) on commit drop;

insert into t492b values
  ('Grave of Jan Karski', 40.3748, -74.0815, 'move', 38.9109508, -76.9794, 'Washington, D.C.',
   'moved from Mount Olivet, Monmouth Co. NJ to Mount Olivet Cemetery, Washington D.C. — same-named cemetery'),
  ('Grave of William Henry Harrison Hart', 38.9196823990383, -76.9928917850834, 'move', 38.9070508, -76.8817, null,
   'moved from the old Columbian Harmony site (D.C.) to National Harmony Memorial Park, Landover MD — the cemetery was relocated'),
  ('Grave of Thomas Birch Florence', 39.981, -75.153, 'move', 40.0807508, -75.0956, null,
   'moved from Monument Cemetery (closed 1956) to Lawnview Memorial Park, Rockledge PA — reinterred'),
  ('Grave of John Hull Campbell', 39.981, -75.153, 'move', 40.0808824, -75.0960151, null,
   'moved from Monument Cemetery (closed 1956) to Lawnview Memorial Park, Rockledge PA — reinterred'),
  ('Grave of Harriet Judd Sartain', 39.9813176009617, -75.1525855166991, 'move', 40.0812, -75.096187, null,
   'moved from Monument Cemetery (closed 1956) to Lawnview Memorial Park, Rockledge PA — reinterred'),
  ('Grave of Paul Castellano', 40.7132269325875, -74.006111111, 'move', 40.5795508, -74.1166667, null,
   'moved from the New York City centre point to Moravian Cemetery, Staten Island (Wikidata P119 was the city)'),
  ('Grave of Béla Bartók', 41.0279491555875, -73.8325, 'retire', null, null, null,
   'retired — reinterred in Budapest (Farkasréti), 1988; pin marks the former Ferncliff grave'),
  ('Grave of William Hays', 40.9411011, -73.8811039940416, 'retire', null, null, null,
   'retired — reinterred at West Point Cemetery, 1894; outside the New York box'),
  ('Grave of Henry Hill', 40.8963176009617, -74.4085798368732, 'retire', null, null, null,
   'retired — buried Schuylkill Haven Union Cemetery, PA (same-named Greenwood); in no roster metro'),
  ('Grave of John Franklin Miller', 37.784166666, -122.450833333, 'retire', null, null, null,
   'retired — reinterred at Arlington National Cemetery, 1913; pin marks the former Lone Mountain grave'),
  ('Grave of John Currey', 37.784166666, -122.450265014961, 'retire', null, null, null,
   'retired — Wikidata ends the Lone Mountain (Laurel Hill) burial; that cemetery was cleared, no sourced current grave'),
  ('Grave of Pete Knight', 37.6747, -122.048432521436, 'retire', null, null, null,
   'retired — reinterred at Greenwood Cemetery, Hot Springs AR, 1960; in no roster metro'),
  ('Grave of Jesse Walter Fewkes', 38.8702, -77.0741, 'retire', null, null, null,
   'retired — Wikidata ends the Abbey Mausoleum burial (demolished); no sourced current grave'),
  ('Grave of Henry Lawrence Burnett', 40.232222, -74.8275, 'retire', null, null, null,
   'retired — buried Slate Hill Cemetery, Goshen NY (same-named); outside every roster box'),
  ('Grave of William Wallace Smith Bliss', 29.9500398229617, -90.0785223395626, 'retire', null, null, null,
   'retired — remains moved to Fort Bliss National Cemetery, TX; pin marks the defunct Girod Street grave');

do $$
declare n_rows int; n_hit int; n_pairs int;
begin
  select count(*) into n_rows from t492b;
  select count(distinct t.name), count(*) into n_hit, n_pairs
    from t492b t join public.submissions s
      on s.name = t.name
     and abs(s.lat - t.lat) < 0.000001 and abs(s.lng - t.lng) < 0.000001
   where s.status = 'approved' and s.merged_into is null;
  if n_rows <> 15 or n_hit <> 15 or n_pairs <> 15 then
    raise exception '#492b pre-check: expected 15 pins each matching exactly 1 live row; list % / matched % / pairs % — nothing changed',
      n_rows, n_hit, n_pairs;
  end if;
end $$;

update public.submissions s
   set lat = t.new_lat, lng = t.new_lng,
       city = coalesce(t.new_city, s.city),
       reviewed_at = now(),
       review_note = concat_ws(' | ', s.review_note, '#492b 2026-10-06: ' || t.note)
  from t492b t
 where t.action = 'move'
   and s.name = t.name
   and abs(s.lat - t.lat) < 0.000001 and abs(s.lng - t.lng) < 0.000001
   and s.status = 'approved' and s.merged_into is null;

update public.submissions s
   set status = 'rejected',
       reviewed_at = now(),
       review_note = concat_ws(' | ', s.review_note, '#492b 2026-10-06: ' || t.note)
  from t492b t
 where t.action = 'retire'
   and s.name = t.name
   and abs(s.lat - t.lat) < 0.000001 and abs(s.lng - t.lng) < 0.000001
   and s.status = 'approved' and s.merged_into is null;

-- Result: EXPECT 15 rows — 6 'approved' at their new coordinates, 9 'rejected'.
select t.action, s.name, s.status, round(s.lat::numeric, 5) as lat, round(s.lng::numeric, 5) as lng,
       s.city, right(s.review_note, 70) as note_tail
  from t492b t
  join public.submissions s
    on s.name = t.name and s.merged_into is null
   and s.review_note like '%#492b 2026-10-06%'
 order by t.action, s.name;

commit;


-- ===========================================================================
-- BLOCK 3 — READ ONLY, after Block 2. EXPECT: moved_live 6, retired 9, held_live
-- 2 (McCool and Strauss untouched), and every moved pin 50 m from its centre.
-- (Live grave pins drop by 9 from whatever Block 1's day started at — 4,943 at the
-- audit run → 4,934 if nothing else changed.)
-- ===========================================================================
select (select count(*) from public.submissions
         where name ilike 'Grave of %' and status = 'approved' and merged_into is null) as live_grave_pins,
       (select count(*) from public.submissions
         where review_note like '%#492b 2026-10-06: moved%' and status = 'approved' and merged_into is null) as moved_live,
       (select count(*) from public.submissions
         where review_note like '%#492b 2026-10-06: retired%' and status = 'rejected' and merged_into is null) as retired,
       (select count(*) from public.submissions
         where name in ('Grave of William C. McCool', 'Grave of Lewis Strauss')
           and status = 'approved' and merged_into is null) as held_live;

with anchor(pin, centre) as (values
  ('Grave of Jan Karski', 'Grave of James Hoban'),
  ('Grave of William Henry Harrison Hart', 'Grave of Billy Stewart'),
  ('Grave of Thomas Birch Florence', 'Grave of George Lippard'),
  ('Grave of John Hull Campbell', 'Grave of George Lippard'),
  ('Grave of Harriet Judd Sartain', 'Grave of George Lippard'),
  ('Grave of Paul Castellano', 'Grave of Cornelius Vanderbilt')
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
-- UNDO (do not run unless reversing #492b). Retires back to approved; moves back
-- to their old coordinate (and Karski's city — set it to what Block 1 showed).
-- ===========================================================================
-- update public.submissions set status = 'approved'
--  where review_note like '%#492b 2026-10-06: retired%' and merged_into is null;
--
-- update public.submissions s set lat = v.lat, lng = v.lng
--   from (values
--     ('Grave of Jan Karski', 40.3748, -74.0815),
--     ('Grave of William Henry Harrison Hart', 38.9196823990383, -76.9928917850834),
--     ('Grave of Thomas Birch Florence', 39.981, -75.153),
--     ('Grave of John Hull Campbell', 39.981, -75.153),
--     ('Grave of Harriet Judd Sartain', 39.9813176009617, -75.1525855166991),
--     ('Grave of Paul Castellano', 40.7132269325875, -74.006111111)
--   ) as v(name, lat, lng)
--  where s.name = v.name and s.review_note like '%#492b 2026-10-06: moved%' and s.merged_into is null;
