-- 508_klondike_story.sql — #508: the Seattle seed gem "Klondike Gold Rush
-- National Historical Park" shows a story about Zeitgeist Coffee. Supabase SQL
-- editor (runs as postgres). Nothing outside this file: no function, no Pages,
-- no CACHE_VERSION, no env var.
--
-- WHAT IS WRONG (read 2026-10-04 with the public key): the uncredited seed gem
-- at (47.599381, -122.331864), created 2026-08-21, carries
--   resolved_source      = 'wiki'
--   resolved_description = "Zeitgeist Coffee is a coffeehouse in Seattle's
--                           Pioneer Square neighborhood, …"
--   description          = the same Zeitgeist Coffee text
-- — a neighbour's Wikipedia article. A curated story for the park exists in
-- curated_descriptions, but #419's attach-to-existing-seed never ran on this
-- gem. The pin sheet shows resolved_description first (#344 brick 5), so this
-- is the text people read.
--
-- WHAT THIS DOES: copies the curated row's description onto the gem's
-- resolved_description AND description, and sets resolved_source = 'curated'
-- — the #419 attach, plus description so the wrong text is gone from the row
-- entirely (a seed with no stored line falls back to description). The old
-- text is recorded in review_note, so it is reversible (UNDO at the bottom).
--
-- GUARDS (handoff §5, the disposition-SQL rule): the gem is matched on its OWN
-- stored name and coordinate (no pasted UUID), live and uncredited; the curated
-- row on name_clean within 2 km. A DO pre-check raises — and the editor's one
-- implicit transaction then changes NOTHING — unless exactly one gem and
-- exactly one curated row match, and the gem is not already 'curated'. A second
-- run aborts on that last check. No begin/commit (handoff §5, #10).
--
-- HOW TO RUN: paste the whole file into one SQL-editor tab and Run. The grid
-- you see is the final SELECT:
--   row "1 · #508 fixed"   — the gem, now resolved_source 'curated', stored =
--                            the curated story (not Zeitgeist Coffee).
--   rows "2 · same pattern" — OTHER live seed gems that have a curated story
--                            within 1 km but do not carry it. Read-only — listed
--                            for the next pass, not changed here.


do $$
declare
  n_gem  int;
  n_cur  int;
  src    text;
begin
  select count(*), max(s.resolved_source) into n_gem, src
    from public.submissions s
   where s.name = 'Klondike Gold Rush National Historical Park'
     and abs(s.lat - 47.599381)    < 0.000001
     and abs(s.lng - (-122.331864)) < 0.000001
     and s.status = 'approved' and s.merged_into is null and s.submitted_by is null;
  if n_gem <> 1 then
    raise exception '#508 pre-check: expected exactly 1 live uncredited Klondike gem at its stored coordinate, found % — nothing changed', n_gem;
  end if;
  if src = 'curated' then
    raise exception '#508 pre-check: the gem already carries resolved_source = curated — already fixed, nothing changed';
  end if;

  select count(*) into n_cur
    from public.curated_descriptions c
   where c.name_clean = 'klondikegoldrushnationalhistoricalpark'
     and 111320 * sqrt(power(c.lat - 47.599381, 2) +
                       power((c.lng - (-122.331864)) * cos(radians(47.599381)), 2)) < 2000;
  if n_cur <> 1 then
    raise exception '#508 pre-check: expected exactly 1 curated story for the park within 2 km, found % — nothing changed', n_cur;
  end if;
end $$;

update public.submissions s
   set resolved_description = c.description,
       description          = c.description,
       resolved_source      = 'curated',
       review_note          = concat_ws(' | ', s.review_note,
         '#508 2026-10-04: curated story attached (was resolved_source=' || coalesce(s.resolved_source, 'null') ||
         ', a wrong Wikipedia attach). Old text: ' || coalesce(s.resolved_description, ''))
  from public.curated_descriptions c
 where s.name = 'Klondike Gold Rush National Historical Park'
   and abs(s.lat - 47.599381)    < 0.000001
   and abs(s.lng - (-122.331864)) < 0.000001
   and s.status = 'approved' and s.merged_into is null and s.submitted_by is null
   and c.name_clean = 'klondikegoldrushnationalhistoricalpark'
   and 111320 * sqrt(power(c.lat - 47.599381, 2) +
                     power((c.lng - (-122.331864)) * cos(radians(47.599381)), 2)) < 2000;

-- THE CHECK — the grid on screen.
with pairs as (
  select s.name, s.resolved_source, s.resolved_description, c.description as curated,
         (s.name = 'Klondike Gold Rush National Historical Park'
          and abs(s.lat - 47.599381) < 0.000001 and abs(s.lng - (-122.331864)) < 0.000001) as is_target,
         round((111320 * sqrt(power(c.lat - s.lat, 2) +
                              power((c.lng - s.lng) * cos(radians(s.lat)), 2)))::numeric) as dist_m
    from public.submissions s
    join public.curated_descriptions c
      on c.name_clean = regexp_replace(lower(s.name), '[^a-z0-9]', '', 'g')
   where s.status = 'approved' and s.merged_into is null and s.submitted_by is null
     and 111320 * sqrt(power(c.lat - s.lat, 2) +
                       power((c.lng - s.lng) * cos(radians(s.lat)), 2)) < 1000
)
select case when is_target then '1 · #508 fixed'
            else '2 · same pattern — check' end              as "row",
       name,
       resolved_source,
       left(resolved_description, 90)                        as stored_story,
       left(curated, 90)                                     as curated_story,
       dist_m
  from pairs
 where is_target
    or coalesce(resolved_source, '') <> 'curated'
 order by 1, name;


-- ===========================================================================
-- UNDO (do not run unless reversing #508): put the old text back. The old
-- resolved_description is in review_note after "Old text: ".
-- ===========================================================================
-- update public.submissions
--    set resolved_source      = 'wiki',
--        resolved_description = split_part(review_note, 'Old text: ', 2),
--        description          = split_part(review_note, 'Old text: ', 2)
--  where name = 'Klondike Gold Rush National Historical Park'
--    and abs(lat - 47.599381) < 0.000001 and abs(lng - (-122.331864)) < 0.000001
--    and status = 'approved' and merged_into is null and submitted_by is null;
