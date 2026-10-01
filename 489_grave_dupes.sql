-- 489_grave_dupes.sql — #489: the "duplicate grave pins" and the Massachusetts
-- Spessard Holland pin. Supabase SQL editor (runs as postgres). Nothing outside
-- this file: no function, no Pages, no CACHE_VERSION, no env var.
--
-- WHAT THE PASS FOUND (2026-10-01, before writing anything):
--   The 19 same-cemetery "duplicates" are NOT on the map. Each label's second
--   row is ALREADY MERGED (status 'approved', merged_into set) — folded by an
--   earlier cleanup. Every map read filters merged_into IS NULL: the app's
--   gemBaseQuery, search_pin_names (#475) and app-report's pin_audit. A public
--   read with the app's own filter returns 4,872 live "Grave of …" pins and
--   only 6 repeated labels, all far-apart namesakes (Al Smith, James Logan,
--   John Barry, John Davenport, William Elliott, William Ryan). The row's count
--   of 4,893 / 27 included the 21 merged rows (the 19 + the merged copies of
--   Lorenzo Da Ponte and Thomas Birch Florence). So pin_audit.exact_name = 0
--   was RIGHT; the measuring read was wrong (it did not filter merged_into).
--
--   What IS wrong: the one live "Grave of Spessard Holland" pin sits in
--   Wildwood Cemetery, WINCHESTER, MASSACHUSETTS (42.454722, -71.146667).
--   Holland (1892–1971, Florida governor and senator) is buried in Wildwood
--   Cemetery, BARTOW, FLORIDA (Wikipedia infobox resting_place). Wikidata's
--   P119 evidently points at the wrong same-named cemetery. Bartow is in no
--   roster metro, so the pin is retired, not moved. Its four neighbours in
--   the Winchester cemetery (Leon Tuck, Elizabeth Shepley Sergeant, Dudley
--   Murphy, Samuel Walker McCall) are Massachusetts people — left alone.
--
-- HOW TO RUN: one block at a time, each in its own SQL-editor tab, in order.
--   Block 1 — read only.        Block 2 — the one change (a transaction).
--   Block 3 — read only, the check after Block 2.
-- Block 2 is guarded (handoff §5's disposition pattern): it matches the pin by
-- name + its own stored coordinate (no pasted UUID), aborts the WHOLE run
-- unless exactly one live row matches, and ends with a result table. A second
-- run aborts on the pre-check and changes nothing.


-- ===========================================================================
-- BLOCK 1 — READ ONLY. Every "Grave of …" label held by 2+ rows (rejected rows
-- ignored), with live vs merged counts. EXPECT: only 6 rows with live = 2
-- (the far namesakes, nearest_live_km in the hundreds or thousands); every
-- other row live = 1, merged >= 1. Spessard Holland shows live 1, merged 1.
-- ===========================================================================
with g as (
  select lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) as label,
         id, name, lat, lng, status, merged_into, created_at, source
    from public.submissions
   where name ilike 'Grave of %'
     and status <> 'rejected'
)
select min(name)                                         as label,
       count(*)                                          as rows,
       count(*) filter (where merged_into is null)       as live,
       count(*) filter (where merged_into is not null)   as merged,
       (select round(min(
                 2 * 6371 * asin(sqrt(
                   power(sin(radians(b.lat - a.lat) / 2), 2) +
                   cos(radians(a.lat)) * cos(radians(b.lat)) *
                   power(sin(radians(b.lng - a.lng) / 2), 2))))::numeric, 2)
          from g a join g b on a.label = b.label and a.id < b.id
         where a.label = g.label
           and a.merged_into is null and b.merged_into is null) as nearest_live_km,
       string_agg(distinct source, ', ')                 as sources
  from g
 group by label
having count(*) > 1
 order by live desc, label;


-- ===========================================================================
-- BLOCK 2 — THE CHANGE. Retire the Winchester, MA "Grave of Spessard Holland"
-- pin (status 'rejected'; row, name and bio kept — reversible). The
-- submissions_propagate_merged_status trigger carries the status to its
-- merged copy, so both rows end up 'rejected'.
-- ===========================================================================
begin;

create temp table t489 (name text, lat double precision, lng double precision) on commit drop;
insert into t489 values ('Grave of Spessard Holland', 42.454722, -71.146667);

do $$
declare n int;
begin
  select count(*) into n
    from public.submissions s join t489 t
      on s.name = t.name
     and abs(s.lat - t.lat) < 0.000001
     and abs(s.lng - t.lng) < 0.000001
   where s.status = 'approved' and s.merged_into is null;
  if n <> 1 then
    raise exception '#489 pre-check: expected exactly 1 live pin, found % — nothing changed', n;
  end if;
end $$;

update public.submissions s
   set status      = 'rejected',
       reviewed_at = now(),
       review_note = concat_ws(' | ', s.review_note,
         '#489 2026-10-01: retired — pin is Wildwood Cemetery, Winchester MA; '
         'Spessard Holland is buried in Wildwood Cemetery, Bartow FL (wrong same-named '
         'cemetery from Wikidata P119). Bartow is in no roster metro.')
  from t489 t
 where s.name = t.name
   and abs(s.lat - t.lat) < 0.000001
   and abs(s.lng - t.lng) < 0.000001
   and s.status = 'approved' and s.merged_into is null;

select id, name, lat, lng, status, merged_into, left(review_note, 60) as note
  from public.submissions
 where name = 'Grave of Spessard Holland'
 order by merged_into nulls first;

commit;


-- ===========================================================================
-- BLOCK 3 — READ ONLY, after Block 2. EXPECT: live_grave_pins one fewer than
-- before Block 2 (4,871 if nothing else changed), holland_live = 0,
-- holland_rejected = 2, same_label_within_40km = 0.
-- ===========================================================================
with live as (
  select lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) as label, id, lat, lng
    from public.submissions
   where name ilike 'Grave of %' and status = 'approved' and merged_into is null
)
select (select count(*) from live) as live_grave_pins,
       (select count(*) from public.submissions
         where name = 'Grave of Spessard Holland'
           and status = 'approved' and merged_into is null) as holland_live,
       (select count(*) from public.submissions
         where name = 'Grave of Spessard Holland' and status = 'rejected') as holland_rejected,
       (select count(*) from live a join live b on a.label = b.label and a.id < b.id
         where 2 * 6371 * asin(sqrt(
                 power(sin(radians(b.lat - a.lat) / 2), 2) +
                 cos(radians(a.lat)) * cos(radians(b.lat)) *
                 power(sin(radians(b.lng - a.lng) / 2), 2))) < 40) as same_label_within_40km;


-- ===========================================================================
-- UNDO (do not run unless reversing #489): put the pin back. The trigger
-- restores its merged copy's status too.
-- ===========================================================================
-- update public.submissions
--    set status = 'approved'
--  where name = 'Grave of Spessard Holland'
--    and merged_into is null
--    and abs(lat - 42.454722) < 0.000001 and abs(lng - (-71.146667)) < 0.000001;
