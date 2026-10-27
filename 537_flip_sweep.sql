-- 537_flip_sweep.sql — #537 sweep, READ-ONLY (no writes; safe to run any time).
--
-- WHAT IT LOOKS FOR: the seed-resolve #429 flip that #532 part 4b-1 hit — a `new`
-- story line judged "already committed" against a DIFFERENTLY named seed through
-- Gemini's canonicalName, so its story PATCHed that seed's resolved_description.
--
-- THE SIGNATURE: a seed that was itself planted by a story line (its description
-- is a story with a matching curated_descriptions row under its own name) whose
-- SERVED story (resolved_description) is now different text.
--
-- READING THE RESULT:
--   0 rows                         → no earlier flip survives. #537's sweep is clean.
--   served_story_curated_as NULL   → LIKELY A FLIP: the served text was never staged
--                                    as a curated row (the #429 path stages none).
--                                    Restore = set resolved_description back to
--                                    description, as 532_courthouse_restore.sql did.
--   served_story_curated_as named  → probably a legitimate #419 attach (a later line
--                                    that really is this place); eyeball both texts.
-- The 4b-1 courthouse case was already restored, so it should NOT appear.

with story_seeds as (
  select s.city, s.name, s.lat, s.lng, s.description, s.resolved_description
  from public.submissions s
  where s.submitted_by is null
    and s.status = 'approved'
    and s.merged_into is null
    and s.resolved_source = 'curated'
    and s.description is not null
    and s.resolved_description is not null
    and btrim(s.description) <> btrim(s.resolved_description)
    and exists (
      select 1 from public.curated_descriptions c
      where c.name_clean = lower(regexp_replace(s.name, '[^A-Za-z0-9]', '', 'g'))
        and btrim(c.description) = btrim(s.description)
    )
)
select
  ss.city,
  ss.name,
  round(ss.lat::numeric, 6) as lat,
  round(ss.lng::numeric, 6) as lng,
  left(ss.description, 70)          as own_story,
  left(ss.resolved_description, 70) as served_story,
  (select string_agg(distinct c.name, ' / ')
     from public.curated_descriptions c
    where btrim(c.description) = btrim(ss.resolved_description)) as served_story_curated_as
from story_seeds ss
order by ss.city, ss.name;
